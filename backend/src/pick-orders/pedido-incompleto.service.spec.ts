import { BadRequestException } from '@nestjs/common';
import { PickOrdersService } from './pick-orders.service';

/**
 * PEDIDO INCOMPLETO NÃO POSTA (07/10 — ON-000600): a trava da porta do envio.
 */
describe('travarEnvioPedidoIncompleto', () => {
  const makeSvc = (linhas: any[]) => {
    const svc = Object.create(PickOrdersService.prototype) as any;
    svc.prisma = { orderItem: { findMany: jest.fn().mockResolvedValue(linhas) } };
    return svc;
  };

  afterEach(() => {
    delete process.env.ENVIO_EXIGE_PEDIDO_COMPLETO;
  });

  test('ON-000600: 2 peças sem loja travam a caixa de São José', async () => {
    const svc = makeSvc([
      { sku: '8000000030344', ref: '13131', cor: 'PRETO', tamanho: '48', assignedStoreId: null, cancelledAt: null },
      { sku: '8000000030276', ref: '131008', cor: 'AZUL', tamanho: '50', assignedStoreId: null, cancelledAt: null },
    ]);
    await expect(svc.travarEnvioPedidoIncompleto({ orderId: 'o' })).rejects.toThrow(BadRequestException);
    await expect(svc.travarEnvioPedidoIncompleto({ orderId: 'o' })).rejects.toThrow(/13131 PRETO 48/);
    // Só pergunta pelas linhas sem loja e não canceladas.
    expect(svc.prisma.orderItem.findMany.mock.calls[0][0].where).toEqual({
      orderId: 'o', assignedStoreId: null, cancelledAt: null,
    });
  });

  test('pedido completo (ou só frete sem loja) passa', async () => {
    const svc = makeSvc([{ sku: 'FRETE', ref: 'FRETE', assignedStoreId: null, cancelledAt: null }]);
    await expect(svc.travarEnvioPedidoIncompleto({ orderId: 'o' })).resolves.toBeUndefined();
  });

  test('kill-switch ENVIO_EXIGE_PEDIDO_COMPLETO=0', async () => {
    process.env.ENVIO_EXIGE_PEDIDO_COMPLETO = '0';
    const svc = makeSvc([{ sku: 'A', ref: 'A', assignedStoreId: null, cancelledAt: null }]);
    await expect(svc.travarEnvioPedidoIncompleto({ orderId: 'o' })).resolves.toBeUndefined();
    expect(svc.prisma.orderItem.findMany).not.toHaveBeenCalled();
  });
});
