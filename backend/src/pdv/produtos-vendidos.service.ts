import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ProdutosVendidosService — Relatório de produtos vendidos no PDV.
 *
 * Une 2 fontes:
 *   • PdvSaleItem (vendas) — qty positiva, total positivo
 *   • PdvReturnItem (devoluções/trocas) — qty NEGATIVA, total NEGATIVO
 *
 * Retorna uma linha por movimentação, ordenada por data desc, pronta pra
 * conciliação visual: vendas em preto, trocas em vermelho.
 */

export interface ProdutosVendidosFilters {
  from?: string;            // ISO date YYYY-MM-DD
  to?: string;              // ISO date YYYY-MM-DD
  storeCode?: string;       // código da loja
  sellerName?: string;      // nome da vendedora (LIKE)
  sku?: string;             // SKU/REF/EAN (busca múltipla)
  customerCpf?: string;
  customerName?: string;
  includeReturns?: boolean; // default true (true = inclui trocas/devoluções)
}

export interface LinhaVendida {
  tipo: 'venda' | 'devolucao';
  saleNumber: string | null;     // número da venda
  saleId: string;                 // id da venda (ou return)
  data: string;                   // ISO date
  hora: string;                   // HH:MM
  sku: string;
  ref: string | null;
  cor: string | null;
  tamanho: string | null;
  descricao: string;
  qty: number;                    // negativo se devolução
  precoUnit: number;
  total: number;                  // negativo se devolução
  storeCode: string;
  storeName: string;
  sellerName: string | null;
  customerName: string | null;
  customerCpf: string | null;
  paymentMethod: string | null;
}

