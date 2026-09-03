import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';

/**
 * SiteSaidasReportService — Relatório de peças que cada LOJA cedeu pro SITE.
 *
 * Cenário: cliente compra no site (WooCommerce). Sistema atribui a separação
 * a uma loja (OrderItem.assignedStoreId). Quando o pedido é enviado (status
 * 'shipped' ou 'delivered'), a peça SAIU do estoque daquela loja.
 *
 * Esse relatório responde:
 *   "Quantas peças da REF X tamanho Y a loja Z cedeu pro site no período P?"
 *
 * Cruza:
 *   • OrderItem.assignedStoreId  ↔  Store.code
 *   • OrderItem.sku              ↔  Catálogo no Postgres (ref/cor/tamanho)
 *   • Order.wcDateCreated        →  período
 *   • Order.status               →  filtro de "efetivamente saiu" (shipped/delivered)
 */

export interface SiteSaidasFilters {
  storeCode?: string;          // ex: '11' (Limeira)
  ref?: string;                // ex: 'BRASIL ROYAL' (busca parcial)
  tamanho?: string;            // ex: '54'
  cor?: string;                // ex: 'AZUL'
  from?: string;               // ISO date 'YYYY-MM-DD'
  to?: string;                 // ISO date 'YYYY-MM-DD'
  status?: string[];           // default: ['shipped', 'delivered']
}

export interface SiteSaidaLinha {
  sku: string;
  ref: string | null;
  cor: string | null;
  tamanho: string | null;
  descricao: string | null;
  productName: string | null;
  storeCode: string;
  storeName: string;
  qtd: number;                 // quantidade total cedida
  valor: number;               // valor total em R$
  pedidos: number;             // qtd distinta de pedidos
  primeiraSaida: string;       // ISO
  ultimaSaida: string;         // ISO
}

@Injectable()
export class SiteSaidasReportService {
  private readonly logger = new Logger(SiteSaidasReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly purchaseOrders: PurchaseOrdersService,
  ) {}

