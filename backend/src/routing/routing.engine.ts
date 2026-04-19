import { Injectable, Logger } from '@nestjs/common';
import {
  OrderItemInput,
  RoutingContext,
  RoutingResult,
  StockEntry,
  StoreInput,
  PickAssignment,
} from './types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ROUTING ENGINE — Núcleo de inteligência do FlowOps
 *  Ver arquitetura §5 no docs/FlowOps-Arquitetura.docx
 *
 *  Regras, em ordem de prioridade:
 *    1. UMA LOJA SÓ (evitar fragmentação).
 *    2. MÍNIMO de lojas se nenhuma cobre tudo (greedy set cover).
 *    3. DESEMPATE: score ponderado composto (ver abaixo).
 *    4. ANTI-FRAG: um SKU nunca é dividido entre 2 lojas.
 *
 *  Score composto (desempate entre lojas elegíveis):
 *     finalScore = W_STOCK  × stockBufferScore  (0..1 — folga de estoque)
 *                + W_DIST   × distanceScore     (0..1 — proximidade do cliente)
 *                + W_PRIO   × priorityScore     (0..1 — prioridade manual cadastrada)
 *
 *  stockBufferScore é o ELO MAIS FRACO: pra cada SKU do pedido calcula
 *  `disponível/necessário`, pega o MÍNIMO, e capa em 3x. Isso garante que
 *  uma loja com 3 unidades é MUITO preferida sobre uma com 1 unidade.
 *     buffer = 1 (tem exato) → score 0.33
 *     buffer = 2              → score 0.67
 *     buffer = 3+             → score 1.0 (caldeirão)
 *
 *  A engine é PURA: recebe contexto, retorna decisão. Sem IO.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class RoutingEngine {
  private readonly logger = new Logger(RoutingEngine.name);

  /**
   * Pesos do score composto. Somam 1.
   * Calibração atual prioriza ESTOQUE DISPONÍVEL (reduz risco de loja vender a peça
   * enquanto o pedido tá na fila), seguido de DISTÂNCIA e por último PRIORIDADE MANUAL.
   * Pra ajustar: mude os 3 números mantendo a soma = 1.
   */
  private readonly W_STOCK = 0.45;     // FOLGA de estoque (mais peso — era 0.30)
  private readonly W_DISTANCE = 0.30;  // proximidade do CEP do cliente
  private readonly W_PRIORITY = 0.25;  // prioridade manual (cadastrada em /lojas)

  /**
   * Cap do buffer de estoque. Acima desse múltiplo do necessário, considera
   * "caldeirão" (score maximo). 3 = ter o triplo já dá score máximo.
   */
  private readonly STOCK_BUFFER_CAP = 3;

  route(ctx: RoutingContext): RoutingResult {
    const activeStores = ctx.stores.filter((s) => s.active);
    if (activeStores.length === 0) {
      return this.insufficient(ctx.items, 'Nenhuma loja ativa.');
    }

    const stockMap = this.buildStockMap(ctx.stock);

    // Score pra TODAS as lojas ativas — ajuda a debugar na UI por quê cada loja foi/não foi escolhida.
    // Ordena da melhor pra pior.
    const allScores = this.explainScores(activeStores, ctx, stockMap).sort(
      (a, b) => b.finalScore - a.finalScore,
    );

    // REGRA 1 — uma loja única cobre tudo?
    const fullCoverage = activeStores.filter((store) =>
      this.canFulfillAll(store.code, ctx.items, stockMap),
    );

    if (fullCoverage.length > 0) {
      const best = this.pickBestStore(fullCoverage, ctx, stockMap);
      return {
        success: true,
        strategy: 'single-store',
        assignments: [this.buildAssignment(best, ctx.items)],
        missing: [],
        scoreBreakdown: allScores,
      };
    }

    // REGRA 2 — mínimo de lojas (greedy set cover)
    const plan = this.greedySetCover(activeStores, ctx, stockMap);
    const coveredSkus = new Set(plan.flatMap((p) => p.items.map((i) => i.sku)));
    const missing = ctx.items.filter((i) => !coveredSkus.has(i.sku));

    if (missing.length > 0) {
      // ruptura total ou parcial
      return {
        success: false,
        strategy: 'insufficient-stock',
        assignments: plan,
        missing,
        scoreBreakdown: allScores,
      };
    }

    return {
      success: true,
      strategy: 'multi-store',
      assignments: plan,
      missing: [],
      scoreBreakdown: allScores,
    };
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  private buildStockMap(stock: StockEntry[]): Map<string, number> {
    // key: storeCode + '::' + sku
    const m = new Map<string, number>();
    for (const e of stock) {
      m.set(this.stockKey(e.storeCode, e.sku), e.availableQty);
    }
    return m;
  }
  private stockKey(storeCode: string, sku: string) {
    return `${storeCode}::${sku}`;
  }

  /** REGRA 1: essa loja tem TODOS os itens em quantidade suficiente? */
  private canFulfillAll(storeCode: string, items: OrderItemInput[], stockMap: Map<string, number>): boolean {
    return items.every((item) => (stockMap.get(this.stockKey(storeCode, item.sku)) ?? 0) >= item.quantity);
  }

  /**
   * REGRA 3 (desempate): score composto.
   * Retorna 0..1 onde 1 é a loja ideal.
   */
  private scoreStore(store: StoreInput, ctx: RoutingContext, stockMap: Map<string, number>): number {
    const priority = store.priorityScore / 100; // 0..1
    const bufferScore = this.stockBufferScore(store, ctx, stockMap);
    const distance = this.distanceScore(store.cep, ctx.shippingCep);

    return (
      this.W_STOCK * bufferScore +
      this.W_DISTANCE * distance +
      this.W_PRIORITY * priority
    );
  }

  /**
   * FOLGA de estoque: pra cada item do pedido calcula `disponível / necessário`,
   * retorna o MÍNIMO (elo mais fraco). Se a loja não cobre algum item, retorna 0.
   * Cap em `STOCK_BUFFER_CAP` (=3): acima disso, score máximo.
   *
   *  - Loja com 1 unidade (qty=1): ratio=1    → score 0.33
   *  - Loja com 2 unidades (qty=1): ratio=2   → score 0.67
   *  - Loja com 3+ unidades        : ratio=3+ → score 1.0
   *  - Loja com 0 de algum SKU     : ratio=0  → score 0 (não elegível)
   */
  private stockBufferScore(store: StoreInput, ctx: RoutingContext, stockMap: Map<string, number>): number {
    if (ctx.items.length === 0) return 0;
    let minRatio = Infinity;
    for (const item of ctx.items) {
      const avail = stockMap.get(this.stockKey(store.code, item.sku)) ?? 0;
      const needed = Math.max(1, item.quantity);
      const ratio = avail / needed;
      if (ratio < minRatio) minRatio = ratio;
    }
    if (minRatio === Infinity) return 0;
    const capped = Math.min(this.STOCK_BUFFER_CAP, minRatio);
    return capped / this.STOCK_BUFFER_CAP;
  }

  /** Buffer bruto (sem normalizar) — útil pra debug e exibição. */
  private stockBufferRaw(store: StoreInput, items: OrderItemInput[], stockMap: Map<string, number>): number {
    if (items.length === 0) return 0;
    let min = Infinity;
    for (const item of items) {
      const avail = stockMap.get(this.stockKey(store.code, item.sku)) ?? 0;
      const ratio = avail / Math.max(1, item.quantity);
      if (ratio < min) min = ratio;
    }
    return min === Infinity ? 0 : min;
  }

  /**
   * Score de distância simplificado por faixa de CEP.
   * 1 = mesmo CEP de 3 dígitos; 0 = não comparável.
   * Versão avançada usa haversine com tabela lat/lng.
   */
  private distanceScore(storeCep?: string | null, orderCep?: string | null): number {
    if (!storeCep || !orderCep) return 0.5; // neutro
    const a = storeCep.replace(/\D/g, '');
    const b = orderCep.replace(/\D/g, '');
    if (a.length < 3 || b.length < 3) return 0.5;
    // compara prefixos progressivos
    if (a.slice(0, 5) === b.slice(0, 5)) return 1.0;
    if (a.slice(0, 3) === b.slice(0, 3)) return 0.85;
    if (a.slice(0, 2) === b.slice(0, 2)) return 0.6;
    if (a.slice(0, 1) === b.slice(0, 1)) return 0.4;
    return 0.2;
  }

  private pickBestStore(stores: StoreInput[], ctx: RoutingContext, stockMap: Map<string, number>): StoreInput {
    return [...stores].sort(
      (x, y) => this.scoreStore(y, ctx, stockMap) - this.scoreStore(x, ctx, stockMap),
    )[0];
  }

  private buildAssignment(store: StoreInput, items: OrderItemInput[]): PickAssignment {
    return {
      storeId: store.id,
      storeCode: store.code,
      storeName: store.name,
      items: items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
    };
  }

  /**
   * REGRA 2: greedy set cover.
   * Enquanto houver itens pendentes, escolhe a loja que cobre mais (em qty ponderada),
   * com empate resolvido pelo score composto.
   */
  private greedySetCover(
    stores: StoreInput[],
    ctx: RoutingContext,
    stockMap: Map<string, number>,
  ): PickAssignment[] {
    const remaining = new Map<string, number>();
    for (const item of ctx.items) remaining.set(item.sku, item.quantity);

    const plan: PickAssignment[] = [];
    const usedStores = new Set<string>();

    while (remaining.size > 0) {
      let bestStore: StoreInput | null = null;
      let bestCovered: OrderItemInput[] = [];
      let bestScore = -1;

      for (const store of stores) {
        if (usedStores.has(store.id)) continue;

        // O que essa loja cobre do restante?
        const covered: OrderItemInput[] = [];
        for (const [sku, qty] of remaining.entries()) {
          const available = stockMap.get(this.stockKey(store.code, sku)) ?? 0;
          if (available >= qty) {
            // REGRA 4: um SKU é 100% atendido por uma única loja (sem split).
            covered.push({ sku, quantity: qty });
          }
        }
        if (covered.length === 0) continue;

        // métrica de decisão: primeiro quantidade de SKUs cobertos, depois score
        const storeScore = this.scoreStore(store, ctx, stockMap);
        const candidateRank = covered.length * 10 + storeScore;

        if (candidateRank > bestScore) {
          bestScore = candidateRank;
          bestStore = store;
          bestCovered = covered;
        }
      }

      if (!bestStore || bestCovered.length === 0) {
        // nenhuma loja cobre mais nada → para
        break;
      }

      plan.push(this.buildAssignment(bestStore, bestCovered));
      usedStores.add(bestStore.id);
      for (const c of bestCovered) remaining.delete(c.sku);
    }

    return plan;
  }

  private explainScores(stores: StoreInput[], ctx: RoutingContext, stockMap: Map<string, number>) {
    return stores.map((s) => {
      const priority = s.priorityScore / 100;
      const stockBuffer = this.stockBufferRaw(s, ctx.items, stockMap);
      const stockBufferScore = this.stockBufferScore(s, ctx, stockMap);
      const distance = this.distanceScore(s.cep, ctx.shippingCep);
      const finalScore = this.scoreStore(s, ctx, stockMap);
      return {
        storeCode: s.code,
        storeName: s.name,
        priorityScore: Number(priority.toFixed(4)),
        stockBuffer: Number(stockBuffer.toFixed(2)),
        stockBufferScore: Number(stockBufferScore.toFixed(4)),
        distanceScore: Number(distance.toFixed(4)),
        finalScore: Number(finalScore.toFixed(4)),
        fullCoverage: this.canFulfillAll(s.code, ctx.items, stockMap),
      };
    });
  }

  private insufficient(items: OrderItemInput[], reason: string): RoutingResult {
    this.logger.warn(`Routing abortado: ${reason}`);
    return {
      success: false,
      strategy: 'insufficient-stock',
      assignments: [],
      missing: items,
    };
  }
}
