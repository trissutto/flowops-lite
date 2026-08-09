import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { endOfDayBR, startOfDayBR } from '../lib/date-br';

export type PdvStoreSummary = {
  storeCode: string;
  soldTodayQty: number;
  returnedTodayQty: number;
  netSoldTodayQty: number;
  stockQty: number;
  sellerRanking: PdvSellerRankingRow[];
  updatedAt: string;
};

export type PdvSellerRankingRow = {
  sellerName: string;
  grossSalesValue: number;
  returnsAppliedValue: number;
  netSalesValue: number;
};

export function normalizePdvSummaryStoreCode(raw: unknown): string {
  const digits = String(raw ?? '').trim().toUpperCase().replace(/^LJ/, '').replace(/\D/g, '');
  return digits ? digits.padStart(2, '0').slice(-2) : '';
}

function storeCodeCandidates(normalized: string): string[] {
  const withoutPadding = normalized.replace(/^0+/, '') || '0';
  return Array.from(new Set([normalized, withoutPadding]));
}

function moneyToCents(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function isFreightItem(item: { ref?: unknown; sku?: unknown }): boolean {
  return [item.ref, item.sku].some((value) => String(value ?? '').trim().toUpperCase() === 'FRETE');
}

function buildSellerRanking(sales: any[]): PdvSellerRankingRow[] {
  const grouped = new Map<string, {
    sellerName: string;
    grossSalesCents: number;
    returnsAppliedCents: number;
    netSalesCents: number;
  }>();

  for (const sale of sales || []) {
    if (String(sale?.paymentMethod || '').trim().toUpperCase() === 'MARCADO') continue;

    const sellerName = String(sale?.sellerName || sale?.vendedorName || '').trim() || 'Sem vendedora';
    const sellerKey = sale?.sellerId
      ? `id:${sale.sellerId}`
      : `name:${sellerName.toLocaleUpperCase('pt-BR')}`;
    const freightCents = (sale?.items || [])
      .filter(isFreightItem)
      .reduce((total: number, item: any) => total + moneyToCents(item?.total), 0);
    const grossSalesCents = Math.max(0, moneyToCents(sale?.total) - freightCents);
    const valeTrocaCents = (sale?.payments || [])
      .filter((payment: any) => String(payment?.method || '').trim().toLowerCase() === 'vale_troca')
      .reduce((total: number, payment: any) => total + Math.max(0, moneyToCents(payment?.valor)), 0);
    const returnsAppliedCents = Math.min(grossSalesCents, valeTrocaCents);
    const netSalesCents = grossSalesCents - returnsAppliedCents;
    const current = grouped.get(sellerKey) || {
      sellerName,
      grossSalesCents: 0,
      returnsAppliedCents: 0,
      netSalesCents: 0,
    };

    current.grossSalesCents += grossSalesCents;
    current.returnsAppliedCents += returnsAppliedCents;
    current.netSalesCents += netSalesCents;
    grouped.set(sellerKey, current);
  }

  return Array.from(grouped.values())
    .sort((a, b) => (
      b.netSalesCents - a.netSalesCents
      || b.grossSalesCents - a.grossSalesCents
      || a.sellerName.localeCompare(b.sellerName, 'pt-BR')
    ))
    .map((row) => ({
      sellerName: row.sellerName,
      grossSalesValue: row.grossSalesCents / 100,
      returnsAppliedValue: row.returnsAppliedCents / 100,
      netSalesValue: row.netSalesCents / 100,
    }));
}

@Injectable()
export class PdvStoreSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(storeCode: string, now: Date = new Date()): Promise<PdvStoreSummary> {
    const normalizedStoreCode = normalizePdvSummaryStoreCode(storeCode);
    const candidates = storeCodeCandidates(normalizedStoreCode);
    const start = startOfDayBR(now);
    const end = endOfDayBR(now);

    const [salesAgg, returnsAgg, stockRows, sales] = await Promise.all([
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
      (this.prisma as any).pdvSale.findMany({
        where: {
          storeCode: { in: candidates },
          status: 'finalized',
          isTraining: false,
          finalizedAt: { gte: start, lte: end },
        },
        select: {
          sellerId: true,
          sellerName: true,
          vendedorName: true,
          total: true,
          paymentMethod: true,
          items: {
            select: {
              ref: true,
              sku: true,
              total: true,
            },
          },
          payments: {
            select: {
              method: true,
              valor: true,
            },
          },
        },
      }),
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
      sellerRanking: buildSellerRanking(sales),
      updatedAt: new Date().toISOString(),
    };
  }
}
