import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { endOfDayBR, startOfDayBR } from '../lib/date-br';

export type PdvStoreSummary = {
  storeCode: string;
  soldTodayQty: number;
  returnedTodayQty: number;
  netSoldTodayQty: number;
  stockQty: number;
  updatedAt: string;
};

export function normalizePdvSummaryStoreCode(raw: unknown): string {
  const digits = String(raw ?? '').trim().toUpperCase().replace(/^LJ/, '').replace(/\D/g, '');
  return digits ? digits.padStart(2, '0').slice(-2) : '';
}

function storeCodeCandidates(normalized: string): string[] {
  const withoutPadding = normalized.replace(/^0+/, '') || '0';
  return Array.from(new Set([normalized, withoutPadding]));
}

@Injectable()
export class PdvStoreSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(storeCode: string, now: Date = new Date()): Promise<PdvStoreSummary> {
    const normalizedStoreCode = normalizePdvSummaryStoreCode(storeCode);
    const candidates = storeCodeCandidates(normalizedStoreCode);
    const start = startOfDayBR(now);
    const end = endOfDayBR(now);

    const [salesAgg, returnsAgg, stockRows] = await Promise.all([
      (this.prisma as any).pdvSaleItem.aggregate({
        where: {
          sale: {
            storeCode: { in: candidates },
            status: 'finalized',
            isTraining: false,
            finalizedAt: { gte: start, lte: end },
          },
        },
        _sum: { qty: true },
      }),
      (this.prisma as any).pdvReturnItem.aggregate({
        where: {
          return: {
            storeCode: { in: candidates },
            isTraining: false,
            createdAt: { gte: start, lte: end },
          },
        },
        _sum: { qty: true },
      }),
      this.prisma.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(SUM(CASE WHEN e.estoque > 0 THEN e.estoque ELSE 0 END), 0)::bigint AS qty
           FROM wincred_estoque e
          WHERE LPAD(REPLACE(UPPER(TRIM(e.loja)), 'LJ', ''), 2, '0') = $1`,
        normalizedStoreCode,
      ),
    ]);

    const soldTodayQty = Number(salesAgg?._sum?.qty || 0);
    const returnedTodayQty = Number(returnsAgg?._sum?.qty || 0);
    const stockQty = Number(stockRows?.[0]?.qty || 0);

    return {
      storeCode: normalizedStoreCode,
      soldTodayQty,
      returnedTodayQty,
      netSoldTodayQty: soldTodayQty - returnedTodayQty,
      stockQty,
      updatedAt: new Date().toISOString(),
    };
  }
}
