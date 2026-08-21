import { conferirDiferencaNoGateway, diferencaDeTrocaPendente, trocaTravaLigada } from './diferenca-troca';

/**
 * A TRAVA DA DIFERENÇA — testes da régua que decide se a peça pode viajar.
 *
 * É dinheiro: se ela travar demais, pedido pago fica parado na fila; se
 * soltar demais, a casa manda peça mais cara sem receber a diferença. Os dois
 * erros são silenciosos na operação, então ficam cobertos aqui.
 */
describe('diferença da troca de peça', () => {
  const swapCobrancaPendente = {
    id: 'swap-1',
    orderId: 'order-1',
    tipo: 'cobranca',
    status: 'pending',
    pagarmeOrderId: 'or_123',
    diffCents: 2000,
    oldSku: '111',
    newSku: '222',
  };

  /** Prisma de mentira: só o que a régua consulta. */
  const fakePrisma = (opts: { swaps?: any[]; pago?: any }) => ({
    orderItemSwap: {
      findMany: jest.fn().mockResolvedValue(opts.swaps ?? []),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ ...swapCobrancaPendente, ...data }),
      ),
    },
    pagarmePayment: { findFirst: jest.fn().mockResolvedValue(opts.pago ?? null) },
    orderHistory: { create: jest.fn().mockResolvedValue({}) },
  });

  afterEach(() => {
    delete process.env.TROCA_PECA_TRAVA;
  });

  test('sem troca nenhuma, nada trava', async () => {
    const prisma = fakePrisma({ swaps: [] });
    await expect(diferencaDeTrocaPendente(prisma as any, 'order-1')).resolves.toEqual({ travado: false });
  });

  test('cobrança pendente e não paga TRAVA, com o valor na mensagem', async () => {
    const prisma = fakePrisma({ swaps: [swapCobrancaPendente], pago: null });
    const r = await diferencaDeTrocaPendente(prisma as any, 'order-1');
    expect(r.travado).toBe(true);
    expect(r.motivo).toContain('20.00');
  });

  test('gateway já registrou o pagamento → libera e marca settled', async () => {
    const pago = { paidAt: new Date('2026-08-21T12:00:00Z') };
    const prisma = fakePrisma({ swaps: [swapCobrancaPendente], pago });
    const r = await diferencaDeTrocaPendente(prisma as any, 'order-1');
    expect(r.travado).toBe(false);
    // O swap não fica "pending" pra sempre: a leitura carimba o acerto.
    expect(prisma.orderItemSwap.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'settled' }) }),
    );
  });

  test('vale (diferença a menor) NUNCA trava — o dinheiro é nosso, não dela', async () => {
    // A busca já filtra tipo='cobranca'; o vale nem chega aqui.
    const prisma = fakePrisma({ swaps: [] });
    const r = await diferencaDeTrocaPendente(prisma as any, 'order-1');
    expect(r.travado).toBe(false);
    expect(prisma.orderItemSwap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tipo: 'cobranca', status: 'pending' }) }),
    );
  });

  test('kill-switch TROCA_PECA_TRAVA=0 solta tudo', async () => {
    process.env.TROCA_PECA_TRAVA = '0';
    expect(trocaTravaLigada()).toBe(false);
    const prisma = fakePrisma({ swaps: [swapCobrancaPendente] });
    await expect(diferencaDeTrocaPendente(prisma as any, 'order-1')).resolves.toEqual({ travado: false });
    expect(prisma.orderItemSwap.findMany).not.toHaveBeenCalled();
  });

  test('conferir é idempotente: swap já settled não vira update de novo', async () => {
    const prisma = fakePrisma({ pago: { paidAt: new Date() } });
    const jaPago = { ...swapCobrancaPendente, status: 'settled' };
    const r = await conferirDiferencaNoGateway(prisma as any, jaPago);
    expect(r).toBe(jaPago);
    expect(prisma.orderItemSwap.update).not.toHaveBeenCalled();
  });
});
