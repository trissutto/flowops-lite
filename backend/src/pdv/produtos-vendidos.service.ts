import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ProdutosVendidosService — Relatório de produtos vendidos no PDV.
 *
 * Une PdvSaleItem (vendas) + PdvReturnItem (devoluções/trocas em NEGATIVO).
 * Ordenado por data desc. Pronto pra conciliação no fechamento do caixa.
 */

export interface ProdutosVendidosFilters {
  from?: string;
  to?: string;
  storeCode?: string;
  sellerName?: string;
  sku?: string;
  customerCpf?: string;
  customerName?: string;
  includeReturns?: boolean;
}

export interface LinhaVendida {
  tipo: 'venda' | 'devolucao';
  saleNumber: string | null;
  saleId: string;
  itemId: string | null;
  data: string;
  hora: string;
  sku: string;
  ref: string | null;
  cor: string | null;
  tamanho: string | null;
  descricao: string;
  qty: number;
  precoUnit: number;
  total: number;
  storeCode: string;
  storeName: string;
  sellerName: string | null;
  sellerOverride: boolean;       // true se item.sellerName !== null (foi editado)
  customerName: string | null;
  customerCpf: string | null;
  paymentMethod: string | null;
}

@Injectable()
export class ProdutosVendidosService {
  private readonly logger = new Logger(ProdutosVendidosService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getReport(filters: ProdutosVendidosFilters = {}) {
    try {
      return await this._getReportImpl(filters);
    } catch (e: any) {
      this.logger.error(
        `getReport falhou: ${e?.message}\nFilters: ${JSON.stringify(filters)}\nStack: ${e?.stack}`,
      );
      throw e;
    }
  }

  private async _getReportImpl(filters: ProdutosVendidosFilters = {}) {
    const includeReturns = filters.includeReturns !== false;
    const fromDate = filters.from
      ? new Date(filters.from + 'T00:00:00')
      : new Date(new Date().setHours(0, 0, 0, 0));
    const toDate = filters.to
      ? new Date(filters.to + 'T23:59:59')
      : new Date(new Date().setHours(23, 59, 59, 999));

    // ─── VENDAS ───────────────────────────────────────────────────────────
    // Estratégia: 2 passos
    //  1. Busca PdvSales finalizadas no período (filtro forte + simples)
    //  2. Carrega items das sales encontradas
    // Evita where aninhado complexo no PdvSaleItem.
    const saleListWhere: any = {
      status: 'finalized',
      finalizedAt: { gte: fromDate, lte: toDate },
    };
    if (filters.storeCode) saleListWhere.storeCode = filters.storeCode;
    if (filters.customerCpf) {
      const cpf = filters.customerCpf.replace(/\D/g, '');
      if (cpf.length === 11) saleListWhere.customerCpf = cpf;
    }
    if (filters.customerName) {
      saleListWhere.customerName = { contains: filters.customerName };
    }

    const sales = await (this.prisma as any).pdvSale.findMany({
      where: saleListWhere,
      select: {
        id: true,
        storeCode: true,
        storeName: true,
        sellerName: true,
        vendedorName: true,
        customerName: true,
        customerCpf: true,
        paymentMethod: true,
        // Valores reais da venda — usado pra conciliacao com pagamentos.
        // sale.total = subtotal - desconto (oque cliente pagou de fato).
        subtotal: true,
        desconto: true,
        total: true,
        finalizedAt: true,
        createdAt: true,
      },
      orderBy: { finalizedAt: 'desc' },
      take: 5000,
    });

    // Filtro de vendedora (em memória — mais seguro que OR aninhado no Prisma)
    const sellerQ = filters.sellerName?.trim().toUpperCase();
    const salesFiltered = sellerQ
      ? (sales as any[]).filter((s) => {
          const a = (s.sellerName || '').toUpperCase();
          const b = (s.vendedorName || '').toUpperCase();
          return a.includes(sellerQ) || b.includes(sellerQ);
        })
      : (sales as any[]);

    const saleIds = salesFiltered.map((s) => s.id);
    const saleMap = new Map<string, any>(salesFiltered.map((s) => [s.id, s]));

    // Buscar items dessas sales (com filtro de SKU se aplicável)
    let saleItems: any[] = [];
    if (saleIds.length > 0) {
      const itemWhere: any = { saleId: { in: saleIds } };
      if (filters.sku) {
        const q = filters.sku.trim();
        itemWhere.OR = [
          { sku: { contains: q } },
          { ref: { contains: q } },
          { ean: { contains: q } },
        ];
      }
      saleItems = await (this.prisma as any).pdvSaleItem.findMany({
        where: itemWhere,
        take: 10000,
      });
    }

    // ─── PAGAMENTOS (conciliacao por modalidade) ──────────────────────────
    let salePayments: any[] = [];
    if (saleIds.length > 0) {
      salePayments = await (this.prisma as any).pdvSalePayment.findMany({
        where: { saleId: { in: saleIds } },
        select: { method: true, valor: true, saleId: true },
      });
    }

    // ─── DEVOLUÇÕES ────────────────────────────────────────────────────────
    let returns: any[] = [];
    let returnItems: any[] = [];
    if (includeReturns) {
      const retWhere: any = {
        createdAt: { gte: fromDate, lte: toDate },
      };
      if (filters.storeCode) retWhere.storeCode = filters.storeCode;
      if (filters.customerCpf) {
        const cpf = filters.customerCpf.replace(/\D/g, '');
        if (cpf.length === 11) retWhere.customerCpf = cpf;
      }
      if (filters.customerName) {
        retWhere.customerName = { contains: filters.customerName };
      }

      returns = await (this.prisma as any).pdvReturn.findMany({
        where: retWhere,
        select: {
          id: true,
          originalSaleId: true,
          originalSaleNumber: true,
          storeCode: true,
          storeName: true,
          userName: true,
          customerName: true,
          customerCpf: true,
          modo: true,
          valorTotal: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 5000,
      });

      const returnsFiltered = sellerQ
        ? returns.filter((r: any) =>
            ((r.userName || '').toUpperCase()).includes(sellerQ),
          )
        : returns;

      const retIds = returnsFiltered.map((r: any) => r.id);
      const retMap = new Map<string, any>(returnsFiltered.map((r: any) => [r.id, r]));

      if (retIds.length > 0) {
        const retItemWhere: any = { returnId: { in: retIds } };
        if (filters.sku) {
          const q = filters.sku.trim();
          retItemWhere.OR = [
            { sku: { contains: q } },
            { ref: { contains: q } },
          ];
        }
        returnItems = await (this.prisma as any).pdvReturnItem.findMany({
          where: retItemWhere,
          take: 10000,
        });
      }
      returns = returnsFiltered;
      (returns as any).map = retMap;
    }

    // ─── NORMALIZA pro formato final ────────────────────────────────────────
    const linhas: LinhaVendida[] = [];

    for (const it of saleItems) {
      const sale = saleMap.get(it.saleId);
      if (!sale) continue;
      const dt = new Date(sale.finalizedAt || sale.createdAt);
      const itemSeller = it.sellerName as string | null | undefined;
      const saleSeller = sale.sellerName || sale.vendedorName || null;
      linhas.push({
        tipo: 'venda',
        saleNumber: String(sale.id).slice(0, 8),
        saleId: sale.id,
        itemId: it.id,
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
        storeCode: sale.storeCode,
        storeName: sale.storeName,
        sellerName: itemSeller || saleSeller,
        sellerOverride: !!itemSeller,
        customerName: sale.customerName,
        customerCpf: sale.customerCpf,
        paymentMethod: sale.paymentMethod,
      });
    }

    const retMap = (returns as any).map || new Map();
    for (const it of returnItems) {
      const ret = retMap.get(it.returnId);
      if (!ret) continue;
      const dt = new Date(ret.createdAt);
      linhas.push({
        tipo: 'devolucao',
        saleNumber: ret.originalSaleNumber
          ? `${ret.originalSaleNumber} (TROCA)`
          : '(TROCA MANUAL)',
        saleId: ret.id,
        itemId: null,
        sellerOverride: false,
        data: dt.toISOString(),
        hora: dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        sku: it.sku,
        ref: it.ref,
        cor: it.cor,
        tamanho: it.tamanho,
        descricao: it.descricao,
        qty: -Math.abs(it.qty),
        precoUnit: it.precoUnit,
        total: -Math.abs(it.total),
        storeCode: ret.storeCode,
        storeName: ret.storeName,
        sellerName: ret.userName,
        customerName: ret.customerName,
        customerCpf: ret.customerCpf,
        paymentMethod: `troca_${ret.modo || ''}`,
      });
    }

    // Ordena por data desc
    linhas.sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime());

    // Totais
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

    totais.vendasValor = Number(totais.vendasValor.toFixed(2));
    totais.devolucoesValor = Number(totais.devolucoesValor.toFixed(2));
    totais.liquidoValor = Number(totais.liquidoValor.toFixed(2));

    // ─── CONCILIACAO V2 ──────────────────────────────────────────────────
    // Modelo: cada venda tem Sum(itens) = Sum(pagamentos). No dia:
    //   Vendido (liquido) = Sum(itens vendidos) - Sum(itens devolvidos)
    //   Recebido = dinheiro + pix + credito + debito + crediario + vale_troca
    //   Diferenca = Vendido - Recebido  (deve ser ~0)
    //
    // vale_troca aplicado em venda nova NAO eh dinheiro novo entrando, mas
    // ABATE do que falta receber — entao entra como modalidade de "recebimento".
    //
    // Methods desconhecidos vao pra "outros" + listados em `outrosDetalhe`
    // pra diagnostico (deveria ser sempre VAZIO em producao limpa).
    const porModalidade: Record<string, number> = {
      dinheiro: 0,
      pix: 0,
      credito: 0,
      debito: 0,
      crediario: 0,
      vale_troca: 0,
      outros: 0,
    };
    // Mapa de aliases — qualquer variacao do nome cai na modalidade canonica.
    const ALIASES: Record<string, keyof typeof porModalidade> = {
      dinheiro: 'dinheiro', cash: 'dinheiro', money: 'dinheiro',
      pix: 'pix',
      credito: 'credito', 'cartao_credito': 'credito', credit: 'credito',
      debito: 'debito', 'cartao_debito': 'debito', debit: 'debito',
      crediario: 'crediario', fiado: 'crediario',
      vale_troca: 'vale_troca', vale: 'vale_troca', troca: 'vale_troca',
      'troca_credito': 'vale_troca', 'troca_dinheiro': 'vale_troca',
    };
    // Coleta os methods desconhecidos pra debug
    const outrosDetalhe: Array<{ method: string; valor: number; saleId: string }> = [];
    for (const p of salePayments) {
      const mRaw = String(p.method || '').toLowerCase().trim();
      const v = Number(p.valor || 0);
      const target = ALIASES[mRaw];
      if (target) {
        porModalidade[target] += v;
      } else {
        porModalidade.outros += v;
        outrosDetalhe.push({ method: mRaw || '(vazio)', valor: v, saleId: p.saleId });
      }
    }
    for (const k of Object.keys(porModalidade)) {
      porModalidade[k] = Number(porModalidade[k].toFixed(2));
    }

    const totalRecebido = Number(
      (
        porModalidade.dinheiro +
        porModalidade.pix +
        porModalidade.credito +
        porModalidade.debito +
        porModalidade.crediario +
        porModalidade.vale_troca
      ).toFixed(2),
    );
    const totalVendidoLiquido = totais.liquidoValor;

    const diferenca = Number(
      (totalVendidoLiquido - totalRecebido).toFixed(2),
    );

    // ─── DIAGNOSTICO POR VENDA — sale.total deve = Σpagamentos ──────────
    // Usa sale.total (subtotal - desconto), nao a soma dos items.
    // Se diferir, eh bug (payments parciais nao cobertos).
    const paymentsBySale = new Map<string, number>();
    for (const p of salePayments) {
      const s = paymentsBySale.get(p.saleId) || 0;
      paymentsBySale.set(p.saleId, s + Number(p.valor || 0));
    }
    const vendasComDivergencia: Array<{
      saleId: string;
      saleNumber: string;
      subtotal: number;
      desconto: number;
      total: number;
      somaPagamentos: number;
      diferenca: number;
    }> = [];
    let totalDescontosAplicados = 0;
    let totalVendasReais = 0;       // soma de sale.total (descontado)
    let totalSubtotal = 0;          // soma de sale.subtotal (sem desconto)
    for (const sale of salesFiltered) {
      const subt = Number(sale.subtotal || 0);
      const desc = Number(sale.desconto || 0);
      const tot = Number(sale.total || 0);
      totalSubtotal += subt;
      totalVendasReais += tot;
      totalDescontosAplicados += desc;
      const somaPag = paymentsBySale.get(sale.id) || 0;
      const diff = Number((tot - somaPag).toFixed(2));
      if (Math.abs(diff) > 0.02) {
        vendasComDivergencia.push({
          saleId: sale.id,
          saleNumber: String(sale.id).slice(0, 8),
          subtotal: Number(subt.toFixed(2)),
          desconto: Number(desc.toFixed(2)),
          total: Number(tot.toFixed(2)),
          somaPagamentos: Number(somaPag.toFixed(2)),
          diferenca: diff,
        });
      }
    }
    totalVendasReais = Number(totalVendasReais.toFixed(2));
    totalSubtotal = Number(totalSubtotal.toFixed(2));
    totalDescontosAplicados = Number(totalDescontosAplicados.toFixed(2));

    // ─── DIAGNOSTICO DEVOLUCOES — origem (data da venda original) ──────────
    // Cada devolucao do periodo tem originalSaleId. Buscamos a data da venda
    // original pra saber se ela foi feita NO MESMO periodo (afeta vendido_liquido)
    // ou em outro dia (eh sangria pura — nao deveria reduzir vendido_liquido).
    const devolucoesDiagnostico: Array<{
      returnId: string;
      originalSaleId: string | null;
      originalSaleDate: string | null;
      originalSaleInPeriod: boolean;
      modo: string;
      valor: number;
      data: string;
      customerName: string | null;
    }> = [];
    let devolucoesDeVendaDoPeriodo = 0;     // ja foi descontado corretamente do liquido
    let devolucoesDeVendaAntiga = 0;         // SAIDA do caixa mas nao afeta vendido
    if (includeReturns && returns.length > 0) {
      const origIds = (returns as any[])
        .map((r) => r.originalSaleId)
        .filter(Boolean);
      const origSales = origIds.length > 0
        ? await (this.prisma as any).pdvSale.findMany({
            where: { id: { in: origIds } },
            select: { id: true, finalizedAt: true, createdAt: true },
          })
        : [];
      const origMap = new Map<string, any>(origSales.map((s: any) => [s.id, s]));
      const saleIdsSet = new Set(saleIds);
      for (const r of returns as any[]) {
        const orig = r.originalSaleId ? origMap.get(r.originalSaleId) : null;
        const inPeriod = r.originalSaleId ? saleIdsSet.has(r.originalSaleId) : false;
        const valor = Number(r.valorTotal || 0);
        if (inPeriod) devolucoesDeVendaDoPeriodo += valor;
        else devolucoesDeVendaAntiga += valor;
        devolucoesDiagnostico.push({
          returnId: r.id,
          originalSaleId: r.originalSaleId || null,
          originalSaleDate: orig?.finalizedAt
            ? new Date(orig.finalizedAt).toISOString()
            : orig?.createdAt
            ? new Date(orig.createdAt).toISOString()
            : null,
          originalSaleInPeriod: inPeriod,
          modo: String(r.modo || ''),
          valor: Number(valor.toFixed(2)),
          data: new Date(r.createdAt).toISOString(),
          customerName: r.customerName || null,
        });
      }
    }
    devolucoesDeVendaDoPeriodo = Number(devolucoesDeVendaDoPeriodo.toFixed(2));
    devolucoesDeVendaAntiga = Number(devolucoesDeVendaAntiga.toFixed(2));

    // CONCILIACAO V3: usa sale.total (com desconto) vs payments.
    // Vale-troca payments contam como "abate" (nao dinheiro novo).
    const recebidoEmDinheiro = Number(
      (
        porModalidade.dinheiro +
        porModalidade.pix +
        porModalidade.credito +
        porModalidade.debito +
        porModalidade.crediario
      ).toFixed(2),
    );
    const recebidoComVale = Number(
      (recebidoEmDinheiro + porModalidade.vale_troca).toFixed(2),
    );
    // Conciliacao correta: sale.total = sum(payments) por venda.
    // Diferenca global = totalVendasReais - recebidoComVale (deve ser 0).
    const diferencaV3 = Number(
      (totalVendasReais - recebidoComVale).toFixed(2),
    );

    return {
      linhas,
      totais,
      conciliacao: {
        // V3 — novos campos
        totalVendasReais,           // sum(sale.total) — base correta de comparacao
        totalSubtotal,              // sum(sale.subtotal) — antes do desconto
        totalDescontosAplicados,    // sum(sale.desconto)
        recebidoEmDinheiro,         // dinheiro + pix + cartoes + crediario (dinheiro real)
        recebidoComVale,            // + vale_troca aplicado
        diferencaV3,                // totalVendasReais - recebidoComVale (deve ser ~0)
        okV3: Math.abs(diferencaV3) < 0.02,
        // Diagnostico devolucoes
        devolucoesDiagnostico: devolucoesDiagnostico.slice(0, 50),
        devolucoesDeVendaDoPeriodo,
        devolucoesDeVendaAntiga,

        // V2 (mantidos pra compat — vamos descomissionar depois)
        totalVendidoLiquido,
        totalRecebido,
        diferenca,
        ok: Math.abs(diferenca) < 0.02,
        porModalidade,
        outrosDetalhe: outrosDetalhe.slice(0, 20),
        vendasComDivergencia: vendasComDivergencia.slice(0, 30),
        // legacy
        totalProdutosVendidos: totalVendidoLiquido,
      },
      filtros: filters,
    };
  }
}
