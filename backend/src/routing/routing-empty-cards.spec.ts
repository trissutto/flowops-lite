import { RoutingService } from './routing.service';

describe('RoutingService — saneamento de cards vazios', () => {
  const makeService = (order: any) => {
    const prisma: any = {
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      orderItem: { count: jest.fn().mockResolvedValue(0) },
      pickOrder: { delete: jest.fn().mockResolvedValue({}) },
      orderHistory: { create: jest.fn().mockResolvedValue({}) },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const gateway: any = { emitPickOrderRemoved: jest.fn() };
    const pickScans: any = { revertPickOrderStock: jest.fn().mockResolvedValue({ pecas: 0 }) };
    const service = new RoutingService(
      prisma,
      {} as any,
      {} as any,
      gateway,
      {} as any,
      {} as any,
      {} as any,
      pickScans,
    );
    return { service, prisma, gateway, pickScans };
  };

  it('remove card vazio de envio SEDEX', async () => {
    const { service, prisma, gateway, pickScans } = makeService({
      id: 'order-1',
      status: 'separating',
      isPickup: false,
      pickupStoreCode: null,
      shippingMethod: 'SEDEX EXPRESSO',
      items: [{ assignedStoreId: 'store-03', sku: 'SKU', quantity: 2 }],
      pickOrders: [
        { id: 'pira', storeId: 'store-05', status: 'new', isTransfer: false, transferToStoreCode: null, store: { code: '05', name: 'PIRACICABA' } },
        { id: 'vinhedo', storeId: 'store-03', status: 'new', isTransfer: false, transferToStoreCode: null, store: { code: '03', name: 'VINHEDO' } },
      ],
    });

    const removed = await (service as any).cleanupEmptyActivePickOrders('order-1');

    expect(removed).toEqual(['05']);
    expect(pickScans.revertPickOrderStock).toHaveBeenCalledWith('pira', expect.any(Object));
    expect(prisma.pickOrder.delete).toHaveBeenCalledWith({ where: { id: 'pira' } });
    expect(gateway.emitPickOrderRemoved).toHaveBeenCalledWith('store-05', expect.objectContaining({ pickOrderId: 'pira' }));
  });

  it('preserva o card quando o estorno de estoque falha', async () => {
    const { service, prisma, gateway, pickScans } = makeService({
      id: 'order-estorno',
      status: 'separating',
      isPickup: false,
      pickupStoreCode: null,
      shippingMethod: 'SEDEX EXPRESSO',
      items: [{ assignedStoreId: 'store-03', sku: 'SKU', quantity: 2 }],
      pickOrders: [
        { id: 'pira', storeId: 'store-05', status: 'new', isTransfer: false, transferToStoreCode: null, store: { code: '05', name: 'PIRACICABA' } },
        { id: 'vinhedo', storeId: 'store-03', status: 'new', isTransfer: false, transferToStoreCode: null, store: { code: '03', name: 'VINHEDO' } },
      ],
    });
    pickScans.revertPickOrderStock.mockRejectedValueOnce(new Error('estoque indisponível'));

    expect(await (service as any).cleanupEmptyActivePickOrders('order-estorno')).toEqual([]);
    expect(prisma.pickOrder.delete).not.toHaveBeenCalled();
    expect(gateway.emitPickOrderRemoved).not.toHaveBeenCalled();
  });

  it('preserva receptor vazio do motoboy quando há feeder com peças', async () => {
    const { service, prisma, pickScans } = makeService({
      id: 'order-2',
      status: 'separating',
      isPickup: false,
      pickupStoreCode: '05',
      shippingMethod: 'MOTOBOY',
      items: [{ assignedStoreId: 'store-03', sku: 'SKU', quantity: 2 }],
      pickOrders: [
        { id: 'pira', storeId: 'store-05', status: 'new', isTransfer: false, transferToStoreCode: null, store: { code: '05', name: 'PIRACICABA' } },
        { id: 'vinhedo', storeId: 'store-03', status: 'new', isTransfer: true, transferToStoreCode: '05', store: { code: '03', name: 'VINHEDO' } },
      ],
    });

    const removed = await (service as any).cleanupEmptyActivePickOrders('order-2');

    expect(removed).toEqual([]);
    expect(pickScans.revertPickOrderStock).not.toHaveBeenCalled();
    expect(prisma.pickOrder.delete).not.toHaveBeenCalled();
  });

  it('preserva receptor vazio da retirada quando há feeder com peças', async () => {
    const { service, prisma } = makeService({
      id: 'order-3',
      status: 'separating',
      isPickup: true,
      pickupStoreCode: '05',
      shippingMethod: 'RETIRADA EM LOJA',
      items: [{ assignedStoreId: 'store-03', sku: 'SKU', quantity: 2 }],
      pickOrders: [
        { id: 'pira', storeId: 'store-05', status: 'new', isTransfer: false, transferToStoreCode: null, store: { code: '05', name: 'PIRACICABA' } },
        { id: 'vinhedo', storeId: 'store-03', status: 'new', isTransfer: true, transferToStoreCode: '05', store: { code: '03', name: 'VINHEDO' } },
      ],
    });

    expect(await (service as any).cleanupEmptyActivePickOrders('order-3')).toEqual([]);
    expect(prisma.pickOrder.delete).not.toHaveBeenCalled();
  });
});
