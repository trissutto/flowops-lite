import { OrdersController } from './orders.controller';

/**
 * O PAPEL DA SEPARAÇÃO DIZIA A LOJA ERRADA (25/08/2026).
 *
 * A ordem de separação impressa chamava `prepare-separation` — que RECALCULA a
 * rota com o estoque do momento. Como a baixa acontece no bipe, assim que as
 * lojas designadas bipam as peças elas somem do cálculo e a simulação escolhe
 * outra loja. Caso LP-000254: roteado às 17:49 pra JUNDIAÍ + ITANHAÉM, impresso
 * às 18:40 como "LOJA: SOROCABA (06)" com as duas peças numa folha só —
 * Sorocaba nunca teve card nenhum desse pedido.
 *
 * `separation-confirmed` lê a rota PERSISTIDA: pick-orders vivos + o
 * `assignedStoreId` de cada item, os mesmos campos que a bipagem da loja usa.
 */
describe('OrdersController — separação confirmada (o que está valendo)', () => {
  const LOJA_JUNDIAI = { id: 'store-10', code: '10', name: 'JUNDIAÍ', city: 'Jundiaí', state: 'SP', whatsapp: null };
  const LOJA_ITANHAEM = { id: 'store-01', code: '01', name: 'ITANHAÉM', city: 'Itanhaém', state: 'SP', whatsapp: null };

  const pedido = {
    id: 'order-1',
    wcOrderId: 950000254,
    shippingMethod: 'Retirada em loja (JUNDIAÍ)',
    items: [
      { sku: '8000000004192', quantity: 1, productName: 'Blusa · MARINHO · 54', assignedStoreId: 'store-10' },
      { sku: '8000000004437', quantity: 1, productName: 'Blusa · UVA · 54', assignedStoreId: 'store-01' },
    ],
  };

  const fazController = (opts: { order?: any; picks?: any[] }) => {
    const ctrl = Object.create(OrdersController.prototype) as OrdersController;
    (ctrl as any).prisma = {
      order: { findUnique: jest.fn().mockResolvedValue(opts.order ?? null) },
      pickOrder: {
        // Mock com cara de banco: respeita o `status: { not: 'cancelled' }`.
        findMany: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve(
            (opts.picks ?? []).filter((p) => (where?.status?.not ? p.status !== where.status.not : true)),
          ),
        ),
      },
      store: {
        findMany: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve(
            [LOJA_JUNDIAI, LOJA_ITANHAEM].filter((s) => (where?.code?.in ?? []).includes(s.code)),
          ),
        ),
      },
    };
    return ctrl;
  };

  const chamar = (ctrl: OrdersController) => (ctrl as any).separacaoConfirmadaDoPedido(950000254);

  it('devolve as lojas que REALMENTE têm card, cada uma com a peça dela', async () => {
    const ctrl = fazController({
      order: pedido,
      picks: [
        { storeId: 'store-10', status: 'separated', isTransfer: false, transferToStoreCode: null, store: LOJA_JUNDIAI },
        { storeId: 'store-01', status: 'separated', isTransfer: true, transferToStoreCode: '10', store: LOJA_ITANHAEM },
      ],
    });
    const r = await chamar(ctrl);
    expect(r.confirmed).toBe(true);
    expect(r.strategy).toBe('multi-store');
    expect(r.groups.map((g: any) => g.storeCode)).toEqual(['10', '01']);
    expect(r.groups[0].items).toHaveLength(1);
    expect(r.groups[1].items[0].sku).toBe('8000000004437');
    expect(r.missing).toHaveLength(0);
  });

  it('feeder sabe pra QUAL loja a peça vai — código não basta no balcão', async () => {
    const ctrl = fazController({
      order: pedido,
      picks: [
        { storeId: 'store-10', status: 'new', isTransfer: false, transferToStoreCode: null, store: LOJA_JUNDIAI },
        { storeId: 'store-01', status: 'new', isTransfer: true, transferToStoreCode: '10', store: LOJA_ITANHAEM },
      ],
    });
    const r = await chamar(ctrl);
    const feeder = r.groups.find((g: any) => g.storeCode === '01');
    expect(feeder).toMatchObject({ isTransfer: true, transferToStoreCode: '10', transferToStoreName: 'JUNDIAÍ' });
  });

  it('sem rota confirmada devolve null — quem chama cai no preview', async () => {
    const ctrl = fazController({ order: pedido, picks: [] });
    expect(await chamar(ctrl)).toBeNull();
  });

  it('card CANCELADO não vira folha', async () => {
    const ctrl = fazController({
      order: pedido,
      picks: [
        { storeId: 'store-10', status: 'cancelled', isTransfer: false, transferToStoreCode: null, store: LOJA_JUNDIAI },
        { storeId: 'store-01', status: 'separating', isTransfer: false, transferToStoreCode: null, store: LOJA_ITANHAEM },
      ],
    });
    const r = await chamar(ctrl);
    expect(r.groups.map((g: any) => g.storeCode)).toEqual(['01']);
    // A peça da loja cancelada não some do papel em silêncio: vai pra `missing`.
    expect(r.missing.map((m: any) => m.sku)).toEqual(['8000000004192']);
    expect(r.strategy).toBe('single-store');
  });

  it('peça sem loja (ruptura ou "não achei") não é atribuída a ninguém', async () => {
    const ctrl = fazController({
      order: {
        ...pedido,
        items: [pedido.items[0], { ...pedido.items[1], assignedStoreId: null }],
      },
      picks: [
        { storeId: 'store-10', status: 'separating', isTransfer: false, transferToStoreCode: null, store: LOJA_JUNDIAI },
      ],
    });
    const r = await chamar(ctrl);
    expect(r.groups).toHaveLength(1);
    expect(r.missing.map((m: any) => m.sku)).toEqual(['8000000004437']);
  });
});
