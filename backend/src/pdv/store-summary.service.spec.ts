import { PdvStoreSummaryService } from './store-summary.service';

describe('PdvStoreSummaryService', () => {
  function setup(input?: { sold?: number | null; returned?: number | null; stock?: number | string | null }) {
    const prisma = {
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
});
