import { PedidoExpiraCron } from './pedido-expira.cron';

const DIA = 86_400_000;
/** Instante fixo — a janela é em dias e não pode depender do relógio do CI. */
const AGORA = Date.parse('2026-08-22T22:00:00.000Z');

function montar(opts: { alvos?: any[]; env?: Record<string, string | undefined>; afetados?: number } = {}) {
  const alvos = opts.alvos ?? [];
  const findMany = jest.fn().mockResolvedValue(alvos);
  const updateMany = jest.fn().mockResolvedValue({ count: opts.afetados ?? alvos.length });
  const config = { get: jest.fn((chave: string) => opts.env?.[chave]) };
  const cron = new PedidoExpiraCron({ order: { findMany, updateMany } } as any, config as any);
  const log = jest.spyOn((cron as any).logger, 'log').mockImplementation(() => undefined);
  return { cron, findMany, updateMany, log };
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
