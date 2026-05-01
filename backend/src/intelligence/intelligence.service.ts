import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * IntelligenceService — junta dados Giga (estoque + venda) com Postgres
 * (remessas) pra montar o dashboard /retaguarda/inteligencia-estoque.
 *
 * Design: 1 endpoint principal (overview) que faz N queries em paralelo
 * pra montar a tabela "1 linha por loja". Endpoints auxiliares pra drill-down
 * (top vendas, rupturas, parados, heatmap) por loja específica.
 *
 * Performance: cada chamada de overview faz ~3 queries Giga (estoque, vendas
 * peças+valor, top sellers global) + 2 queries Postgres (remessas in/out).
 * Tudo em paralelo via Promise.all. Pra ~15 lojas + 30d janela, fica < 2s.
 */
@Injectable()
export class IntelligenceService {
  private readonly logger = new Logger(IntelligenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  /**
   * Parser de janela de datas (YYYY-MM-DD) com defaults seguros.
   * Default: últimos 30 dias.
   */
  private parseRange(input: { from?: string; to?: string }): { inicio: Date; fim: Date } {
    const fim = input.to ? new Date(`${input.to}T00:00:00.000Z`) : new Date();
    if (isNaN(fim.getTime())) throw new BadRequestException('to inválido');
    const inicio = input.from
      ? new Date(`${input.from}T00:00:00.000Z`)
      : (() => {
          const d = new Date(fim);
          d.setDate(d.getDate() - 30);
          return d;
        })();
    if (isNaN(inicio.getTime())) throw new BadRequestException('from inválido');
    if (inicio > fim) throw new BadRequestException('from > to');
    // half-open: fim exclusivo
    const fimExclusive = new Date(fim);
    fimExclusive.setDate(fimExclusive.getDate() + 1);
    return { inicio, fim: fimExclusive };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // OVERVIEW — tabela principal (1 linha por loja)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Visão geral por loja: estoque atual + movimentação de remessas + venda.
   * Saldo movimento = recebido - enviado - vendido (entrada vs saída).
   *
   * Cada loja vira 1 linha. Inclui também totalRede + totalFranquia agregados.
   */
  async getStoresOverview(input: {
    from?: string;
    to?: string;
    plusSize?: boolean;
    year?: string;
  }) {
    const { inicio, fim } = this.parseRange(input);
    const plusSize = !!input.plusSize;
    const year = input.year;

    // Carrega lojas ativas
    const stores = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true, tipo: true } as any,
      orderBy: { code: 'asc' },
    });
    const codes = (stores as any[]).map((s) => s.code);

    // Em paralelo: estoque + vendas (Giga) + remessas in/out (Postgres)
    // Estoque e vendas filtram por ANO DE CADASTRO da peça (year). As remessas
    // ficam sem esse filtro porque o histórico de envios não conhece a data
    // de cadastro do SKU — manteve o comportamento atual.
    const [stockMap, salesMap, recebido, enviado] = await Promise.all([
      this.erp.getStockTotalByStores(plusSize, year),
      this.erp.getSalesByStoresInRange(inicio, fim, plusSize, year),
      this.getRecebidoByStore(inicio, fim, codes),
      this.getEnviadoByStore(inicio, fim, codes),
    ]);

    let totalEstoqueRede = 0;
    let totalEstoqueFranquia = 0;
    let totalVendasRede = { pecas: 0, valor: 0 };
    let totalVendasFranquia = { pecas: 0, valor: 0 };

    const rows = (stores as any[]).map((s) => {
      const estoque = stockMap.get(s.code) || 0;
      const vendas = salesMap.get(s.code) || { pecas: 0, valor: 0 };
      const rec = recebido.get(s.code) || 0;
      const env = enviado.get(s.code) || 0;
      const tipo = (s.tipo || 'REDE') as 'REDE' | 'FILIAL';
      // Saldo: o que entrou (recebido) - o que saiu (enviado + vendido)
      const saldo = rec - env - vendas.pecas;

      if (tipo === 'FILIAL') {
        totalEstoqueFranquia += estoque;
        totalVendasFranquia.pecas += vendas.pecas;
        totalVendasFranquia.valor += vendas.valor;
      } else {
        totalEstoqueRede += estoque;
        totalVendasRede.pecas += vendas.pecas;
        totalVendasRede.valor += vendas.valor;
      }

      return {
        storeCode: s.code,
        storeName: s.name,
        tipo,
        estoqueAtual: estoque,
        recebido: rec,
        enviado: env,
        vendidoPecas: vendas.pecas,
        vendidoValor: vendas.valor,
        saldoMovimento: saldo,
        // Ticket médio (só calcula se tiver venda)
        ticketMedio: vendas.pecas > 0 ? vendas.valor / vendas.pecas : 0,
      };
    });

