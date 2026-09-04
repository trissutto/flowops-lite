import { RoutingService } from './routing.service';

/**
 * MOVER PEÇA NA MÃO DESFAZ O "NÃO ACHEI" DA LOJA DE DESTINO (04/09).
 *
 * Pedido 1083: Itanhaém reportou a BMM-100 MILITAR como extraviada e depois
 * achou. A matriz manda a peça de volta pra lá — e a marca tinha que cair
 * junto, senão o roteamento seguiria pulando a loja pra esse código e a tela
 * seguiria vermelha na peça que está na mão da vendedora.
 */
describe('RoutingService — mover peça na mão desfaz a marca de EXTRAVIADA', () => {
  const ITEM = {
    id: 'item-bmm',
    sku: '0012345',
    quantity: 1,
    ref: 'BMM-100',
    cor: 'MILITAR',
    tamanho: '48',
    productName: 'BLUSA BMM-100',
    assignedStoreId: null, // órfã: o reporte tirou a peça do card
  };

  const makeService = () => {
    const tx: any = {
      orderItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      pickOrder: {
        create: jest.fn().mockResolvedValue({ id: 'card-novo', isTransfer: false, transferToStoreCode: null }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma: any = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'order-1083', status: 'separating', wcOrderId: 1083, wcOrderNumber: 'ON-001083',
          source: 'wc', customerName: 'Cliente', customerCpf: null, customerEmail: null,
          customerPhone: null, shippingMethod: 'PAC',
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      store: {
        findFirst: jest.fn().mockResolvedValue({ id: 'store-itanhaem', code: '20', name: 'ITANHAEM' }),
      },
      orderItem: { findMany: jest.fn().mockResolvedValue([ITEM]) },
      pickOrder: { findMany: jest.fn().mockResolvedValue([]) },
      pickOrderScan: { findMany: jest.fn().mockResolvedValue([]) },
      orderHistory: { create: jest.fn().mockResolvedValue({}) },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };
    const gateway: any = { emitPickOrderToStore: jest.fn(), emitPickOrderStatus: jest.fn() };
    const extraviadas: any = {
      mapaParaRoteamento: jest.fn().mockResolvedValue(new Map()),
      marcarAchadaPorSku: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const service = new RoutingService(
      prisma, {} as any, {} as any, gateway, {} as any, {} as any, {} as any,
      { revertPickOrderStock: jest.fn().mockResolvedValue({ pecas: 0 }) } as any,
      extraviadas,
    );
    // O saneamento de card vazio tem teste próprio; aqui ele só não pode
    // atrapalhar a medição.
    (service as any).cleanupEmptyActivePickOrders = jest.fn().mockResolvedValue([]);
    return { service, prisma, extraviadas };
  };

  it('marca a peça como ACHADA na loja de destino e conta isso no retorno', async () => {
    const { service, extraviadas } = makeService();

    const r: any = await service.moverItensParaLoja('order-1083', ['item-bmm'], '20', {
      userId: 'user-thiago', nome: 'Thiago',
    });

    expect(r.movidos).toBe(1);
    expect(extraviadas.marcarAchadaPorSku).toHaveBeenCalledWith('20', '0012345', 'user-thiago');
    expect(r.extraviadasAchadas).toBe(1);
  });

  it('escreve no histórico do pedido que a marca foi desfeita', async () => {
    const { service, prisma } = makeService();

    await service.moverItensParaLoja('order-1083', ['item-bmm'], '20', { nome: 'Thiago' });

    const nota = prisma.orderHistory.create.mock.calls[0][0].data.note as string;
    expect(nota).toContain('EXTRAVIADA');
    expect(nota).toContain('20');
  });

  it('falha do "achei" NÃO derruba a movimentação — a peça já tem dono novo', async () => {
    const { service, extraviadas } = makeService();
    extraviadas.marcarAchadaPorSku.mockRejectedValue(new Error('banco fora'));

    const r: any = await service.moverItensParaLoja('order-1083', ['item-bmm'], '20', {});

    expect(r.ok).toBe(true);
    expect(r.movidos).toBe(1);
    expect(r.extraviadasAchadas).toBe(0);
  });

  it('não mexe na marca das OUTRAS lojas: só a de destino é contradita', async () => {
    const { service, extraviadas } = makeService();

    await service.moverItensParaLoja('order-1083', ['item-bmm'], '20', {});

    expect(extraviadas.marcarAchadaPorSku).toHaveBeenCalledTimes(1);
    expect(extraviadas.marcarAchadaPorSku.mock.calls[0][0]).toBe('20');
  });
});