@Injectable()
export class ProdutosVendidosService {
  private readonly logger = new Logger(ProdutosVendidosService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getReport(filters: ProdutosVendidosFilters = {}): Promise<{
    linhas: LinhaVendida[];
    totais: {
      vendasQtd: number;
      vendasValor: number;
      devolucoesQtd: number;
      devolucoesValor: number;
      liquidoQtd: number;
      liquidoValor: number;
    };
    filtros: ProdutosVendidosFilters;
  }> {
    const includeReturns = filters.includeReturns !== false;

    // Janela de data
    const fromDate = filters.from
      ? new Date(filters.from + 'T00:00:00')
      : new Date(new Date().setHours(0, 0, 0, 0));
    const toDate = filters.to
      ? new Date(filters.to + 'T23:59:59')
      : new Date(new Date().setHours(23, 59, 59, 999));

    // ── 1) Vendas (PdvSaleItem joined com PdvSale finalizada) ──
    const saleWhere: any = {
      sale: {
        status: 'finalized',
        finalizedAt: { gte: fromDate, lte: toDate },
      },
    };
    if (filters.storeCode) saleWhere.sale.storeCode = filters.storeCode;
    if (filters.sellerName) {
      saleWhere.sale.OR = [
        { sellerName: { contains: filters.sellerName, mode: 'insensitive' } },
        { vendedorName: { contains: filters.sellerName, mode: 'insensitive' } },
      ];
    }
    if (filters.customerCpf) saleWhere.sale.customerCpf = filters.customerCpf.replace(/\D/g, '');
    if (filters.customerName) {
      saleWhere.sale.customerName = { contains: filters.customerName, mode: 'insensitive' };
    }
    if (filters.sku) {
      const q = filters.sku.trim();
      saleWhere.OR = [
        { sku: { contains: q, mode: 'insensitive' } },
        { ref: { contains: q, mode: 'insensitive' } },
        { ean: { contains: q, mode: 'insensitive' } },
      ];
    }

    const saleItems = await (this.prisma as any).pdvSaleItem.findMany({
      where: saleWhere,
      include: {
        sale: {
          select: {
            id: true,
            saleNumber: true,
            storeCode: true,
            storeName: true,
            sellerName: true,
            vendedorName: true,
            customerName: true,
            customerCpf: true,
            paymentMethod: true,
            finalizedAt: true,
          },
        },
      },
      orderBy: { sale: { finalizedAt: 'desc' } },
      take: 5000,
    });

    // ── 2) Devoluções (PdvReturnItem joined com PdvReturn) ──
    let returnItems: any[] = [];
    if (includeReturns) {
      const retWhere: any = {
        return: {
          createdAt: { gte: fromDate, lte: toDate },
        },
      };
      if (filters.storeCode) retWhere.return.storeCode = filters.storeCode;
      if (filters.sellerName) {
        retWhere.return.userName = { contains: filters.sellerName, mode: 'insensitive' };
      }
      if (filters.customerCpf) {
        retWhere.return.customerCpf = filters.customerCpf.replace(/\D/g, '');
      }
      if (filters.customerName) {
        retWhere.return.customerName = { contains: filters.customerName, mode: 'insensitive' };
      }
      if (filters.sku) {
        const q = filters.sku.trim();
        retWhere.OR = [
          { sku: { contains: q, mode: 'insensitive' } },
          { ref: { contains: q, mode: 'insensitive' } },
        ];
      }

      returnItems = await (this.prisma as any).pdvReturnItem.findMany({
        where: retWhere,
        include: {
          return: {
            select: {
              id: true,
              originalSaleNumber: true,
              storeCode: true,
              storeName: true,
              userName: true,
              customerName: true,
              customerCpf: true,
              modo: true,
              createdAt: true,
            },
          },
        },
        orderBy: { return: { createdAt: 'desc' } },
        take: 5000,
      });
    }

    // ── 3) Normaliza pro formato LinhaVendida ──
    const linhas: LinhaVendida[] = [];

    for (const it of saleItems) {
      const dt = new Date(it.sale.finalizedAt);
      linhas.push({
        tipo: 'venda',
        saleNumber: it.sale.saleNumber || it.sale.id.slice(0, 8),
        saleId: it.sale.id,
        data: dt.toISOString(),
        hora: dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        sku: it.sku,
        ref: it.ref,
        cor: it.cor,
        tamanho: it.tamanho,
        descricao: it.descricao,
        qty: it.qty,
        precoUnit: it.precoUnit,
        total: it.total,
        storeCode: it.sale.storeCode,
        storeName: it.sale.storeName,
        sellerName: it.sale.sellerName || it.sale.vendedorName,
        customerName: it.sale.customerName,
        customerCpf: it.sale.customerCpf,
        paymentMethod: it.sale.paymentMethod,
      });
    }

    for (const it of returnItems) {
      const dt = new Date(it.return.createdAt);
      linhas.push({
        tipo: 'devolucao',
        saleNumber: it.return.originalSaleNumber
          ? `${it.return.originalSaleNumber} (TROCA)`
          : '(TROCA MANUAL)',
        saleId: it.return.id,
        data: dt.toISOString(),
        hora: dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        sku: it.sku,
        ref: it.ref,
        cor: it.cor,
        tamanho: it.tamanho,
        descricao: it.descricao,
        // Devolução: qty e total NEGATIVOS
        qty: -Math.abs(it.qty),
        precoUnit: it.precoUnit,
        total: -Math.abs(it.total),
        storeCode: it.return.storeCode,
        storeName: it.return.storeName,
        sellerName: it.return.userName,
        customerName: it.return.customerName,
        customerCpf: it.return.customerCpf,
        paymentMethod: `troca_${it.return.modo}`,
      });
    }

    // ── 4) Ordena por data desc ──
    linhas.sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime());

    // ── 5) Totais ──
    const totais = {
      vendasQtd: 0,
      vendasValor: 0,
      devolucoesQtd: 0,
      devolucoesValor: 0,
      liquidoQtd: 0,
      liquidoValor: 0,
    };

    for (const l of linhas) {
      if (l.tipo === 'venda') {
        totais.vendasQtd += l.qty;
        totais.vendasValor += l.total;
      } else {
        totais.devolucoesQtd += Math.abs(l.qty);
        totais.devolucoesValor += Math.abs(l.total);
      }
    }
    totais.liquidoQtd = totais.vendasQtd - totais.devolucoesQtd;
    totais.liquidoValor = totais.vendasValor - totais.devolucoesValor;

    // Round pra 2 casas
    totais.vendasValor = Number(totais.vendasValor.toFixed(2));
    totais.devolucoesValor = Number(totais.devolucoesValor.toFixed(2));
    totais.liquidoValor = Number(totais.liquidoValor.toFixed(2));

    return { linhas, totais, filtros: filters };
  }
}