    return {
      periodo: {
        from: inicio.toISOString().slice(0, 10),
        to: new Date(fim.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        plusSize,
        year: year || null,
      },
      totaisGerais: {
        estoqueRede: totalEstoqueRede,
        estoqueFranquia: totalEstoqueFranquia,
        estoqueTotal: totalEstoqueRede + totalEstoqueFranquia,
        vendidoRede: totalVendasRede,
        vendidoFranquia: totalVendasFranquia,
        vendidoTotal: {
          pecas: totalVendasRede.pecas + totalVendasFranquia.pecas,
          valor: totalVendasRede.valor + totalVendasFranquia.valor,
        },
      },
      rows: rows.sort((a, b) => b.vendidoValor - a.vendidoValor),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DIAGNÓSTICO DE SKU — pra debugar "tem estoque mas sistema não acha"
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Pra um SKU específico, retorna:
   *   - Estoque REAL no Giga por loja (o que aparece em /produtos)
   *   - Pick-orders ATIVOS consumindo esse SKU (quem reservou e em qual pedido WC)
   *   - Estoque LÍQUIDO (real − committed) — o que o routing usa pra decidir
   *
   * Usado pra explicar à matriz por que um SKU "tem estoque" na tela mas o pedido
   * fica em ruptura (estoque comprometido em outro pick-order ativo).
   */
  async diagnoseSkuStock(sku: string) {
    const cleanSku = String(sku || '').trim();
    if (!cleanSku) {
      throw new BadRequestException('SKU obrigatório');
    }

    // 1) Carrega TODAS as lojas (incluindo inativas) — se o estoque tá numa
    // loja inativa, a UI precisa mostrar pra retaguarda diagnosticar o bug.
    const stores = await this.prisma.store.findMany({
      select: { id: true, code: true, name: true, tipo: true, active: true } as any,
      orderBy: { code: 'asc' },
    });
    const storeIds = stores.map((s: any) => s.id);
    const codeByStoreId = new Map(stores.map((s: any) => [s.id, s.code]));
    const nameByCode = new Map(stores.map((s: any) => [s.code, s.name]));
    const tipoByCode = new Map(stores.map((s: any) => [s.code, (s as any).tipo || 'REDE']));
    const activeByCode = new Map(stores.map((s: any) => [s.code, !!s.active]));

    // 2) Estoque REAL no Giga por loja (1 query)
    const realStockMap = await this.erp.getStockRawBySku(cleanSku);
    const realByStore = new Map<string, number>();
    for (const r of realStockMap) {
      const code = String(r.storeCode || '').trim();
      if (code) realByStore.set(code, (realByStore.get(code) || 0) + (r.qty || 0));
    }

    // 3) Pick-orders ATIVOS (não enviados / não baixados) que tocam esse SKU
    const activePickOrders = await this.prisma.pickOrder.findMany({
      where: {
        storeId: { in: storeIds },
        status: { in: ['new', 'separating', 'separated'] },
      },
      select: { id: true, orderId: true, storeId: true, status: true, createdAt: true },
    });
    const orderIds = [...new Set(activePickOrders.map((p) => p.orderId))];
    const itemsActive = orderIds.length
      ? await this.prisma.orderItem.findMany({
          where: { orderId: { in: orderIds }, sku: cleanSku },
          select: { orderId: true, sku: true, quantity: true, assignedStoreId: true },
        })
      : [];

    // Agrupar por (storeCode) e enriquecer com info do pedido WC
    const ordersInfo = orderIds.length
      ? await this.prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: {
            id: true,
            wcOrderId: true,
            wcOrderNumber: true,
            customerName: true,
            status: true,
            createdAt: true,
          },
        })
      : [];
    const orderById = new Map(ordersInfo.map((o) => [o.id, o]));
    const pickStoreByOrderId = new Map<string, string>();
    for (const po of activePickOrders) pickStoreByOrderId.set(po.orderId, po.storeId);

    // Lista de "compromissos" detalhados (1 por item do pedido)
    type Commitment = {
      storeCode: string;
      storeName: string;
      qty: number;
      pickOrderId: string;
      pickOrderStatus: string;
      wcOrderId: number | null;
      wcOrderNumber: string | null;
      customerName: string | null;
      orderStatus: string | null;
      orderCreatedAt: string | null;
    };
    const commitments: Commitment[] = [];
    const committedByStore = new Map<string, number>();
    for (const it of itemsActive) {
      const targetStoreId = it.assignedStoreId ?? pickStoreByOrderId.get(it.orderId) ?? null;
      if (!targetStoreId) continue;
      const code = codeByStoreId.get(targetStoreId);
      if (!code) continue;
      const order = orderById.get(it.orderId);
      const po = activePickOrders.find((p) => p.orderId === it.orderId && p.storeId === targetStoreId);
      committedByStore.set(code, (committedByStore.get(code) || 0) + it.quantity);
      commitments.push({
        storeCode: code,
        storeName: nameByCode.get(code) || code,
        qty: it.quantity,
        pickOrderId: po?.id || '?',
        pickOrderStatus: po?.status || '?',
        wcOrderId: order?.wcOrderId || null,
        wcOrderNumber: order?.wcOrderNumber || null,
        customerName: order?.customerName || null,
        orderStatus: order?.status || null,
        orderCreatedAt: order?.createdAt ? order.createdAt.toISOString() : null,
      });
    }

    // 4) Monta linhas por loja com real / committed / liquid
    const allCodes = new Set<string>([
      ...realByStore.keys(),
      ...committedByStore.keys(),
    ]);
    const rows = Array.from(allCodes).map((code) => {
      const real = realByStore.get(code) || 0;
      const committed = committedByStore.get(code) || 0;
      const liquid = Math.max(0, real - committed);
      // Diferencia 3 estados: registered+ativa, registered+inativa, NÃO cadastrada.
      // Loja não cadastrada (no Postgres) é o pior caso: routing ignora por
      // completo, mesmo com estoque físico no Giga. Caso real do pedido #191547.
      const isRegistered = activeByCode.has(code);
      const active = isRegistered ? activeByCode.get(code)! : false;
      return {
        storeCode: code,
        storeName: isRegistered ? nameByCode.get(code) || code : '⚠️ NÃO CADASTRADA',
        tipo: tipoByCode.get(code) || 'REDE',
        active,
        registered: isRegistered,
        real,
        committed,
        liquid,
      };
    });
    // Ordena: lojas com algum real ou committed primeiro, por nome
    rows.sort((a, b) => {
      const hasA = a.real > 0 || a.committed > 0 ? 0 : 1;
      const hasB = b.real > 0 || b.committed > 0 ? 0 : 1;
      if (hasA !== hasB) return hasA - hasB;
      return a.storeCode.localeCompare(b.storeCode);
    });

    const totalReal = rows.reduce((s, r) => s + r.real, 0);
    const totalCommitted = rows.reduce((s, r) => s + r.committed, 0);
    const totalLiquid = rows.reduce((s, r) => s + r.liquid, 0);

    return {
      sku: cleanSku,
      totals: { real: totalReal, committed: totalCommitted, liquid: totalLiquid },
      rows: rows.filter((r) => r.real > 0 || r.committed > 0),
      commitments: commitments.sort((a, b) => a.storeCode.localeCompare(b.storeCode)),
    };
  }

