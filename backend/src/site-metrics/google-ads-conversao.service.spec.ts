import { GoogleAdsConversaoService } from './google-ads-conversao.service';

/**
 * Testes do caminho que devolve a venda pro Google.
 *
 * Duas coisas aqui quebram EM SILÊNCIO, e são exatamente estas: um carimbo de
 * data no formato errado (o Google recusa a linha, o lote "passa", e a
 * conversão nunca aparece) e o carve-out do `partialFailure` (marcar o lote
 * inteiro faz a recusada sumir pra sempre, porque nunca mais é reapresentada).
 */
const env = (vals: Record<string, string | undefined>) =>
  ({ get: (k: string) => vals[k] }) as any;

const CREDENCIAIS = {
  GOOGLE_ADS_CONTAS: '8925231246',
  GOOGLE_ADS_CONVERSAO_ACTION_ID: '6807548872',
};

const adsFake = (resposta: any) => ({
  configurado: () => true,
  requisitar: jest.fn().mockResolvedValue(resposta),
});

describe('GoogleAdsConversaoService', () => {
  describe('configurado', () => {
    it('não roda sem o id da ação de conversão — subir pra ação errada não tem desfazer', () => {
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

  describe('carimbo de data', () => {
    /**
     * A API exige 'yyyy-MM-dd HH:mm:ss+/-HH:mm'. Sem o deslocamento explícito o
     * Google assume o fuso da conta e a venda das 23h vira do dia seguinte —
     * que é o tipo de erro que só aparece quando alguém compara relatório com
     * caixa, meses depois.
     */
    it('escreve hora de São Paulo com o fuso explícito', () => {
      const svc = new GoogleAdsConversaoService({} as any, env(CREDENCIAIS), adsFake({}) as any);
      // 2026-08-22T22:30:00Z = 19:30 em São Paulo (-03:00).
      const texto = (svc as any).momento(new Date('2026-08-22T22:30:00.000Z'));
      expect(texto).toBe('2026-08-22 19:30:00-03:00');
    });

    it('vira o dia pelo fuso da loja, não por UTC', () => {
      const svc = new GoogleAdsConversaoService({} as any, env(CREDENCIAIS), adsFake({}) as any);
      // 23:30 do dia 22 em SP já é dia 23 em UTC. Quem manda é a loja.
      const texto = (svc as any).momento(new Date('2026-08-23T02:30:00.000Z'));
      expect(texto.startsWith('2026-08-22 23:30:00')).toBe(true);
    });
  });

  describe('enviarPendentes', () => {
    const pedido = (id: string, numero: string) => ({
      id,
      wcOrderNumber: numero,
      gclid: `gclid-${id}`,
      totalAmount: 210.5,
      paidAt: new Date('2026-08-22T22:30:00.000Z'),
      createdAt: new Date('2026-08-22T20:00:00.000Z'),
    });

    const prismaFake = (pedidos: any[], updateMany: jest.Mock) =>
      ({ order: { findMany: jest.fn().mockResolvedValue(pedidos), updateMany } }) as any;

    it('manda o pedido no formato que a API espera, com orderId pra deduplicar', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const ads = adsFake({ results: [{ orderId: 'LP-1' }] });
      const svc = new GoogleAdsConversaoService(
        prismaFake([pedido('a', 'LP-1')], updateMany),
        env(CREDENCIAIS),
        ads as any,
      );

      const n = await svc.enviarPendentes();

      expect(n).toBe(1);
      const [caminho, corpo] = ads.requisitar.mock.calls[0];
      expect(caminho).toBe('customers/8925231246:uploadClickConversions');
      expect(corpo.partialFailure).toBe(true);
      expect(corpo.conversions[0]).toEqual({
        gclid: 'gclid-a',
        conversionAction: 'customers/8925231246/conversionActions/6807548872',
        conversionDateTime: '2026-08-22 19:30:00-03:00',
        conversionValue: 210.5,
        currencyCode: 'BRL',
        orderId: 'LP-1',
      });
    });

    /**
     * O CARVE-OUT. `results` vem com uma entrada por conversão, na mesma ordem,
     * e a recusada volta VAZIA. Carimbar o lote inteiro faria a recusada nunca
     * mais ser reapresentada — perda silenciosa, que é o pior tipo.
     */
    it('carimba só as que o Google aceitou, e deixa a recusada pra próxima', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const ads = adsFake({
        results: [{ orderId: 'LP-1' }, {}],
        partialFailureError: { message: 'clique fora da janela' },
      });
      const svc = new GoogleAdsConversaoService(
        prismaFake([pedido('a', 'LP-1'), pedido('b', 'LP-2')], updateMany),
        env(CREDENCIAIS),
        ads as any,
      );

      const n = await svc.enviarPendentes();

      expect(n).toBe(1);
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(updateMany.mock.calls[0][0].where.id.in).toEqual(['a']);
    });

    it('não carimba nada quando o Google recusa o lote inteiro', async () => {
      const updateMany = jest.fn();
      const svc = new GoogleAdsConversaoService(
        prismaFake([pedido('a', 'LP-1')], updateMany),
        env(CREDENCIAIS),
        adsFake({ results: [{}], partialFailureError: {} }) as any,
      );

      expect(await svc.enviarPendentes()).toBe(0);
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('só busca pedido PAGO, com gclid e ainda não enviado', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const svc = new GoogleAdsConversaoService(
        { order: { findMany, updateMany: jest.fn() } } as any,
        env(CREDENCIAIS),
        adsFake({}) as any,
      );

      await svc.enviarPendentes();

      const where = findMany.mock.calls[0][0].where;
      expect(where.source).toBe('ecommerce');
      expect(where.gclid).toEqual({ not: null });
      expect(where.adsConversaoEnviadaEm).toBeNull();
      expect(where.status.in).toContain('paid');
      expect(where.status.in).not.toContain('awaiting_payment');
    });
  });
});
