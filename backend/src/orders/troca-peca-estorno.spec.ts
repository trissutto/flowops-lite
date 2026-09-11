import { TrocaPecaService } from './troca-peca.service';
import { RoutingService } from '../routing/routing.service';

/**
 * O ESTORNO SAI ANTES DE REESCREVER O SKU (11/09/2026 — LP-001312).
 *
 * A troca reescreve o `OrderItem` in-place, e os estornos do card leem o SKU
 * DELE. Rodando depois da reescrita (como rodava desde 26/08 no card separado,
 * e como ia rodar no destrave do card postado), Piracicaba ganhava uma SMILE
 * PRETO 52 que nunca teve e a SMILE PRETO 58 — que estava na arara — sumia do
 * estoque. Estes testes travam a ORDEM: estorna, reescreve, re-roteia.
 */

const SKU_VELHO = '8000000001111';
const SKU_NOVO = '8000000004109';

function montarTroca(opts: { cardStatus: string; orderStatus: string; irmaos?: any[] }) {
  const ordem: string[] = [];
  const card = { id: 'card-1', status: opts.cardStatus, storeId: 'store-05', store: { code: '05', name: 'PIRACICABA' } };
  const order = {
    id: 'order-1',
    wcOrderId: 950001312,
    wcOrderNumber: 'LP-001312',
    status: opts.orderStatus,
    customerCpf: '12345678901',
    checkoutInfo: '{}',
    pickOrders: [card, ...(opts.irmaos ?? [])],
  };
  const item = {
    id: 'item-1',
    orderId: 'order-1',
    sku: SKU_VELHO,
    productName: 'SMILE · PRETO 58',
    quantity: 1,
    unitPrice: 79.9,
    assignedStoreId: 'store-05',
  };

  const tx = {
    orderItem: {
      update: jest.fn().mockImplementation(async () => {
        ordem.push('reescreve-sku');
      }),
      findMany: jest.fn().mockResolvedValue([{ ...item, sku: SKU_NOVO }]),
    },
    orderItemSwap: { create: jest.fn().mockResolvedValue({ id: 'swap-1', motivo: null }) },
    order: { update: jest.fn().mockResolvedValue({}) },
    orderHistory: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma: any = {
    order: { findFirst: jest.fn().mockResolvedValue(order) },
    orderItem: { findUnique: jest.fn().mockResolvedValue(item) },
    pickOrderScan: { findMany: jest.fn().mockResolvedValue([]) },
    nfeDoc: { findFirst: jest.fn().mockResolvedValue(null) },
    realignmentShipment: { findFirst: jest.fn().mockResolvedValue(null) },
    pickOrder: { count: jest.fn().mockResolvedValue(0) },
    integrationLog: { create: jest.fn().mockResolvedValue({}) },
    orderHistory: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(tx)),
  };
  const catalog: any = {
    getPdvProductInfo: jest.fn().mockResolvedValue({
      sku: SKU_NOVO,
      preco: 79.9,
      ref: 'SMILE',
      descricao: 'BLUSA MANGA CURTA',
      cor: 'PRETO',
      tamanho: '52',
    }),
  };
  const promo: any = { porChave: jest.fn().mockResolvedValue(null), ligada: true, precoComDesconto: (v: number) => v };
  const routing: any = {
    estornarCardDaTroca: jest.fn().mockImplementation(async () => {
      ordem.push('estorna-card');
      return { pecas: 2, escopo: 'card-inteiro', statusAnterior: opts.cardStatus, envioDesfeito: true };
    }),
    swapSinglePickOrder: jest.fn().mockImplementation(async () => {
      ordem.push('re-roteia-card');
      return { ok: true, pickOrders: [] };
    }),
    recalculateForWc: jest.fn().mockImplementation(async () => {
      ordem.push('recalcula-pedido');
      return { ok: true };
    }),
  };
  const svc = new TrocaPecaService(prisma, catalog, {} as any, {} as any, promo, routing);
  (svc as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { svc, ordem, routing, tx };
}

const MATRIZ = { role: 'admin', nome: 'Thiago' };
const pedirTroca = (forcar: boolean) => ({
  orderItemId: 'item-1',
  codigo: SKU_NOVO,
  diferenca: 0,
  ...(forcar ? { forcar: true, motivoDestrave: 'rastreio carimbado por engano, peça na arara' } : {}),
});

/** O pedido voltou pra separação dentro da transação da troca? */
const reabriuNaTransacao = (tx: any) =>
  tx.order.update.mock.calls.some((c: any[]) => c[0]?.data?.status === 'separating');

describe('troca de peça — o estorno sai ANTES de reescrever o SKU', () => {
  test('card POSTADO aberto pela chave: estorna (desfazendo o envio), reescreve e re-roteia — nessa ordem', async () => {
    const { svc, ordem, routing, tx } = montarTroca({ cardStatus: 'shipped', orderStatus: 'shipped' });
    const r = await svc.aplicar(950001312, pedirTroca(true), 'user-1', MATRIZ);

    expect(ordem).toEqual(['estorna-card', 'reescreve-sku', 're-roteia-card']);
    expect(routing.estornarCardDaTroca).toHaveBeenCalledWith('card-1', expect.objectContaining({ desfazerEnvio: true }));
    // A loja do card continua na disputa: as outras peças estão na arara dela.
    expect(routing.swapSinglePickOrder).toHaveBeenCalledWith(
      'card-1',
      expect.objectContaining({ manterLojaDeOrigem: true }),
    );
    expect(r.destravado).toMatch(/PIRACICABA já postou/);
    // Sem reabrir, o `confirmRoute` recusaria a separação nova (pedido `shipped`).
    expect(r.pedidoReaberto).toBe(true);
    expect(reabriuNaTransacao(tx)).toBe(true);
  });

  test('card SEPARADO (troca liberada desde 26/08) também estorna antes — era o mesmo bug, sem chave', async () => {
    const { svc, ordem, routing, tx } = montarTroca({ cardStatus: 'separated', orderStatus: 'separating' });
    const r = await svc.aplicar(950001312, pedirTroca(false), 'user-1', MATRIZ);

    expect(ordem).toEqual(['estorna-card', 'reescreve-sku', 're-roteia-card']);
    expect(routing.estornarCardDaTroca).toHaveBeenCalledWith('card-1', expect.objectContaining({ desfazerEnvio: false }));
    expect(r.pedidoReaberto).toBe(false);
    expect(reabriuNaTransacao(tx)).toBe(false);
  });

  test('sem a chave, card postado continua travado — nada é estornado nem reescrito', async () => {
    const { svc, routing, tx } = montarTroca({ cardStatus: 'shipped', orderStatus: 'shipped' });
    await expect(svc.aplicar(950001312, pedirTroca(false), 'user-1', MATRIZ)).rejects.toThrow(/já postou/);
    expect(routing.estornarCardDaTroca).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  test('vendedora não gira a chave — nada é estornado nem reescrito', async () => {
    const { svc, routing, tx } = montarTroca({ cardStatus: 'shipped', orderStatus: 'shipped' });
    await expect(
      svc.aplicar(950001312, pedirTroca(true), 'user-2', { role: 'store', nome: 'Vendedora' }),
    ).rejects.toThrow(/matriz/i);
    expect(routing.estornarCardDaTroca).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  test('card ENTREGUE: a chave troca a peça, mas não estorna nem apaga o card (a peça está com a cliente)', async () => {
    const { svc, ordem, routing } = montarTroca({ cardStatus: 'delivered', orderStatus: 'delivered' });
    await svc.aplicar(950001312, pedirTroca(true), 'user-1', MATRIZ);

    expect(routing.estornarCardDaTroca).not.toHaveBeenCalled();
    expect(routing.swapSinglePickOrder).not.toHaveBeenCalled();
    expect(ordem).toEqual(['reescreve-sku', 'recalcula-pedido']);
  });

  test('pedido "enviado" com o card já fora do shipped (⇄ Status + nota cancelada): reabre SEM chave', async () => {
    const { svc, ordem, tx } = montarTroca({ cardStatus: 'separated', orderStatus: 'shipped' });
    const r = await svc.aplicar(950001312, pedirTroca(false), 'user-1', MATRIZ);

    expect(r.destravado).toBeNull();
    expect(r.pedidoReaberto).toBe(true);
    expect(reabriuNaTransacao(tx)).toBe(true);
    expect(ordem).toEqual(['estorna-card', 'reescreve-sku', 're-roteia-card']);
  });

  test('pedido dividido com OUTRA caixa de verdade na rua: o shipped é verdade e não reabre', async () => {
    const { svc, tx } = montarTroca({
      cardStatus: 'separated',
      orderStatus: 'shipped',
      irmaos: [{ id: 'card-2', status: 'shipped', storeId: 'store-06', store: { code: '06', name: 'SOROCABA' } }],
    });
    const r = await svc.aplicar(950001312, pedirTroca(false), 'user-1', MATRIZ);

    expect(r.pedidoReaberto).toBe(false);
    expect(reabriuNaTransacao(tx)).toBe(false);
  });
});

describe('RoutingService.estornarCardDaTroca', () => {
  function montarRouting(status: string, opts?: { estornoFalha?: boolean }) {
    const ordem: string[] = [];
    const svc = Object.create(RoutingService.prototype) as RoutingService;
    const prisma: any = {
      pickOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'card-1',
          status,
          orderId: 'order-1',
          trackingCode: 'AD902944926BR',
          store: { code: '05', name: 'PIRACICABA' },
        }),
        update: jest.fn().mockImplementation(async ({ data }: any) => {
          ordem.push(`status:${data.status}`);
        }),
      },
      orderHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    const pickScans: any = {
      revertPickOrderStock: jest.fn().mockImplementation(async () => {
        ordem.push('estorno');
        if (opts?.estornoFalha) throw new Error('lock timeout');
        return { pecas: 2, escopo: 'card-inteiro' };
      }),
    };
    (svc as any).prisma = prisma;
    (svc as any).pickScans = pickScans;
    (svc as any).logger = { log: jest.fn(), warn: jest.fn() };
    return { svc, ordem, prisma, pickScans };
  }

  test('card postado + chave: sai do "enviado" ANTES do estorno (senão o estorno se recusa) e registra na história', async () => {
    const { svc, ordem, prisma } = montarRouting('shipped');
    const r = await svc.estornarCardDaTroca('card-1', { desfazerEnvio: true, nome: 'Thiago', motivo: 'peça na arara' });

    expect(ordem).toEqual(['status:separated', 'estorno']);
    expect(r).toEqual(expect.objectContaining({ pecas: 2, envioDesfeito: true, statusAnterior: 'shipped' }));
    const nota = prisma.orderHistory.create.mock.calls[0][0].data.note;
    expect(nota).toContain('AD902944926BR');
    expect(nota).toContain('Thiago');
  });

  test('card postado SEM a chave: não mexe em nada', async () => {
    const { svc, ordem } = montarRouting('shipped');
    const r = await svc.estornarCardDaTroca('card-1', { desfazerEnvio: false });
    expect(ordem).toEqual([]);
    expect(r.pecas).toBe(0);
  });

  test('card entregue: nunca estorna — a peça está com a cliente', async () => {
    const { svc, ordem } = montarRouting('delivered');
    const r = await svc.estornarCardDaTroca('card-1', { desfazerEnvio: true });
    expect(ordem).toEqual([]);
    expect(r.envioDesfeito).toBe(false);
  });

  test('card separado: só estorna, sem mexer no status', async () => {
    const { svc, ordem } = montarRouting('separated');
    await svc.estornarCardDaTroca('card-1', { desfazerEnvio: false });
    expect(ordem).toEqual(['estorno']);
  });

  test('estorno falhou: o card volta pro "enviado" e o erro SOBE', async () => {
    const { svc, ordem } = montarRouting('shipped', { estornoFalha: true });
    await expect(svc.estornarCardDaTroca('card-1', { desfazerEnvio: true })).rejects.toThrow('lock timeout');
    expect(ordem).toEqual(['status:separated', 'estorno', 'status:shipped']);
  });
});