  /**
   * TRACE — executa getStock real (igual o routing) e retorna cada passo.
   * Usado pra debug quando diagnóstico mostra estoque mas pedido fica em
   * ruptura. Carrega as lojas ATIVAS (mesmas que o routing usa) e chama
   * o trace do ERP service.
   */
  async traceSkuStock(sku: string) {
    const stores = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true } as any,
      orderBy: { code: 'asc' },
    });
    const storeCodes = stores.map((s: any) => s.code);
    const trace = await this.erp.traceSkuStock(sku, storeCodes);
    return {
      ...trace,
      lojasAtivas: stores.map((s: any) => ({ code: s.code, name: s.name })),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MOVIMENTAÇÃO DE REMESSAS (Postgres)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Total de PEÇAS recebidas (status = received) por loja destino no período.
   * Considera só remessas que efetivamente chegaram.
   */
  private async getRecebidoByStore(
    inicio: Date,
    fim: Date,
    storeCodes: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!storeCodes.length) return out;
    try {
      // Pega remessas recebidas no período
      const shipments = await (this.prisma as any).realignmentShipment.findMany({
        where: {
          status: 'received',
          receivedAt: { gte: inicio, lt: fim },
          toStoreCode: { in: storeCodes },
        },
        select: { id: true, toStoreCode: true, receivedQty: true },
      });
      // Soma por loja
      for (const s of shipments as any[]) {
        const code = String(s.toStoreCode);
        out.set(code, (out.get(code) || 0) + (s.receivedQty || 0));
      }
      return out;
    } catch (e) {
      this.logger.warn(`getRecebidoByStore falhou: ${(e as Error).message}`);
      return out;
    }
  }

  /**
   * Total de PEÇAS enviadas por loja origem no período (status in_transit ou
   * received, ou seja: caixa saiu da loja). sentAt no range.
   */
  private async getEnviadoByStore(
    inicio: Date,
    fim: Date,
    storeCodes: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!storeCodes.length) return out;
    try {
      const shipments = await (this.prisma as any).realignmentShipment.findMany({
        where: {
          status: { in: ['in_transit', 'received'] },
          sentAt: { gte: inicio, lt: fim },
          fromStoreCode: { in: storeCodes },
        },
        select: { id: true, fromStoreCode: true, totalQty: true },
      });
      for (const s of shipments as any[]) {
        const code = String(s.fromStoreCode);
        out.set(code, (out.get(code) || 0) + (s.totalQty || 0));
      }
      return out;
    } catch (e) {
      this.logger.warn(`getEnviadoByStore falhou: ${(e as Error).message}`);
      return out;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DRILL-DOWN — top vendas, rupturas, parados (escopo: rede ou loja)
  // ═══════════════════════════════════════════════════════════════════════

  async getTopSellers(input: {
    from?: string;
    to?: string;
    storeCode?: string | null;
    plusSize?: boolean;
    orderBy?: 'pecas' | 'valor';
    limit?: number;
  }) {
    const { inicio, fim } = this.parseRange(input);
    return this.erp.getTopRefsBySales({
      inicio,
      fim,
      storeCode: input.storeCode || null,
      plusSize: !!input.plusSize,
      orderBy: input.orderBy || 'pecas',
      limit: input.limit || 10,
    });
  }

  async getRupturas(input: {
    from?: string;
    to?: string;
    storeCode?: string | null;
    plusSize?: boolean;
    limit?: number;
  }) {
    const { inicio, fim } = this.parseRange(input);
    return this.erp.getRupturas({
      inicio,
      fim,
      storeCode: input.storeCode || null,
      plusSize: !!input.plusSize,
      limit: input.limit || 10,
    });
  }

  async getParados(input: {
    storeCode?: string | null;
    daysSemVenda?: number;
    minStock?: number;
    plusSize?: boolean;
    limit?: number;
  }) {
    return this.erp.getParados({
      storeCode: input.storeCode || null,
      daysSemVenda: input.daysSemVenda || 30,
      minStock: input.minStock || 5,
      plusSize: !!input.plusSize,
      limit: input.limit || 10,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STORE DETAIL — tudo de uma loja (drill-down completo)
  // ═══════════════════════════════════════════════════════════════════════

  async getStoreDetail(input: {
    storeCode: string;
    from?: string;
    to?: string;
    plusSize?: boolean;
  }) {
    if (!input.storeCode) throw new BadRequestException('storeCode obrigatório');
    const { inicio, fim } = this.parseRange(input);
    const plusSize = !!input.plusSize;

    const store = await this.prisma.store.findFirst({
      where: { code: input.storeCode, active: true },
      select: { code: true, name: true, tipo: true } as any,
    });
    if (!store) throw new BadRequestException(`Loja ${input.storeCode} não encontrada`);

    const [stockMap, salesMap, topPecas, topValor, rupturas, parados] = await Promise.all([
      this.erp.getStockTotalByStores(plusSize),
      this.erp.getSalesByStoresInRange(inicio, fim, plusSize),
      this.erp.getTopRefsBySales({
        inicio,
        fim,
        storeCode: input.storeCode,
        plusSize,
        orderBy: 'pecas',
        limit: 10,
      }),
      this.erp.getTopRefsBySales({
        inicio,
        fim,
        storeCode: input.storeCode,
        plusSize,
        orderBy: 'valor',
        limit: 10,
      }),
      this.erp.getRupturas({
        inicio,
        fim,
        storeCode: input.storeCode,
        plusSize,
        limit: 10,
      }),
      this.erp.getParados({
        storeCode: input.storeCode,
        daysSemVenda: 30,
        minStock: 5,
        plusSize,
        limit: 10,
      }),
    ]);

    const estoque = stockMap.get(input.storeCode) || 0;
    const vendas = salesMap.get(input.storeCode) || { pecas: 0, valor: 0 };

    // Cobertura: peças em estoque ÷ peças vendidas/dia (no período)
    const dias = Math.max(1, Math.round((fim.getTime() - inicio.getTime()) / (24 * 60 * 60 * 1000)));
    const vendaDiaria = vendas.pecas / dias;
    const cobertura = vendaDiaria > 0 ? estoque / vendaDiaria : null;

    return {
      store: {
        code: (store as any).code,
        name: (store as any).name,
        tipo: ((store as any).tipo || 'REDE') as 'REDE' | 'FILIAL',
      },
      periodo: {
        from: inicio.toISOString().slice(0, 10),
        to: new Date(fim.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        dias,
        plusSize,
      },
      kpis: {
        estoqueAtual: estoque,
        vendidoPecas: vendas.pecas,
        vendidoValor: vendas.valor,
        ticketMedio: vendas.pecas > 0 ? vendas.valor / vendas.pecas : 0,
        vendaDiariaPecas: vendaDiaria,
        coberturaDias: cobertura, // null = sem venda no período
      },
      topVendasPorPeca: topPecas,
      topVendasPorValor: topValor,
      rupturas,
      parados,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HEATMAP REF × LOJA
  // ═══════════════════════════════════════════════════════════════════════

  async getHeatmap(input: { plusSize?: boolean; limit?: number }) {
    return this.erp.getHeatmap({
      plusSize: !!input.plusSize,
      limitRefs: input.limit || 20,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RELATÓRIO DE VENDAS — /retaguarda/inteligencia-vendas
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Relatório completo de vendas pra dashboard de inteligência:
   *  - summary: total, peças, vendas, ticket médio
   *  - byStore: lista por loja com ticket médio
   *  - byDay: série temporal pra gráfico
   *  - topVendedoras: ranking + comissão calculada
   *  - topMarcas: marcas mais vendidas
   *  - topProdutos: REFs mais vendidas (reusa getTopRefsBySales)
   *
   * Loja 13 (Site) — entra natural na agregação porque é uma loja como
   * outra qualquer no Giga. Tanto Wincred (até 26/04) quanto nosso PDV
   * gravam na mesma tabela `caixa`, então não precisa join especial.
   */
  async getSalesReport(input: {
    from?: string;
    to?: string;
    storeCode?: string;
    comissaoPct?: number; // % comissão padrão pra cálculo (ex: 2 = 2%)
    plusSize?: boolean;
    compareYoY?: boolean; // se true, busca também o mesmo período do ano anterior
  }) {
    const { inicio, fim } = this.parseRange({ from: input.from, to: input.to });
    const comissaoPct = input.comissaoPct ?? 2;

    // Lista de lojas ativas pra montar tabela by-store
    const stores = await (this.prisma as any).store.findMany({
      where: { active: true } as any,
      select: { code: true, name: true, tipo: true } as any,
    });

    // Em paralelo: summary, by-day, by-store, top-vendedoras, top-marcas, top-produtos
    const [summary, byDay, salesByStore, topVendedoras, topMarcas, topProdutos] =
      await Promise.all([
        this.erp.getSalesSummary({ inicio, fim, storeCode: input.storeCode || null }),
        this.erp.getSalesByDay({ inicio, fim, storeCode: input.storeCode || null }),
        this.erp.getSalesByStoresInRange(inicio, fim, !!input.plusSize),
        this.erp.getTopVendedoras({ inicio, fim, storeCode: input.storeCode || null, limit: 30 }),
        this.erp.getTopMarcas({ inicio, fim, storeCode: input.storeCode || null, limit: 15 }),
        this.erp.getTopRefsBySales({
          inicio, fim,
          storeCode: input.storeCode || null,
          plusSize: !!input.plusSize,
          orderBy: 'valor',
          limit: 20,
        }),
      ]);

    // Monta tabela by-store: cruza salesByStore (Map) com stores cadastradas
    const byStore = stores.map((s: any) => {
      const v = salesByStore.get(s.code) || { pecas: 0, valor: 0 };
      // Conta vendas distintas no by-day pra ticket médio (menos preciso
      // que numCupom mas cobre fallback). Se quiser preciso, fazer query
      // dedicada com numCupom por loja — fica pra v2.
      return {
        code: s.code,
        name: s.name,
        tipo: s.tipo || null,
        pecas: v.pecas,
        valor: v.valor,
        ticketMedio: v.pecas > 0 ? v.valor / v.pecas : 0, // ticket por peça (proxy)
      };
    }).filter((s: any) => s.valor > 0 || s.pecas > 0)
      .sort((a: any, b: any) => b.valor - a.valor);

    // Adiciona comissão a cada vendedora
    const vendedorasComComissao = topVendedoras.map((v) => ({
      ...v,
      comissao: Math.round(v.valor * (comissaoPct / 100) * 100) / 100,
      ticketMedio: v.vendas > 0 ? v.valor / v.vendas : 0,
    }));

    // ─── COMPARATIVO YoY ─────────────────────────────────────────────
    // Calcula mesmo período exatamente -1 ano (mantendo o número de dias).
    // Útil pra ver crescimento/queda real.
    let yoy: any = null;
    if (input.compareYoY) {
      const inicioPrev = new Date(inicio);
      inicioPrev.setFullYear(inicioPrev.getFullYear() - 1);
      const fimPrev = new Date(fim);
      fimPrev.setFullYear(fimPrev.getFullYear() - 1);

      const [summaryPrev, byDayPrev] = await Promise.all([
        this.erp.getSalesSummary({ inicio: inicioPrev, fim: fimPrev, storeCode: input.storeCode || null }),
        this.erp.getSalesByDay({ inicio: inicioPrev, fim: fimPrev, storeCode: input.storeCode || null }),
      ]);

      // Calcula variação percentual de cada KPI
      const pct = (atual: number, prev: number): number | null => {
        if (prev === 0) return atual > 0 ? null : 0; // null = "novo" (sem base)
        return Math.round(((atual - prev) / prev) * 1000) / 10; // 1 casa decimal
      };

      yoy = {
        periodoAnterior: {
          from: inicioPrev.toISOString().slice(0, 10),
          to: new Date(fimPrev.getTime() - 1).toISOString().slice(0, 10),
        },
        summary: summaryPrev,
        byDay: byDayPrev,
        variacao: {
          valor: pct(summary.valor, summaryPrev.valor),
          pecas: pct(summary.pecas, summaryPrev.pecas),
          vendas: pct(summary.vendas, summaryPrev.vendas),
          ticketMedio: pct(summary.ticketMedio, summaryPrev.ticketMedio),
        },
      };
    }

    return {
      periodo: {
        from: inicio.toISOString().slice(0, 10),
        to: new Date(fim.getTime() - 1).toISOString().slice(0, 10),
        dias: Math.round((fim.getTime() - inicio.getTime()) / (24 * 3600 * 1000)),
      },
      filtros: {
        storeCode: input.storeCode || null,
        comissaoPct,
        plusSize: !!input.plusSize,
        compareYoY: !!input.compareYoY,
      },
      summary,
      byStore,
      byDay,
      topVendedoras: vendedorasComComissao,
      topMarcas,
      topProdutos,
      yoy,
    };
  }
}
