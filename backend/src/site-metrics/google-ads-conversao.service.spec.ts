import { GoogleAdsConversaoService } from './google-ads-conversao.service';

/**
 * Testes do caminho que devolve a venda pro Google.
 *
 * Tudo aqui quebra EM SILÊNCIO — é esse o tema. A API responde HTTP 200 mesmo
 * recusando o lote inteiro, então nenhum destes defeitos apareceria como erro:
 * ação de tipo errado, carimbo de data fora do formato, recusa definitiva
 * voltando pra fila pra sempre, e filtro de status que não casa com o enum real
 * do pedido.
 */
const env = (vals: Record<string, string | undefined>) =>
  ({ get: (k: string) => vals[k] }) as any;

const CREDENCIAIS = {
  GOOGLE_ADS_CONTAS: '8925231246',
  // Ação do tipo UPLOAD_CLICKS — NUNCA a do gtag.
  GOOGLE_ADS_CONVERSAO_ACTION_ID: '9999888877',
};

/** Fake do GoogleAdsService: 1ª chamada = check de tipo, 2ª = upload. */
const adsFake = (upload: any, tipo = 'UPLOAD_CLICKS') => {
  const requisitar = jest.fn().mockImplementation((caminho: string) => {
    if (caminho.includes('searchStream')) {
      return Promise.resolve([{ results: [{ conversionAction: { id: '9999888877', type: tipo } }] }]);
    }
    return Promise.resolve(upload);
  });
  return { configurado: () => true, requisitar };
};

const pedido = (id: string, numero: string) => ({
  id,
  wcOrderNumber: numero,
  gclid: `gclid-${id}`,
  totalAmount: 210.5,
  paidAt: new Date('2026-08-22T22:30:00.000Z'),
  adsConversaoTentativas: 0,
});

const prismaFake = (pedidos: any[]) => {
  const updateMany = jest.fn().mockResolvedValue({ count: pedidos.length });
  const update = jest.fn().mockResolvedValue({});
  const findMany = jest.fn().mockResolvedValue(pedidos);
  return { prisma: { order: { findMany, updateMany, update } } as any, findMany, updateMany, update };
};

