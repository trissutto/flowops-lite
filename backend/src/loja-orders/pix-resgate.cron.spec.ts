import { PixResgateCron } from './pix-resgate.cron';

const MIN = 60_000;
/** Instante fixo pra conferir a janela sem tolerância de milissegundo. */
const AGORA = Date.parse('2026-08-17T15:00:00.000Z');

function montar(opts: {
  pendentes?: any[];
  env?: Record<string, string | undefined>;
  aoPixNaoPago?: jest.Mock;
} = {}) {
  const findMany = jest.fn().mockResolvedValue(opts.pendentes ?? []);
  const findUnique = jest.fn().mockResolvedValue({ paidAt: null, status: 'awaiting_payment' });
  const update = jest.fn().mockResolvedValue({});
  const aoPixNaoPago = opts.aoPixNaoPago ?? jest.fn().mockResolvedValue(true);
  const config = { get: jest.fn((chave: string) => opts.env?.[chave]) };
  const cron = new PixResgateCron(
    { order: { findMany, findUnique, update } } as any,
    config as any,
    { aoPixNaoPago } as any,
  );
  const warn = jest.spyOn((cron as any).logger, 'warn').mockImplementation(() => undefined);
  return { cron, findMany, findUnique, update, aoPixNaoPago, warn };
}

