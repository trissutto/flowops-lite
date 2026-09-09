import { RoutingService } from './routing.service';

/**
 * MOVER PEÇA NA MÃO NUM PEDIDO DE RETIRADA (LP-001224, 06/09/2026).
 *
 * Retirada em Moema (15), 7 peças espalhadas. A separação foi montada na mão
 * e a âncora saía SÓ dos feeders existentes — que o "forçar loja" tinha
 * acabado de zerar. Cada peça movida depois nascia em card comum, e card de
 * retirada sem `isTransfer` não tem trilho nenhum: `podeGerarCaixa` é falso,
 * então não sai caixa, nem etiqueta pra loja, nem NF de transferência — e
 * etiqueta de cliente também não sai, porque retirada não gera envio.
 *
 * Resultado medido em produção: 4 peças em SOROCABA, 3 em SÃO JOSÉ, ZERO em
 * Moema, 0 remessas, 3 dias parado e nenhum erro em lugar nenhum.
 *
 * É a SEGUNDA vez: o LP-000290 (31/08) teve o mesmo desfecho e ganhou só um
 * script de conserto (`fix-retirada-card-sem-transfer.js`), sem fechar a
 * porta que cria o card torto. Estes testes fecham.
 */
describe('RoutingService — retirada: peça movida vira card de transferência', () => {
  const ITEM = {
    id: 'item-vlm',
    sku: '5296170',
    quantity: 1,
    ref: 'VLM-222',
    cor: 'PRETO',
    tamanho: '58',
    productName: 'VESTIDO LONGO VLM-222',
    assignedStoreId: null,
  };

  const makeService = (order: Record<string, unknown>) => {
    const tx: any = {
      orderItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      pickOrder: {
        create: jest.fn().mockResolvedValue({ id: 'card-novo' }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const prisma: any = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'order-1224', status: 'separating', wcOrderId: 950001224,
          wcOrderNumber: 'LP-001224', source: 'ecommerce', customerName: 'Cliente',
          customerCpf: null, customerEmail: null, customerPhone: null,
          ...order,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      store: { findFirst: jest.fn().mockResolvedValue({ id: 'store-06', code: '06', name: 'SOROCABA' }) },
      orderItem: { findMany: jest.fn().mockResolvedValue([ITEM]) },
      // ZERO feeders — é exatamente o estado que o "forçar loja" deixa.
      pickOrder: { findMany: jest.fn().mockResolvedValue([]) },
      pickOrderScan: { findMany: jest.fn().mockResolvedValue([]) },
      orderHistory: { create: jest.fn().mockResolvedValue({}) },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };
    const gateway: any = { emitPickOrderToStore: jest.fn(), emitPickOrderStatus: jest.fn() };
    const service = new RoutingService(
      prisma, {} as any, {} as any, gateway, {} as any, {} as any, {} as any,
      { revertPickOrderStock: jest.fn().mockResolvedValue({ pecas: 0 }) } as any,
      { mapaParaRoteamento: jest.fn().mockResolvedValue(new Map()), marcarAchadaPorSku: jest.fn().mockResolvedValue({ count: 0 }) } as any,
    );
    (service as any).cleanupEmptyActivePickOrders = jest.fn().mockResolvedValue([]);
    return { service, prisma, tx };
  };

  const RETIRADA_MOEMA = {
    isPickup: true,
    pickupStoreCode: '15',
    shippingMethod: 'Retirada em loja (Moema)',
  };

  it('sem feeder nenhum, a âncora cai no destino da RETIRADA (o caso LP-001224)', async () => {
    const { service, tx } = makeService(RETIRADA_MOEMA);

    await service.moverItensParaLoja('order-1224', ['item-vlm'], '06', { nome: 'Thiago' });

    const criado = tx.pickOrder.create.mock.calls[0][0].data;
    expect(criado.isTransfer).toBe(true);
    expect(criado.transferToStoreCode).toBe('15');
  });

  it('o card alimentador leva o snapshot com a loja onde a cliente vai buscar', async () => {
    const { service, tx } = makeService(RETIRADA_MOEMA);

    await service.moverItensParaLoja('order-1224', ['item-vlm'], '06', { nome: 'Thiago' });

    const snap = JSON.parse(tx.pickOrder.create.mock.calls[0][0].data.customerSnapshot);
    expect(snap.pickupStoreCode).toBe('15');
    expect(snap.juntadaAncoraStoreCode).toBe('15');
  });

  it('peça movida PRA loja da retirada não vira transferência — já está onde precisa', async () => {
    const { service, prisma, tx } = makeService(RETIRADA_MOEMA);
    prisma.store.findFirst.mockResolvedValue({ id: 'store-15', code: '15', name: 'MOEMA' });

    await service.moverItensParaLoja('order-1224', ['item-vlm'], '15', { nome: 'Thiago' });

    const criado = tx.pickOrder.create.mock.calls[0][0].data;
    expect(criado.isTransfer).toBe(false);
    expect(criado.transferToStoreCode).toBeNull();
  });

  it('pedido de ENVIO normal segue como era: card comum, sem âncora inventada', async () => {
    const { service, tx } = makeService({ isPickup: false, pickupStoreCode: null, shippingMethod: 'PAC' });

    await service.moverItensParaLoja('order-1224', ['item-vlm'], '06', { nome: 'Thiago' });

    const criado = tx.pickOrder.create.mock.calls[0][0].data;
    expect(criado.isTransfer).toBe(false);
    expect(criado.transferToStoreCode).toBeNull();
    expect(criado.customerSnapshot).toBeNull();
  });
});
