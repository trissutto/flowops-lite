import { BadRequestException } from '@nestjs/common';
import { JuntadaService } from './juntada.service';

describe('JuntadaService — âncora logística', () => {
  const makeService = (order: any) => {
    const prisma: any = {
      order: { findFirst: jest.fn().mockResolvedValue(order) },
      realignmentShipment: { findMany: jest.fn() },
    };
    const service = new JuntadaService(
      prisma,
      { emitPickOrderStatus: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, prisma };
  };

  const card = (id: string, storeId: string, code: string) => ({
    id,
    storeId,
    status: 'new',
    isTransfer: false,
    transferToStoreCode: null,
    store: { code, name: code === '03' ? 'VINHEDO' : 'PIRACICABA' },
  });

  it('recusa card vazio como âncora em SEDEX', async () => {
    const { service } = makeService({
      id: 'order-1',
      wcOrderNumber: 'ON-TESTE',
      isPickup: false,
      pickupStoreCode: null,
      shippingMethod: 'SEDEX EXPRESSO',
      pickOrders: [card('pira', 'store-05', '05'), card('vinhedo', 'store-03', '03')],
      items: [{ assignedStoreId: 'store-03', sku: '8000000003652', quantity: 2 }],
    });

    await expect(service.juntarPedido(1, '05')).rejects.toThrow(
      'A loja 05 está com card vazio neste pedido e não pode ser âncora',
    );
  });

  it('não junta quando uma única loja cobre as duas unidades', async () => {
    const { service } = makeService({
      id: 'order-2',
      wcOrderNumber: 'ON-TESTE-2',
      isPickup: false,
      pickupStoreCode: null,
      shippingMethod: 'SEDEX EXPRESSO',
      pickOrders: [card('pira', 'store-05', '05'), card('vinhedo', 'store-03', '03')],
      items: [{ assignedStoreId: 'store-03', sku: '8000000003652', quantity: 2 }],
    });

    await expect(service.juntarPedido(2, '03')).rejects.toThrow(
      'VINHEDO já possui 2 peça(s), cobrindo sozinho o pedido',
    );
  });

  it('motoboy com loja escolhida usa destino obrigatório, não juntada manual', async () => {
    const { service } = makeService({
      id: 'order-3',
      wcOrderNumber: 'ON-TESTE-3',
      isPickup: false,
      pickupStoreCode: '05',
      shippingMethod: 'MOTOBOY',
      pickOrders: [card('pira', 'store-05', '05'), card('vinhedo', 'store-03', '03')],
      items: [{ assignedStoreId: 'store-03', sku: '8000000003652', quantity: 2 }],
    });

    await expect(service.juntarPedido(3, '03')).rejects.toThrow(
      'Pedido de MOTOBOY já tem destino obrigatório na loja 05',
    );
  });

  it('retirada continua no trilho próprio', async () => {
    const { service } = makeService({
      id: 'order-4',
      isPickup: true,
      pickupStoreCode: '05',
      shippingMethod: 'RETIRADA EM LOJA',
      pickOrders: [card('pira', 'store-05', '05'), card('vinhedo', 'store-03', '03')],
      items: [{ assignedStoreId: 'store-03', sku: '8000000003652', quantity: 2 }],
    });

    await expect(service.juntarPedido(4, '03')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.juntarPedido(4, '03')).rejects.toThrow(
      'Pedido de RETIRADA já junta sozinho na loja da retirada',
    );
  });
});