describe('PixResgateCron', () => {
  const envOriginal = process.env.PIX_EXPIRA_MIN;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(AGORA);
    delete process.env.PIX_EXPIRA_MIN;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (envOriginal === undefined) delete process.env.PIX_EXPIRA_MIN;
    else process.env.PIX_EXPIRA_MIN = envOriginal;
  });

  it('envia lembrete somente para pedido com consentimento explícito', async () => {
    const consentido = {
      id: 'com-opt-in', status: 'awaiting_payment', paidAt: null,
      trackingInfo: JSON.stringify({ recovery_consent: true }), items: [],
    };
    const semConsentimento = {
      id: 'sem-opt-in', status: 'awaiting_payment', paidAt: null,
      trackingInfo: JSON.stringify({ recovery_consent: false }), items: [],
    };
    const { cron, aoPixNaoPago, update } = montar({ pendentes: [semConsentimento, consentido] });

    await cron.ciclo();

    expect(aoPixNaoPago).toHaveBeenCalledTimes(1);
    expect(aoPixNaoPago).toHaveBeenCalledWith(consentido);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'com-opt-in' } }));
  });

  it('ignora tracking ausente ou inválido', async () => {
    const aoPixNaoPago = jest.fn();
    const { cron } = montar({
      pendentes: [
        { id: 'antigo', trackingInfo: null },
        { id: 'quebrado', trackingInfo: '{' },
      ],
      aoPixNaoPago,
    });

    await cron.ciclo();

    expect(aoPixNaoPago).not.toHaveBeenCalled();
  });

  describe('janela = PIX_RESGATE_MIN até a validade do PIX (PIX_EXPIRA_MIN)', () => {
    // Até 17/08 a validade era 120 chumbados aqui enquanto o PIX valia 1440:
    // pedido de 3h de idade nunca era tocado. A janela tem que seguir a env
    // que a criação do PIX usa.
    it('sem env: piso de 24h (o mesmo default da criação do PIX) e teto de 30min', async () => {
      const { cron, findMany } = montar();

      await cron.ciclo();

      const where = findMany.mock.calls[0][0].where;
      expect(where.createdAt).toEqual({
        gte: new Date(AGORA - 1440 * MIN),
        lte: new Date(AGORA - 30 * MIN),
      });
    });

    it('PIX_EXPIRA_MIN muda o piso da busca junto com a validade do PIX', async () => {
      process.env.PIX_EXPIRA_MIN = '120';
      const { cron, findMany } = montar({ env: { PIX_RESGATE_MIN: '45' } });

      await cron.ciclo();

      const where = findMany.mock.calls[0][0].where;
      expect(where.createdAt).toEqual({
        gte: new Date(AGORA - 120 * MIN),
        lte: new Date(AGORA - 45 * MIN),
      });
    });

    it('PIX_EXPIRA_MIN inválida ou vazia cai no default de 24h, como na criação', async () => {
      process.env.PIX_EXPIRA_MIN = 'abc';
      const { cron, findMany } = montar();

      await cron.ciclo();

      expect(findMany.mock.calls[0][0].where.createdAt.gte).toEqual(new Date(AGORA - 1440 * MIN));
    });

    it('janela invertida (espera >= validade): avisa e NÃO varre, em vez de sumir calado', async () => {
      process.env.PIX_EXPIRA_MIN = '120';
      const { cron, findMany, warn, aoPixNaoPago } = montar({ env: { PIX_RESGATE_MIN: '180' } });

      await cron.ciclo();

      expect(findMany).not.toHaveBeenCalled();
      expect(aoPixNaoPago).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('janela invertida'));
    });
  });

  describe('expiresAt do próprio PIX (afina o piso por createdAt)', () => {
    const base = {
      status: 'awaiting_payment', paidAt: null,
      trackingInfo: JSON.stringify({ recovery_consent: true }), items: [],
    };

    it('PIX já vencido não recebe toque nem gasta vaga; o que ainda vale, recebe', async () => {
      const vencido = {
        ...base, id: 'vencido',
        paymentInfo: JSON.stringify({ pix: { expiresAt: new Date(AGORA - 1 * MIN).toISOString() } }),
      };
      const vivo = {
        ...base, id: 'vivo',
        paymentInfo: JSON.stringify({ pix: { expiresAt: new Date(AGORA + 60 * MIN).toISOString() } }),
      };
      const { cron, aoPixNaoPago, update } = montar({ pendentes: [vencido, vivo] });

      await cron.ciclo();

      expect(aoPixNaoPago).toHaveBeenCalledTimes(1);
      expect(aoPixNaoPago).toHaveBeenCalledWith(vivo);
      expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'vencido' } }));
    });

    it('sem expiresAt ou paymentInfo quebrado: confia no piso do banco e toca', async () => {
      const semCampo = { ...base, id: 'sem-campo', paymentInfo: JSON.stringify({ pix: { copyPaste: '000' } }) };
      const quebrado = { ...base, id: 'quebrado', paymentInfo: '{' };
      const { cron, aoPixNaoPago } = montar({ pendentes: [semCampo, quebrado] });

      await cron.ciclo();

      expect(aoPixNaoPago).toHaveBeenCalledTimes(2);
    });

    it('cartão em análise (method card, pix:null) NUNCA recebe "seu Pix está esperando"', async () => {
      // 17/08: cartão em análise de antifraude passou a ficar awaiting_payment
      // com paymentInfo {"method":"card",...,"pix":null,"cartaoEmAnalise":true}.
      // O filtro antigo `contains '"pix"'` casava com o `"pix":null` e a
      // cliente que JÁ TINHA PAGO no cartão recebia lembrete de PIX.
      const cartaoEmAnalise = {
        ...base, id: 'cartao',
        paymentInfo: JSON.stringify({ method: 'card', pix: null, cartaoEmAnalise: true }),
      };
      const pixVivo = {
        ...base, id: 'pix',
        paymentInfo: JSON.stringify({ method: 'pix', pix: { copyPaste: '000', expiresAt: new Date(AGORA + 60 * MIN).toISOString() } }),
      };
      // Simula o banco devolvendo os dois (o filtro do banco é a 1ª barreira;
      // este teste garante a 2ª, em memória).
      const { cron, aoPixNaoPago } = montar({ pendentes: [cartaoEmAnalise, pixVivo] });

      await cron.ciclo();

      expect(aoPixNaoPago).toHaveBeenCalledTimes(1);
      expect(aoPixNaoPago).toHaveBeenCalledWith(pixVivo);
    });
  });
});
