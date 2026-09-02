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
/** O canal do alarme de silêncio. Guarda o que sairia, não envia nada. */
const whatsFake = () => ({ sendText: jest.fn(async () => ({ ok: true })) });

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
        whatsFake() as any,
      );
      expect(svc.configurado()).toBe(false);
    });

    it('respeita o kill-switch', () => {
      const svc = new GoogleAdsConversaoService(
        {} as any,
        env({ ...CREDENCIAIS, GOOGLE_ADS_CONVERSAO_UPLOAD: '0' }),
        adsFake({}) as any,
        whatsFake() as any,
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
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), ads as any, whatsFake() as any);

      const r = await svc.enviarPendentes();

      expect(r.enviadas).toBe(0);
      expect(r.erro).toMatch(/ação de conversão inválida/);
      expect(findMany).not.toHaveBeenCalled();
      expect(ads.requisitar.mock.calls.some((c: any[]) => c[0].includes('uploadClickConversions'))).toBe(false);
    });

    it('confere o tipo UMA vez só, não a cada ciclo', async () => {
      const { prisma } = prismaFake([]);
      const ads = adsFake({ results: [] });
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), ads as any, whatsFake() as any);

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
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), adsFake({}) as any, whatsFake() as any);

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
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), adsFake({}) as any, whatsFake() as any);

      await svc.enviarPendentes();

      const lte = findMany.mock.calls[0][0].where.paidAt.lte as Date;
      const idade = Date.now() - lte.getTime();
      expect(idade).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000 - 5000);
    });

    it('não reapresenta quem já estourou as tentativas', async () => {
      const { prisma, findMany } = prismaFake([]);
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), adsFake({}) as any, whatsFake() as any);

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
        whatsFake() as any,
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
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), ads as any, whatsFake() as any);

      await svc.enviarPendentes();

      expect(ads.requisitarDataManager.mock.calls[0][1].destinations[0].loginAccount).toBeUndefined();
    });

    it('vira o dia pelo fuso da loja, não por UTC', () => {
      const svc = new GoogleAdsConversaoService({} as any, env(CREDENCIAIS), adsFake({}) as any, whatsFake() as any);
      const texto = (svc as any).momentoRfc3339(new Date('2026-08-23T02:30:00.000Z'));
      expect(texto.startsWith('2026-08-22T23:30:00')).toBe(true);
    });

    it('no modo validar não carimba nada', async () => {
      const { prisma, updateMany, update } = prismaFake([pedido('a', 'LP-1')]);
      const ads = adsFake({ requestId: 'req-1' });
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), ads as any, whatsFake() as any);

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
        whatsFake() as any,
      );

      await expect(svc.enviarPendentes()).rejects.toThrow('CUSTOMER_NOT_ALLOWLISTED');

      // Nenhum pedido vira "enviado" — esta é a garantia que importa.
      expect(
        updateMany.mock.calls.some((c: any[]) => 'adsConversaoEnviadaEm' in (c[0]?.data ?? {})),
      ).toBe(false);
      expect(update).not.toHaveBeenCalled();

      // Desde 02/09 a falha DEIXA RASTRO (antes escrevia nada e o teto de
      // tentativas era código morto): conta a tentativa e grava o motivo.
      const rastro = updateMany.mock.calls.find((c: any[]) => c[0]?.data?.adsConversaoTentativas);
      expect(rastro[0].where.id.in).toEqual(['a', 'b']);
      expect(rastro[0].data.adsConversaoErro).toMatch(/CUSTOMER_NOT_ALLOWLISTED/);
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
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), ads as any, whatsFake() as any);

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
        whatsFake() as any,
      );

      const r = await svc.enviarPendentes();

      expect(r).toMatchObject({ enviadas: 2, recusadas: 0 });
      expect(updateMany.mock.calls[0][0].where.id.in).toEqual(['a', 'b']);
      expect(update).not.toHaveBeenCalled();
    });
  });

  /**
   * O ALARME DE SILÊNCIO.
   *
   * A quebra de 19/08/2026 durou 10 dias porque nada avisa quando a medição
   * para: o gasto continua saindo, o status da ação continua "Ativa" e o total
   * do período continua grande (é histórico). Estes testes fixam as três
   * perguntas que denunciam — e, principalmente, fixam quando ele deve FICAR
   * CALADO: alarme que grita à toa treina todo mundo a ignorá-lo.
   */
  describe('alarme de silêncio', () => {
    /**
     * `apagadas` = linhas do cheque 5 (campanha que CONVERTIA e parou). Desde
     * 02/09/2026 são DUAS consultas cruas, nesta ordem: gasto de ontem, depois
     * apagão — por isso o fake responde por posição, e não um valor só pra tudo.
     */
    const prismaDiag = (contagens: number[], gastoOntem = 0, apagadas: any[] = []) => {
      const count = jest.fn();
      contagens.forEach((n) => count.mockResolvedValueOnce(n));
      const $queryRawUnsafe = jest
        .fn()
        .mockResolvedValueOnce([{ gasto: gastoOntem }])
        .mockResolvedValueOnce(apagadas);
      return { order: { count }, $queryRawUnsafe } as any;
    };
    // A ordem das contagens é a das chamadas: aceitas, naFila, googleComGclid, googleTotal.
    const svcCom = (prisma: any) =>
      new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), adsFake({}) as any, whatsFake() as any);

    it('cala a boca quando a fila anda', async () => {
      const problemas = await svcCom(prismaDiag([4, 2, 3, 3])).diagnosticarSilencio();
      expect(problemas).toEqual([]);
    });

    it('cala a boca quando não há nada na fila (dia fraco não é defeito)', async () => {
      const problemas = await svcCom(prismaDiag([0, 0, 0, 0])).diagnosticarSilencio();
      expect(problemas).toEqual([]);
    });

    it('grita quando tem venda esperando e nada foi aceito em 24h', async () => {
      const problemas = await svcCom(prismaDiag([0, 7, 2, 2])).diagnosticarSilencio();
      expect(problemas.join(' ')).toMatch(/7 venda\(s\) esperando/);
    });

    it('grita quando o gclid some do checkout', async () => {
      const problemas = await svcCom(prismaDiag([3, 0, 0, 5])).diagnosticarSilencio();
      expect(problemas.join(' ')).toMatch(/nenhuma trouxe gclid/);
    });

    it('grita quando gastou ontem e ninguém chegou marcado como Google', async () => {
      const problemas = await svcCom(prismaDiag([0, 0, 0, 0], 640.12)).diagnosticarSilencio();
      expect(problemas.join(' ')).toMatch(/R\$ 640\.12 gastos ontem/);
    });

    it('uma venda solta sem gclid não vira alarme — é ruído, não sintoma', async () => {
      const problemas = await svcCom(prismaDiag([1, 0, 0, 2])).diagnosticarSilencio();
      expect(problemas).toEqual([]);
    });

    /**
     * APAGÃO POR CAMPANHA (02/09/2026). O caso real: a PMax "Raio Lojas ecomm"
     * passou 34 dias gastando R$ 40/dia com ZERO conversão — mas vive numa
     * conta onde 28 campanhas irmãs convertem normalmente, então o silêncio
     * dela sumia no total. Os cheques 1-4 nunca a veriam.
     */
    it('grita quando uma campanha que convertia PAROU de converter', async () => {
      const linha = {
        conta_id: '9564998046',
        campanha_id: '23311858516',
        nome: 'PMax Raio Lojas ecomm',
        gasto: 274.28,
        antes: 19.2,
      };
      const problemas = await svcCom(prismaDiag([4, 2, 3, 3], 0, [linha])).diagnosticarSilencio();
      const texto = problemas.join(' ');
      expect(texto).toMatch(/PMax Raio Lojas ecomm/);
      expect(texto).toMatch(/ZERO conversão/);
      // A conta tem que aparecer: a campanha vive FORA da conta de e-commerce.
      expect(texto).toMatch(/9564998046/);
    });

    /** Campanha que NUNCA converteu não é apagão — é o normal dela. */
    it('não grita por campanha local que nunca converteu', async () => {
      const problemas = await svcCom(prismaDiag([4, 2, 3, 3], 0, [])).diagnosticarSilencio();
      expect(problemas).toEqual([]);
    });

    /**
     * A conta de loja gasta ~R$ 890/dia e, por natureza, não vende no site.
     * Sem este filtro o cheque 3 gritaria em todo dia fraco — e alarme que
     * grita à toa treina todo mundo a ignorar o alarme.
     */
    it('o cheque de gasto exclui as contas de loja física', async () => {
      const prisma = prismaDiag([4, 2, 3, 3], 0, []);
      await svcCom(prisma).diagnosticarSilencio();
      const [sql, lista] = prisma.$queryRawUnsafe.mock.calls[0];
      expect(sql).toMatch(/conta_id <> ALL/);
      expect(Array.isArray(lista)).toBe(true);
    });
  });

  /**
   * ENHANCED CONVERSIONS (02/09/2026) — o gclid deixou de ser obrigatório.
   *
   * Contrato confirmado contra a API real com validateOnly:
   *  · `userData` só é aceito com `encoding: 'HEX'` no topo (sem isso, 400 seco);
   *  · e-mail em texto puro é recusado — tem que ir hasheado;
   *  · evento sem identificador nenhum é recusado, e o ingest é tudo-ou-nada,
   *    então um pedido sem chave levaria o lote inteiro junto.
   */
  describe('identificador de pessoa (enhanced conversions)', () => {
    const comPessoa = (extra: any) => ({
      ...pedido('a', 'LP-1'),
      customerEmail: 'maria@exemplo.com.br',
      customerPhone: '13991234567',
      ...extra,
    });
    // Hash fixo de propósito: mudar a canonicalização tem que QUEBRAR o teste.
    const HASH_EMAIL = '61e98e9932860e1e01dfc3c537de3158c0181ffea92011c1793b3c2db4e3e42d';
    const HASH_FONE = '28a24514a7e5939ff757c069c74978818c4db53b2b3a706809c3c4c630aca148';

    const monta = (pedidos: any[]) => {
      const { prisma, updateMany } = prismaFake(pedidos);
      const ads = adsFake({ requestId: 'req-1' });
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), ads as any, whatsFake() as any);
      return { svc, ads, updateMany, prisma };
    };

    it('manda e-mail e telefone hasheados junto com o gclid, e liga o encoding', async () => {
      const { svc, ads } = monta([comPessoa({})]);
      await svc.enviarPendentes();
      const corpo = ads.requisitarDataManager.mock.calls[0][1];
      expect(corpo.encoding).toBe('HEX');
      expect(corpo.events[0].adIdentifiers).toEqual({ gclid: 'gclid-a' });
      expect(corpo.events[0].userData).toEqual({
        userIdentifiers: [{ emailAddress: HASH_EMAIL }, { phoneNumber: HASH_FONE }],
      });
    });

    it('pedido SEM gclid entra no lote pela pessoa — era isso que faltava', async () => {
      const { svc, ads } = monta([comPessoa({ gclid: null })]);
      const r = await svc.enviarPendentes();
      expect(r.enviadas).toBe(1);
      const evento = ads.requisitarDataManager.mock.calls[0][1].events[0];
      expect(evento.adIdentifiers).toBeUndefined();
      expect(evento.userData.userIdentifiers).toHaveLength(2);
    });

    it('telefone sem DDI ganha +55; com 55 não duplica', async () => {
      const { svc, ads } = monta([
        comPessoa({ gclid: null, customerEmail: null, customerPhone: '(13) 99123-4567' }),
        { ...comPessoa({}), id: 'b', wcOrderNumber: 'LP-2', gclid: null, customerEmail: null, customerPhone: '5513991234567' },
      ]);
      await svc.enviarPendentes();
      const eventos = ads.requisitarDataManager.mock.calls[0][1].events;
      expect(eventos[0].userData.userIdentifiers).toEqual([{ phoneNumber: HASH_FONE }]);
      expect(eventos[1].userData.userIdentifiers).toEqual([{ phoneNumber: HASH_FONE }]);
    });

    it('e-mail inválido e telefone curto são ignorados', async () => {
      const { svc, ads } = monta([comPessoa({ customerEmail: 'nao-e-email', customerPhone: '1234' })]);
      await svc.enviarPendentes();
      expect(ads.requisitarDataManager.mock.calls[0][1].events[0].userData).toBeUndefined();
      // Sem userData no lote inteiro, o encoding não vai — caminho antigo intacto.
      expect(ads.requisitarDataManager.mock.calls[0][1].encoding).toBeUndefined();
    });

    it('pedido sem chave nenhuma fica FORA do lote e deixa rastro', async () => {
      const semNada = { ...pedido('z', 'LP-9'), gclid: null, customerEmail: null, customerPhone: null };
      const { svc, ads, updateMany } = monta([comPessoa({}), semNada]);
      const r = await svc.enviarPendentes();
      expect(r.enviadas).toBe(1);
      expect(r.recusadas).toBe(1);
      expect(ads.requisitarDataManager.mock.calls[0][1].events).toHaveLength(1);
      const rastro = updateMany.mock.calls.find((c: any[]) => c[0].data?.adsConversaoTentativas);
      expect(rastro[0].where.id.in).toEqual(['z']);
      expect(rastro[0].data.adsConversaoErro).toMatch(/sem gclid/);
    });

    it('lote que o Google recusa conta tentativa e grava o motivo no pedido', async () => {
      const { prisma, updateMany } = prismaFake([comPessoa({})]);
      const ads = adsFake(new Error('DataManager 400 em events:ingest: encoding ausente'));
      const svc = new GoogleAdsConversaoService(prisma, env(CREDENCIAIS), ads as any, whatsFake() as any);

      await expect(svc.enviarPendentes()).rejects.toThrow(/400/);

      const rastro = updateMany.mock.calls.find((c: any[]) => c[0].data?.adsConversaoTentativas);
      expect(rastro[0].where.id.in).toEqual(['a']);
      expect(rastro[0].data.adsConversaoErro).toMatch(/encoding ausente/);
      // Nada foi carimbado como enviado.
      expect(updateMany.mock.calls.some((c: any[]) => c[0].data?.adsConversaoEnviadaEm)).toBe(false);
    });

    it('a fila não exige mais gclid — aceita pedido com e-mail OU telefone', async () => {
      const { svc, prisma } = monta([]);
      await svc.enviarPendentes();
      const where = (prisma.order.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.gclid).toBeUndefined();
      expect(where.OR).toEqual([
        { gclid: { not: null } },
        { customerEmail: { not: null } },
        { customerPhone: { not: null } },
      ]);
    });
  });
});