describe('GoogleAdsConversaoService', () => {
  describe('configurado', () => {
    it('não roda sem o id da ação — subir pra ação errada não tem desfazer', () => {
      const svc = new GoogleAdsConversaoService(
        {} as any,
        env({ GOOGLE_ADS_CONTAS: '8925231246' }),
        adsFake({}) as any,
      );
      expect(svc.configurado()).toBe(false);
    });

    it('respeita o kill-switch', () => {
      const svc = new GoogleAdsConversaoService(
        {} as any,
        env({ ...CREDENCIAIS, GOOGLE_ADS_CONVERSAO_UPLOAD: '0' }),
        adsFake({}) as any,
      );
      expect(svc.configurado()).toBe(false);
    });
  });

  /**
   * 🚨 O DEFEITO MAIS CARO QUE ESTE ARQUIVO PREVINE.
   *
   * `uploadClickConversions` exige `type=UPLOAD_CLICKS`. Ação nascida de tag do
   * site é `WEBPAGE` e recusa 100% do lote, sempre — respondendo HTTP 200 com
   * `results` cheio de objetos vazios. De fora, cron saudável.
   */
  describe('guarda do tipo da ação', () => {
    it('NÃO sobe nada quando a ação é do gtag (WEBPAGE)', async () => {
      const { prisma, findMany } = prismaFake([pedido('a', 'LP-1')]);
      const ads = adsFake({}, 'WEBPAGE');
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), ads as any);

      const r = await svc.enviarPendentes();

      expect(r.enviadas).toBe(0);
      expect(r.erro).toMatch(/ação de conversão inválida/);
      expect(findMany).not.toHaveBeenCalled();
      expect(ads.requisitar.mock.calls.some((c: any[]) => c[0].includes('uploadClickConversions'))).toBe(false);
    });

    it('confere o tipo UMA vez só, não a cada ciclo', async () => {
      const { prisma } = prismaFake([]);
      const ads = adsFake({ results: [] });
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), ads as any);

      await svc.enviarPendentes();
      await svc.enviarPendentes();

      const checks = ads.requisitar.mock.calls.filter((c: any[]) => c[0].includes('searchStream'));
      expect(checks).toHaveLength(1);
    });
  });

  describe('quem entra na fila', () => {
    /**
     * O enum real (`common/enums.ts`) NÃO tem 'paid' nem 'completed'. Pedido
     * pago vira 'processing', e só depois de um humano rotear é que chega em
     * 'separating'. Filtrar por status deixaria de fora justamente o
     * recém-pago — que é todo mundo que importa.
     */
    it('filtra por PROVA DE PAGAMENTO, não por lista de status', async () => {
      const { prisma, findMany } = prismaFake([]);
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), adsFake({}) as any);

      await svc.enviarPendentes();

      const where = findMany.mock.calls[0][0].where;
      expect(where.paidAt.not).toBeNull();
      expect(where.status.notIn).toEqual(['cancelled', 'failed']);
      expect(JSON.stringify(where)).not.toContain('"paid"');
      expect(JSON.stringify(where)).not.toContain('completed');
    });

    /** O Google recusa clique com menos de 6h (TOO_RECENT_EVENT). */
    it('segura a venda por 6h antes de tentar subir', async () => {
      const { prisma, findMany } = prismaFake([]);
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), adsFake({}) as any);

      await svc.enviarPendentes();

      const lte = findMany.mock.calls[0][0].where.paidAt.lte as Date;
      const idade = Date.now() - lte.getTime();
      expect(idade).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000 - 5000);
    });

    it('não reapresenta quem já estourou as tentativas', async () => {
      const { prisma, findMany } = prismaFake([]);
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), adsFake({}) as any);

      await svc.enviarPendentes();

      expect(findMany.mock.calls[0][0].where.adsConversaoTentativas).toEqual({ lt: 5 });
    });
  });

  describe('envio', () => {
    it('manda no formato da API, com orderId pra deduplicar', async () => {
      const { prisma } = prismaFake([pedido('a', 'LP-1')]);
      const ads = adsFake({ results: [{ orderId: 'LP-1' }] });
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), ads as any);

      const r = await svc.enviarPendentes();

      expect(r.enviadas).toBe(1);
      const upload = ads.requisitar.mock.calls.find((c: any[]) =>
        c[0].includes('uploadClickConversions'),
      );
      expect(upload[0]).toBe('customers/8925231246:uploadClickConversions');
      expect(upload[1].partialFailure).toBe(true);
      expect(upload[1].validateOnly).toBeUndefined();
      expect(upload[1].conversions[0]).toEqual({
        gclid: 'gclid-a',
        conversionAction: 'customers/8925231246/conversionActions/9999888877',
        // ESPAÇO, não 'T'. E fuso explícito.
        conversionDateTime: '2026-08-22 19:30:00-03:00',
        conversionValue: 210.5,
        currencyCode: 'BRL',
        orderId: 'LP-1',
      });
    });

    it('vira o dia pelo fuso da loja, não por UTC', () => {
      const svc = new GoogleAdsConversaoService({} as any, env(CREDENCIAIS), adsFake({}) as any);
      const texto = (svc as any).momento(new Date('2026-08-23T02:30:00.000Z'));
      expect(texto.startsWith('2026-08-22 23:30:00')).toBe(true);
    });

    /** Com validateOnly o Google devolve `results` vazio DE PROPÓSITO. */
    it('no modo validar não carimba nada e não confunde results vazio com falha', async () => {
      const { prisma, updateMany, update } = prismaFake([pedido('a', 'LP-1')]);
      const ads = adsFake({ results: [] });
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), ads as any);

      const r = await svc.enviarPendentes(200, true);

      expect(r.validado).toBe(1);
      expect(r.recusadas).toBe(0);
      expect(updateMany).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      const upload = ads.requisitar.mock.calls.find((c: any[]) =>
        c[0].includes('uploadClickConversions'),
      );
      expect(upload[1].validateOnly).toBe(true);
    });
  });

  describe('recusa', () => {
    const comErro = (indice: number, codigo: string) => ({
      results: [{ orderId: 'LP-1' }, {}],
      partialFailureError: {
        details: [
          {
            errors: [
              {
                errorCode: { conversionUploadError: codigo },
                message: 'motivo do google',
                location: { fieldPathElements: [{ fieldName: 'conversions', index: indice }] },
              },
            ],
          },
        ],
      },
    });

    it('carimba só as aceitas e guarda o motivo da recusada', async () => {
      const { prisma, updateMany, update } = prismaFake([pedido('a', 'LP-1'), pedido('b', 'LP-2')]);
      const svc = new GoogleAdsConversaoService(
        prisma,
        env(CREDENCIAIS),
        adsFake(comErro(1, 'TOO_RECENT_EVENT')) as any,
      );

      const r = await svc.enviarPendentes();

      expect(r).toMatchObject({ enviadas: 1, recusadas: 1 });
      expect(updateMany.mock.calls[0][0].where.id.in).toEqual(['a']);
      expect(update.mock.calls[0][0].where.id).toBe('b');
      expect(update.mock.calls[0][0].data.adsConversaoErro).toContain('TOO_RECENT_EVENT');
    });

    /** Erro que se resolve sozinho conta +1 e volta na próxima. */
    it('recusa temporária incrementa a tentativa', async () => {
      const { prisma, update } = prismaFake([pedido('a', 'LP-1'), pedido('b', 'LP-2')]);
      const svc = new GoogleAdsConversaoService(
        prisma,
        env(CREDENCIAIS),
        adsFake(comErro(1, 'TOO_RECENT_EVENT')) as any,
      );

      await svc.enviarPendentes();

      expect(update.mock.calls[0][0].data.adsConversaoTentativas).toEqual({ increment: 1 });
    });

    /**
     * Recusa DEFINITIVA sai da fila na hora. Sem isso ela volta de hora em
     * hora pra sempre, entope o lote (a venda nova nunca sobe) e queima a cota
     * diária do token — que é compartilhada com o espelho de gasto, então
     * derrubaria a tela de ROAS junto.
     */
    it('recusa definitiva sai da fila na hora, sem gastar as 5 tentativas', async () => {
      const { prisma, update } = prismaFake([pedido('a', 'LP-1'), pedido('b', 'LP-2')]);
      const svc = new GoogleAdsConversaoService(
        prisma,
        env(CREDENCIAIS),
        adsFake(comErro(1, 'EXPIRED_EVENT')) as any,
      );

      await svc.enviarPendentes();

      expect(update.mock.calls[0][0].data.adsConversaoTentativas).toBe(5);
    });

    it('sem detalhe de índice, ainda registra a recusa em vez de carimbar como enviada', async () => {
      const { prisma, updateMany, update } = prismaFake([pedido('a', 'LP-1')]);
      const svc = new GoogleAdsConversaoService(
        prisma,
        env(CREDENCIAIS),
        adsFake({ results: [{}], partialFailureError: {} }) as any,
      );

      const r = await svc.enviarPendentes();

      expect(r).toMatchObject({ enviadas: 0, recusadas: 1 });
      expect(updateMany).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledTimes(1);
    });
  });
});
