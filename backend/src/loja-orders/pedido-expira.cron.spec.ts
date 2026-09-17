import { PedidoExpiraCron } from './pedido-expira.cron';

const DIA = 86_400_000;
/** Instante fixo — a janela é em dias e não pode depender do relógio do CI. */
const AGORA = Date.parse('2026-08-22T22:00:00.000Z');

function montar(opts: { alvos?: any[]; env?: Record<string, string | undefined>; afetados?: number } = {}) {
  const alvos = opts.alvos ?? [];
  const afetados = opts.afetados ?? alvos.length;
  // 1ª chamada: os alvos. 2ª (status: 'cancelled'): só quem de fato virou
  // cancelado — o mock simula o pedido que pagou no meio ficando de fora.
  const findMany = jest.fn().mockImplementation(async (args: any) =>
    args?.where?.status === 'cancelled' ? alvos.slice(0, afetados) : alvos,
  );
  const updateMany = jest.fn().mockResolvedValue({ count: afetados });
  const config = { get: jest.fn((chave: string) => opts.env?.[chave]) };
  const aoCancelarPedido = jest.fn().mockResolvedValue(true);
  const cron = new PedidoExpiraCron(
    { order: { findMany, updateMany } } as any,
    config as any,
    { aoCancelarPedido } as any,
  );
  const log = jest.spyOn((cron as any).logger, 'log').mockImplementation(() => undefined);
  return { cron, findMany, updateMany, log, aoCancelarPedido };
}

const pedido = (id: string) => ({ id, wcOrderNumber: id, createdAt: new Date(AGORA - 9 * DIA), totalAmount: 100 });

describe('PedidoExpiraCron', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(AGORA));
  afterEach(() => jest.restoreAllMocks());

  it('cancela só o que está há mais de 5 dias aguardando pagamento, e só do site novo', async () => {
    const { cron, findMany, updateMany } = montar({ alvos: [pedido('A'), pedido('B')] });
    await cron.ciclo();

    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ source: 'ecommerce', status: 'awaiting_payment', paidAt: null });
    // 5 dias é o default combinado com o dono (22/08).
    expect((where.createdAt.lt as Date).getTime()).toBe(AGORA - 5 * DIA);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].data).toMatchObject({ status: 'cancelled' });
    expect(updateMany.mock.calls[0][0].data.cancelledAt).toBeInstanceOf(Date);
  });

  /**
   * A trava que importa: entre achar e cancelar cabe o webhook da Pagar.me.
   * Sem `paidAt: null` no WHERE do próprio UPDATE, um pedido pago nesse
   * intervalo seria cancelado com o dinheiro já na conta.
   */
  it('reconfere status e paidAt no UPDATE, não só na busca', async () => {
    const { cron, updateMany } = montar({ alvos: [pedido('A')] });
    await cron.ciclo();
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      status: 'awaiting_payment',
      paidAt: null,
    });
  });

  it('registra quando um pedido escapa por ter pago no meio do ciclo', async () => {
    const { cron, log } = montar({ alvos: [pedido('A'), pedido('B')], afetados: 1 });
    await cron.ciclo();
    expect(log.mock.calls.some((c) => String(c[0]).includes('escaparam'))).toBe(true);
  });

  /**
   * O aviso (17/09) vai pra quem VIROU cancelado — relido do banco, nunca a
   * lista original: o pedido que pagou entre a busca e o update não pode
   * receber "seu pedido foi cancelado". E vai sempre como NÃO PAGO: este cron
   * só cancela `paidAt: null`.
   */
  it('avisa só quem de fato foi cancelado, como pedido não pago', async () => {
    const { cron, aoCancelarPedido } = montar({ alvos: [pedido('A'), pedido('B')], afetados: 1 });
    await cron.ciclo();
    expect(aoCancelarPedido).toHaveBeenCalledTimes(1);
    expect(aoCancelarPedido.mock.calls[0][0]).toMatchObject({ id: 'A' });
    expect(aoCancelarPedido.mock.calls[0][1]).toMatchObject({ pago: false });
  });

  it('aviso que falha não derruba o ciclo nem o cancelamento', async () => {
    const { cron, aoCancelarPedido, updateMany } = montar({ alvos: [pedido('A'), pedido('B')] });
    aoCancelarPedido.mockRejectedValueOnce(new Error('whats fora'));
    const warn = jest.spyOn((cron as any).logger, 'warn').mockImplementation(() => undefined);
    await expect(cron.ciclo()).resolves.toBeUndefined();
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(aoCancelarPedido).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('aviso não saiu'))).toBe(true);
  });

  it('não encosta em nada quando não há pedido vencido', async () => {
    const { cron, updateMany } = montar({ alvos: [] });
    await cron.ciclo();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('PEDIDO_EXPIRA=0 desliga o cron inteiro', async () => {
    const { cron, findMany } = montar({ alvos: [pedido('A')], env: { PEDIDO_EXPIRA: '0' } });
    await cron.ciclo();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('PEDIDO_EXPIRA_DIAS ajusta a janela, com piso de 1 dia', async () => {
    const { cron, findMany } = montar({ alvos: [pedido('A')], env: { PEDIDO_EXPIRA_DIAS: '10' } });
    await cron.ciclo();
    expect((findMany.mock.calls[0][0].where.createdAt.lt as Date).getTime()).toBe(AGORA - 10 * DIA);

    // Valor abaixo do piso cairia em cima do PIX de 24h ainda válido.
    const curto = montar({ alvos: [pedido('A')], env: { PEDIDO_EXPIRA_DIAS: '0' } });
    await curto.cron.ciclo();
    expect((curto.findMany.mock.calls[0][0].where.createdAt.lt as Date).getTime()).toBe(AGORA - 5 * DIA);
  });
});
