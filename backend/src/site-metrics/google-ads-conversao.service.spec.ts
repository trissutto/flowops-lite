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

/**
 * Fake do GoogleAdsService.
 *
 * São DOIS transportes de propósito: o check do tipo da ação ainda é Google Ads
 * API (`requisitar`), e o envio da conversão é Data Manager
 * (`requisitarDataManager`) — desde 15/06/2026 o `uploadClickConversions` recusa
 * integração nova. Se um teste chamar o transporte errado, o outro mock nem é
 * tocado e a falha aparece.
 */
const adsFake = (envio: any, tipo = 'UPLOAD_CLICKS') => {
  const requisitar = jest.fn().mockImplementation((caminho: string) => {
    if (caminho.includes('searchStream')) {
      return Promise.resolve([{ results: [{ conversionAction: { id: '9999888877', type: tipo } }] }]);
    }
    return Promise.reject(new Error(`caminho inesperado no Ads API: ${caminho}`));
  });
  const requisitarDataManager = jest
    .fn()
    .mockImplementation(() =>
      envio instanceof Error ? Promise.reject(envio) : Promise.resolve(envio),
    );
  return { configurado: () => true, requisitar, requisitarDataManager };
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
    it('manda no formato da Data Manager, com transactionId pra deduplicar', async () => {
      const { prisma } = prismaFake([pedido('a', 'LP-1')]);
      const ads = adsFake({ requestId: 'req-1' });
      const svc = new GoogleAdsConversaoService(
        prisma,
        env({ ...CREDENCIAIS, GOOGLE_ADS_LOGIN_CUSTOMER_ID: '178-496-3045' }),
        ads as any,
      );

      const r = await svc.enviarPendentes();

      expect(r.enviadas).toBe(1);
      // O envio NÃO passa mais pelo Ads API — só o check do tipo da ação passa.
      expect(ads.requisitar.mock.calls.every((c: any[]) => c[0].includes('searchStream'))).toBe(
        true,
      );

      const [caminho, corpo] = ads.requisitarDataManager.mock.calls[0];
      expect(caminho).toBe('events:ingest');
      expect(corpo.validateOnly).toBeUndefined();
      // O destino carrega conta + ação; o MCC vai só como loginAccount, sem hífen.
      expect(corpo.destinations[0]).toEqual({
        operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '8925231246' },
        productDestinationId: '9999888877',
        loginAccount: { accountType: 'GOOGLE_ADS', accountId: '1784963045' },
      });
      expect(corpo.events[0]).toEqual({
        adIdentifiers: { gclid: 'gclid-a' },
        // 'T', não espaço — o contrário do caminho antigo. E fuso explícito.
        eventTimestamp: '2026-08-22T19:30:00-03:00',
        conversionValue: 210.5,
        currency: 'BRL',
        eventSource: 'WEB',
        transactionId: 'LP-1',
      });
    });

    /** Sem MCC configurado o campo não vai — mandar vazio é erro de permissão. */
    it('omite loginAccount quando não há MCC', async () => {
      const { prisma } = prismaFake([pedido('a', 'LP-1')]);
      const ads = adsFake({ requestId: 'req-1' });
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), ads as any);

      await svc.enviarPendentes();

      expect(ads.requisitarDataManager.mock.calls[0][1].destinations[0].loginAccount).toBeUndefined();
    });

    it('vira o dia pelo fuso da loja, não por UTC', () => {
      const svc = new GoogleAdsConversaoService({} as any, env(CREDENCIAIS), adsFake({}) as any);
      const texto = (svc as any).momentoRfc3339(new Date('2026-08-23T02:30:00.000Z'));
      expect(texto.startsWith('2026-08-22T23:30:00')).toBe(true);
    });

    it('no modo validar não carimba nada', async () => {
      const { prisma, updateMany, update } = prismaFake([pedido('a', 'LP-1')]);
      const ads = adsFake({ requestId: 'req-1' });
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), ads as any);

      const r = await svc.enviarPendentes(200, true);

      expect(r.validado).toBe(1);
      expect(r.recusadas).toBe(0);
      expect(updateMany).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(ads.requisitarDataManager.mock.calls[0][1].validateOnly).toBe(true);
    });
  });

  /**
   * A Data Manager é TUDO OU NADA: `IngestEventsResponse` traz só `requestId` e
   * `fieldWarnings`, sem resultado por evento. Não existe mais "carimba a
   * aceita e devolve a recusada pra fila" — ou o lote entra, ou nada entra.
   */
  describe('recusa', () => {
    it('requisição que falha não carimba NENHUM pedido como enviado', async () => {
      const { prisma, updateMany, update } = prismaFake([pedido('a', 'LP-1'), pedido('b', 'LP-2')]);
      const svc = new GoogleAdsConversaoService(
        prisma,
        env(CREDENCIAIS),
        adsFake(new Error('DataManager 403: CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE')) as any,
      );

      await expect(svc.enviarPendentes()).rejects.toThrow('CUSTOMER_NOT_ALLOWLISTED');
      expect(updateMany).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    /**
     * Aviso de campo NÃO é recusa: o lote entrou. Tratar aviso como falha
     * devolveria pra fila uma conversão que o Google já contou, e o
     * `transactionId` faria o Google deduplicar em silêncio — a venda pareceria
     * eternamente pendente.
     */
    it('aviso de campo não impede o carimbo — o lote entrou', async () => {
      const { prisma, updateMany } = prismaFake([pedido('a', 'LP-1')]);
      const ads = adsFake({
        requestId: 'req-1',
        fieldWarnings: [{ fieldPath: 'events[0].userData', warning: 'sem dado de usuário' }],
      });
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), ads as any);

      const r = await svc.enviarPendentes();

      expect(r).toMatchObject({ enviadas: 1, recusadas: 0 });
      expect(updateMany.mock.calls[0][0].where.id.in).toEqual(['a']);
    });

    it('carimba o lote inteiro de uma vez, sem update pedido a pedido', async () => {
      const { prisma, updateMany, update } = prismaFake([pedido('a', 'LP-1'), pedido('b', 'LP-2')]);
      const svc = new GoogleAdsConversaoService(
        prisma,
        env(CREDENCIAIS),
        adsFake({ requestId: 'req-1' }) as any,
      );

      const r = await svc.enviarPendentes();

      expect(r).toMatchObject({ enviadas: 2, recusadas: 0 });
      expect(updateMany.mock.calls[0][0].where.id.in).toEqual(['a', 'b']);
      expect(update).not.toHaveBeenCalled();
    });
  });
});
