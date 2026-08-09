import { PdvStoreSummaryService } from './store-summary.service';

describe('PdvStoreSummaryService', () => {
  function setup(input?: {
    sold?: number | null;
    returned?: number | null;
    stock?: number | string | null;
    sales?: any[];
  }) {
    const prisma = {
      pdvSale: {
        findMany: jest.fn().mockResolvedValue(input?.sales || []),
      },
      pdvSaleItem: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { qty: input?.sold === undefined ? 12 : input.sold } }),
      },
      pdvReturnItem: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { qty: input?.returned === undefined ? 3 : input.returned } }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ qty: input?.stock === undefined ? '1450' : input.stock }]),
    };
    return { prisma, service: new PdvStoreSummaryService(prisma as any) };
  }

  it('calcula peças vendidas líquidas e estoque atual no dia de São Paulo', async () => {
    const { prisma, service } = setup();
    const result = await service.getSummary('1', new Date('2026-08-08T21:30:00.000Z'));

    expect(result).toEqual(expect.objectContaining({
      storeCode: '01',
      soldTodayQty: 12,
      returnedTodayQty: 3,
      netSoldTodayQty: 9,
      stockQty: 1450,
      sellerRanking: [],
    }));
    expect(result.updatedAt).toEqual(expect.any(String));

    expect(prisma.pdvSaleItem.aggregate).toHaveBeenCalledWith({
      where: {
        sale: {
          storeCode: { in: ['01', '1'] },
          status: 'finalized',
          isTraining: false,
          finalizedAt: {
            gte: new Date('2026-08-08T03:00:00.000Z'),
            lte: new Date('2026-08-09T02:59:59.999Z'),
          },
        },
      },
      _sum: { qty: true },
    });
    expect(prisma.pdvReturnItem.aggregate).toHaveBeenCalledWith({
      where: {
        return: {
          storeCode: { in: ['01', '1'] },
          isTraining: false,
          createdAt: {
            gte: new Date('2026-08-08T03:00:00.000Z'),
            lte: new Date('2026-08-09T02:59:59.999Z'),
          },
        },
      },
      _sum: { qty: true },
    });
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('e.estoque > 0'),
      '01',
    );
  });

  it('preserva resultado líquido negativo e trata agregados vazios como zero', async () => {
    const { service } = setup({ sold: 2, returned: 5, stock: null });
    const result = await service.getSummary('LJ07', new Date('2026-08-08T12:00:00.000Z'));

    expect(result).toEqual(expect.objectContaining({
      storeCode: '07',
      soldTodayQty: 2,
      returnedTodayQty: 5,
      netSoldTodayQty: -3,
      stockQty: 0,
    }));
  });

  it('atribui a troca a vendedora da venda atual e ranqueia pelo valor liquido', async () => {
    const { prisma, service } = setup({
      sales: [
        {
          sellerId: 'maria', sellerName: 'Maria', vendedorName: null,
          total: 1050, paymentMethod: 'credito',
          items: [
            { ref: 'VESTIDO', sku: '101', total: 1000 },
            { ref: 'FRETE', sku: 'FRETE', total: 50 },
          ],
          payments: [
            { method: 'vale_troca', valor: 900 },
            { method: 'credito', valor: 150 },
          ],
        },
        {
          sellerId: 'maria', sellerName: 'Maria', vendedorName: null,
          total: 200, paymentMethod: 'pix',
          items: [{ ref: 'BLUSA', sku: '102', total: 200 }],
          payments: [{ method: 'pix', valor: 200 }],
        },
        {
          sellerId: 'ana', sellerName: 'Ana', vendedorName: null,
          total: 500, paymentMethod: 'dinheiro',
          items: [{ ref: 'CALCA', sku: '103', total: 500 }],
          payments: [
            { method: 'vale_troca', valor: 100 },
            { method: 'dinheiro', valor: 400 },
          ],
        },
        {
          sellerId: 'ignorar', sellerName: 'Marcados', vendedorName: null,
          total: 999, paymentMethod: 'MARCADO', items: [], payments: [],
        },
      ],
    });

    const result = await service.getSummary('01', new Date('2026-08-08T21:30:00.000Z'));

    expect(result.sellerRanking).toEqual([
      {
        sellerName: 'Ana',
        grossSalesValue: 500,
        returnsAppliedValue: 100,
        netSalesValue: 400,
      },
      {
        sellerName: 'Maria',
        grossSalesValue: 1200,
        returnsAppliedValue: 900,
        netSalesValue: 300,
      },
    ]);
    expect(prisma.pdvSale.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        storeCode: { in: ['01', '1'] },
        status: 'finalized',
        isTraining: false,
      }),
    }));
  });

  it('contabiliza somente R$ 100 quando a venda atual e R$ 1.000 e o vale-troca e R$ 900', async () => {
    const { service } = setup({
      sales: [{
        sellerId: 'vendedora-atual',
        sellerName: 'Vendedora atual',
        vendedorName: null,
        total: 1000,
        paymentMethod: 'dinheiro',
        items: [{ ref: 'VESTIDO', sku: '301', total: 1000 }],
        payments: [
          { method: 'vale_troca', valor: 900 },
          { method: 'dinheiro', valor: 100 },
        ],
      }],
    });

    const result = await service.getSummary('01');

    expect(result.sellerRanking).toEqual([{
      sellerName: 'Vendedora atual',
      grossSalesValue: 1000,
      returnsAppliedValue: 900,
      netSalesValue: 100,
    }]);
  });

  it('usa a vendedora operadora como fallback e nunca deixa a venda liquida negativa', async () => {
    const { service } = setup({
      sales: [
        {
          sellerId: null, sellerName: null, vendedorName: 'Carla',
          total: 100, paymentMethod: 'pix',
          items: [{ ref: 'BLUSA', sku: '201', total: 100 }],
          payments: [{ method: 'vale_troca', valor: 150 }],
        },
        {
          sellerId: null, sellerName: null, vendedorName: null,
          total: 50, paymentMethod: 'dinheiro', items: [],
          payments: [{ method: 'dinheiro', valor: 50 }],
        },
      ],
    });

    const result = await service.getSummary('01');

    expect(result.sellerRanking).toEqual([
      {
        sellerName: 'Sem vendedora',
        grossSalesValue: 50,
        returnsAppliedValue: 0,
        netSalesValue: 50,
      },
      {
        sellerName: 'Carla',
        grossSalesValue: 100,
        returnsAppliedValue: 100,
        netSalesValue: 0,
      },
    ]);
  });
});
