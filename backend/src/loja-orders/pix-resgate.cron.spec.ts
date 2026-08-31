import { PixResgateCron } from './pix-resgate.cron';

const MIN = 60_000;
/** Instante fixo pra conferir a janela sem tolerância de milissegundo. */
const AGORA = Date.parse('2026-08-17T15:00:00.000Z');

function montar(opts: {
  pendentes?: any[];
  env?: Record<string, string | undefined>;
  aoPixNaoPago?: jest.Mock;

  findFirst?: jest.Mock;
} = {}) {
  const findMany = jest.fn().mockResolvedValue(opts.pendentes ?? []);
  const findUnique = jest.fn().mockResolvedValue({ paidAt: null, status: 'awaiting_payment' });
  // Pedido GÊMEO pago (checkout refeito) — por padrão não existe.

  const findFirst = opts.findFirst ?? jest.fn().mockResolvedValue(null);

  const update = jest.fn().mockResolvedValue({});
  const aoPixNaoPago = opts.aoPixNaoPago ?? jest.fn().mockResolvedValue(true);
  const config = { get: jest.fn((chave: string) => opts.env?.[chave]) };
  const cron = new PixResgateCron(
    { order: { findMany, findUnique, findFirst, update } } as any,
    config as any,
    { aoPixNaoPago } as any,
  );
  const warn = jest.spyOn((cron as any).logger, 'warn').mockImplementation(() => undefined);
  return { cron, findMany, findUnique, findFirst, update, aoPixNaoPago, warn };
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

/**
 * CHECKOUT REFEITO (31/08) — a cliente que pagou o gêmeo não pode ouvir
 * "seu PIX não foi pago". Caso real: Rosana, LP-001039 × LP-001041.
 */
describe('PixResgateCron — cliente refez o checkout', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(AGORA);
  });
  afterEach(() => jest.restoreAllMocks());

  /** O fantasma: criado 5min antes do gêmeo, nunca pago. */
  const fantasma = (over: any = {}) => ({
    id: 'LP-001039',
    wcOrderNumber: 'LP-001039',
    status: 'awaiting_payment',
    paidAt: null,
    customerCpf: '12545656801',
    customerPhone: '11961365907',
    totalAmount: 123.89,
    createdAt: new Date(AGORA - 40 * MIN),
    trackingInfo: JSON.stringify({ recovery_consent: true }),
    items: [],
    ...over,
  });

  it('NÃO toca a cliente que já pagou um pedido gêmeo', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      wcOrderNumber: 'LP-001041',
      paidAt: new Date(AGORA - 35 * MIN),
    });
    const { cron, aoPixNaoPago, update } = montar({ pendentes: [fantasma()], findFirst });

    await cron.ciclo();

    expect(aoPixNaoPago).not.toHaveBeenCalled();
    // E não mente no carimbo: o toque não foi entregue, então não é "avisado".
    expect(update).not.toHaveBeenCalled();
  });

  it('procura o gêmeo pela MESMA cliente, MESMO valor e janela curta', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const { cron } = montar({ pendentes: [fantasma()], findFirst });

    await cron.ciclo();

    const where = findFirst.mock.calls[0][0].where;
    expect(where.customerCpf).toBe('12545656801');
    expect(where.totalAmount).toBe(123.89);
    expect(where.paidAt).toEqual({ not: null });
    expect(where.id).toEqual({ not: 'LP-001039' });
    const janelaH =
      (where.createdAt.lte.getTime() - where.createdAt.gte.getTime()) / 3_600_000;
    expect(janelaH).toBe(4); // ±2h
  });

  it('sem gêmeo pago, o resgate sai normalmente — a venda que o cron existe pra salvar', async () => {
    const { cron, aoPixNaoPago, update } = montar({ pendentes: [fantasma()] });

    await cron.ciclo();

    expect(aoPixNaoPago).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'LP-001039' } }),
    );
  });

  it('cliente sem CPF casa por telefone', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const { cron } = montar({ pendentes: [fantasma({ customerCpf: null })], findFirst });

    await cron.ciclo();

    expect(findFirst.mock.calls[0][0].where.customerPhone).toBe('11961365907');
  });

  it('sem CPF e sem telefone o toque SAI — não dá pra afirmar que é a mesma pessoa', async () => {
    const findFirst = jest.fn().mockResolvedValue({ wcOrderNumber: 'QUALQUER' });
    const { cron, aoPixNaoPago } = montar({
      pendentes: [fantasma({ customerCpf: null, customerPhone: null })],
      findFirst,
    });

    await cron.ciclo();

    expect(findFirst).not.toHaveBeenCalled();
    expect(aoPixNaoPago).toHaveBeenCalledTimes(1);
  });
});
