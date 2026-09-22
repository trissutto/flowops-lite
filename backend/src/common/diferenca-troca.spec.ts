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
  const fakePrisma = (opts: { swaps?: any[]; pago?: any; pagoPagbank?: any }) => ({
    orderItemSwap: {
      findMany: jest.fn().mockResolvedValue(opts.swaps ?? []),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ ...swapCobrancaPendente, ...data }),
      ),
    },
    pagarmePayment: { findFirst: jest.fn().mockResolvedValue(opts.pago ?? null) },
    pagbankPayment: { findFirst: jest.fn().mockResolvedValue(opts.pagoPagbank ?? null) },
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

  describe('PagBank (22/09): o link da troca saiu da Pagar.me', () => {
    const trocaNova = { ...swapCobrancaPendente, pagarmeOrderId: null };

    test('PIX/cartão pago no PagBank libera — procurado pelo saleId da troca', async () => {
      const prisma = fakePrisma({ swaps: [trocaNova], pagoPagbank: { paidAt: new Date('2026-09-22T15:00:00Z') } });
      const r = await diferencaDeTrocaPendente(prisma as any, 'order-1');
      expect(r.travado).toBe(false);
      expect(prisma.pagbankPayment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { saleId: 'troca:swap-1', status: 'paid' } }),
      );
      // Troca sem pedido da Pagar.me nem pergunta pra Pagar.me.
      expect(prisma.pagarmePayment.findFirst).not.toHaveBeenCalled();
      expect(prisma.orderItemSwap.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'settled' }) }),
      );
    });

    test('link do PagBank ainda sem pagamento continua TRAVANDO', async () => {
      const prisma = fakePrisma({ swaps: [trocaNova], pagoPagbank: null });
      const r = await diferencaDeTrocaPendente(prisma as any, 'order-1');
      expect(r.travado).toBe(true);
    });

    test('link antigo da Pagar.me pago segue liberando (e nem precisa do PagBank)', async () => {
      const prisma = fakePrisma({ swaps: [swapCobrancaPendente], pago: { paidAt: new Date() } });
      const r = await diferencaDeTrocaPendente(prisma as any, 'order-1');
      expect(r.travado).toBe(false);
      expect(prisma.pagbankPayment.findFirst).not.toHaveBeenCalled();
    });

    test('link antigo da Pagar.me sem pagamento ainda confere o PagBank (troca refeita no link novo)', async () => {
      const prisma = fakePrisma({ swaps: [swapCobrancaPendente], pago: null, pagoPagbank: { paidAt: new Date() } });
      const r = await diferencaDeTrocaPendente(prisma as any, 'order-1');
      expect(r.travado).toBe(false);
    });

    test('erro de leitura do PagBank NÃO solta a peça — a trava fica de pé', async () => {
      const prisma = fakePrisma({ swaps: [trocaNova] });
      prisma.pagbankPayment.findFirst = jest.fn().mockRejectedValue(new Error('banco caiu'));
      const r = await diferencaDeTrocaPendente(prisma as any, 'order-1');
      expect(r.travado).toBe(true);
    });
  });
});