  async getReport(filters: SiteSaidasFilters = {}): Promise<{
    linhas: SiteSaidaLinha[];
    totalGeralQtd: number;
    totalGeralValor: number;
    totalGeralPedidos: number;
    filtrosAplicados: SiteSaidasFilters;
  }> {
    const statusList = filters.status?.length
      ? filters.status
      : ['shipped', 'delivered'];

    // 1) Resolve storeId pelo storeCode (se filtro veio)
    let storeIdFilter: string | undefined;
    let storeCodeToName: Record<string, string> = {};
    if (filters.storeCode) {
      const store = await (this.prisma as any).store.findUnique({
        where: { code: filters.storeCode },
        select: { id: true, code: true, name: true },
      });
      if (store) {
        storeIdFilter = store.id;
        storeCodeToName[store.code] = store.name;
      } else {
        // Loja inexistente — retorna vazio
        return {
          linhas: [],
          totalGeralQtd: 0,
          totalGeralValor: 0,
          totalGeralPedidos: 0,
          filtrosAplicados: filters,
        };
      }
    }

    // 2) Busca OrderItems com assignedStore + pedido nos filtros de status/data
    const orderWhere: any = { status: { in: statusList } };
    if (filters.from || filters.to) {
      orderWhere.wcDateCreated = {};
      if (filters.from) orderWhere.wcDateCreated.gte = new Date(filters.from + 'T00:00:00');
      if (filters.to)   orderWhere.wcDateCreated.lte = new Date(filters.to + 'T23:59:59');
    }

    const items = await (this.prisma as any).orderItem.findMany({
      where: {
        assignedStoreId: storeIdFilter ?? { not: null },
        order: orderWhere,
      },
      select: {
        sku: true,
        productName: true,
        quantity: true,
        unitPrice: true,
        assignedStore: { select: { code: true, name: true } },
        order: { select: { id: true, wcDateCreated: true, createdAt: true } },
      },
    });

    this.logger.log(`[site-saidas] ${items.length} items brutos (storeCode=${filters.storeCode ?? 'todas'})`);

    // 3) Agrega por (sku + storeCode)
    type Agg = SiteSaidaLinha & { _orderIds: Set<string>; _firstTs: number; _lastTs: number };
    const map = new Map<string, Agg>();

    for (const it of items as any[]) {
      const sku = String(it.sku || '').trim();
      const storeCode = it.assignedStore?.code || '';
      const storeName = it.assignedStore?.name || '';
      if (!sku || !storeCode) continue;

      const key = `${sku}__${storeCode}`;
      const ts = (it.order?.wcDateCreated ?? it.order?.createdAt ?? new Date()).getTime();

      let agg = map.get(key);
      if (!agg) {
        agg = {
          sku,
          ref: null,
          cor: null,
          tamanho: null,
          descricao: null,
          productName: it.productName || null,
          storeCode,
          storeName,
          qtd: 0,
          valor: 0,
          pedidos: 0,
          primeiraSaida: '',
          ultimaSaida: '',
          _orderIds: new Set(),
          _firstTs: ts,
          _lastTs: ts,
        };
        map.set(key, agg);
      }
      agg.qtd += Number(it.quantity || 0);
      agg.valor += Number(it.unitPrice || 0) * Number(it.quantity || 0);
      agg._orderIds.add(it.order?.id);
      if (ts < agg._firstTs) agg._firstTs = ts;
      if (ts > agg._lastTs)  agg._lastTs = ts;
    }

    // 4) Enriquece com dados do CATÁLOGO (ref/cor/tamanho/descrição).
    //    Até 03/09 isto batia no Giga (erp.buscarProdutoPorCodigo, pool morto
    //    desde 27/08): o catch engolia o erro, NENHUM sku enriquecia e os
    //    filtros de ref/cor/tamanho do passo 5 descartavam TODAS as linhas
    //    calados. Agora resolve em UM lote no Postgres, no MESMO buscador das
    //    etiquetas avulsas (product + wincred_produtos, nativa vence —
    //    commit 919585f). Erro aqui SOBE — fonte quebrada não pode virar
    //    "relatório vazio".
    const skus = Array.from(new Set(Array.from(map.values()).map((a) => a.sku)));
    const skuToProd: Record<string, { ref: string; cor: string; tamanho: string; descricao: string }> = {};

    if (skus.length) {
      const { labels } = await this.purchaseOrders.buscarEtiquetasAvulsas(skus);
      // `codigo` das labels vem normalizado SEM zeros à esquerda — casa com o
      // SKU do pedido pela MESMA normalização (padding inconsistente do Giga).
      const porCodigo = new Map<string, (typeof labels)[number]>();
      for (const l of labels) {
        const cod = String(l.codigo || '').trim();
        if (cod && !porCodigo.has(cod)) porCodigo.set(cod, l);
      }
      for (const sku of skus) {
        const norm = sku.replace(/\D/g, '').replace(/^0+/, '') || sku;
        const p = porCodigo.get(norm);
        if (p) {
          skuToProd[sku] = {
            ref: String(p.ref || '').trim(),
            cor: String(p.cor || '').trim(),
            tamanho: String(p.tamanho || '').trim(),
            descricao: String(p.descricao || '').trim(),
          };
        }
      }
    }

    // 5) Aplica filtros de ref / cor / tamanho (post-query, em memória)
    const refQ = filters.ref?.trim().toUpperCase();
    const corQ = filters.cor?.trim().toUpperCase();
    const tamQ = filters.tamanho?.trim().toUpperCase();

    const linhas: SiteSaidaLinha[] = [];
    for (const agg of map.values()) {
      const prod = skuToProd[agg.sku];
      if (prod) {
        agg.ref = prod.ref;
        agg.cor = prod.cor;
        agg.tamanho = prod.tamanho;
        agg.descricao = prod.descricao;
      }

      // Filtros opcionais
      if (refQ && !(agg.ref?.toUpperCase().includes(refQ) || agg.productName?.toUpperCase().includes(refQ) || agg.descricao?.toUpperCase().includes(refQ))) continue;
      if (corQ && !agg.cor?.toUpperCase().includes(corQ)) continue;
      if (tamQ && agg.tamanho?.toUpperCase() !== tamQ) continue;

      agg.pedidos = agg._orderIds.size;
      agg.primeiraSaida = new Date(agg._firstTs).toISOString();
      agg.ultimaSaida = new Date(agg._lastTs).toISOString();

      // Tira os campos auxiliares
      const { _orderIds, _firstTs, _lastTs, ...clean } = agg as any;
      linhas.push(clean);
    }

    // 6) Ordena: por loja, depois ref, depois tamanho
    linhas.sort((a, b) => {
      const s = a.storeCode.localeCompare(b.storeCode);
      if (s !== 0) return s;
      const r = (a.ref || '').localeCompare(b.ref || '');
      if (r !== 0) return r;
      return (a.tamanho || '').localeCompare(b.tamanho || '');
    });

    const totalGeralQtd = linhas.reduce((s, l) => s + l.qtd, 0);
    const totalGeralValor = linhas.reduce((s, l) => s + l.valor, 0);
    const todosOrderIds = new Set<string>();
    for (const agg of map.values()) {
      if (
        (!refQ || agg.ref?.toUpperCase().includes(refQ) || agg.productName?.toUpperCase().includes(refQ)) &&
        (!corQ || agg.cor?.toUpperCase().includes(corQ)) &&
        (!tamQ || agg.tamanho?.toUpperCase() === tamQ)
      ) {
        for (const id of (agg as any)._orderIds) todosOrderIds.add(id);
      }
    }

    return {
      linhas,
      totalGeralQtd,
      totalGeralValor,
      totalGeralPedidos: todosOrderIds.size,
      filtrosAplicados: filters,
    };
  }
}
