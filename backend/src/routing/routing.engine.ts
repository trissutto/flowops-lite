import { Injectable, Logger } from '@nestjs/common';
import {
  OrderItemInput,
  RoutingContext,
  RoutingResult,
  StockEntry,
  StoreInput,
  PickAssignment,
  RoutingCedeStats,
} from './types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ROUTING ENGINE — Núcleo de inteligência do FlowOps
 *  Ver arquitetura §5 no docs/FlowOps-Arquitetura.docx
 *
 *  Regras, em ordem de prioridade:
 *    1. UMA LOJA SÓ (evitar fragmentação + minimiza frete).
 *    2. MÍNIMO DE LOJAS se nenhuma cobre tudo (greedy set cover, minimiza frete).
 *    3. ANTI-FRAG: um SKU nunca é dividido entre 2 lojas.
 *
 *  DESEMPATE (atualizado 20/04/26 conforme diretriz do CEO):
 *    Quando várias lojas qualificam pra receber o pick, a ordem é:
 *       1. Quantidade ABSOLUTA de peças dos SKUs do pedido (sem cap).
 *          Ex: 1× SKU-X — A=5, B=3 → A ganha. Sempre.
 *       2. Ratio (folga = mínimo de disponível/necessário entre SKUs cobertos).
 *       3. priorityScore manual (cadastrado em /lojas).
 *       4. Score composto finalScore (inclui distância CEP).
 *
 *  Score composto (usado APENAS como último desempate):
 *     finalScore = W_STOCK  × stockBufferScore  (0..1 — folga de estoque, cap 3x)
 *                + W_DIST   × distanceScore     (0..1 — proximidade do cliente)
 *                + W_PRIO   × priorityScore     (0..1 — prioridade manual cadastrada)
 *
 *  POR QUE QUANTIDADE ABSOLUTA PRIMEIRO:
 *     A loja vende presencialmente. Se 2 lojas cobrem o pedido, a que tem mais
 *     estoque desse SKU tem MENOR risco de zerar enquanto o pedido está na fila
 *     (loja com 10 unidades aguenta 9 vendas concorrentes; loja com 3 não).
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

  /**
   * Pesos do score PROPORCIONAL (só ativado quando cedeStats está presente).
   * Regra do CEO 21/04/26: peso da meta de cessão deve ser FORTE mas não
   * sobreporespa aos empates anteriores (qty absoluta / ratio).
   *
   *   score = qty_match * 10 + delta_meta * 50
   *     + (ratio)        * 3      (desempate secundário)
   *     + (priority)     * 5      (prioridade manual)
   *     + (distance)     * 2      (só quebra empate fino)
   *
   * Onde:
   *   qty_match  = quantidade coberta desse pedido (0..N) — peça é peça
   *   delta_meta = targetQuota[i] - (currentCede[i] / (totalCede+1))  → "quanto essa
   *                loja DEVE ceder mais". Positivo = está abaixo da meta = ganha.
   */
  private readonly W_PROP_QTY = 10;
  private readonly W_PROP_DELTA = 50;
  private readonly W_PROP_RATIO = 3;
  private readonly W_PROP_PRIORITY = 5;
  private readonly W_PROP_DISTANCE = 2;

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

    // REGRA 0 — RETIRADA EM LOJA (pickup)
    // Se cliente escolheu retirar em loja específica, essa loja tem prioridade TOTAL.
    // Se tem estoque → separa lá. Se não tem → outras lojas transferem pra ela.
    if (ctx.pickupStoreCode) {
      return this.routePickup(ctx, activeStores, stockMap, allScores);
    }

    // REGRA 1 — uma loja única cobre tudo?
    const fullCoverage = activeStores.filter((store) =>
      this.canFulfillAll(store.code, ctx.items, stockMap),
    );

    if (fullCoverage.length > 0) {
      // OVERRIDE MANUAL: se o usuário escolheu uma loja específica (via radio
      // button no frontend) E ela cobre tudo, usa ela em vez do pickBestStore.
      let best: StoreInput | null = null;
      if (ctx.preferStoreCode) {
        const preferred = fullCoverage.find((s) => s.code === ctx.preferStoreCode);
        if (preferred) best = preferred;
      }
      if (!best) best = this.pickBestStore(fullCoverage, ctx, stockMap);
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

  /**
   * DESEMPATE QUANDO VÁRIAS LOJAS COBREM TUDO (ou quando várias qualificam).
   *
   * Ordem de decisão — resolve o pedido do Thiago de 20/04/26:
   *   1. TOTAL de peças DOS ITENS DO PEDIDO disponíveis (absoluto, sem cap).
   *      Ex: pedido 1× SKU-X — A tem 5, B tem 3 → A ganha. Sempre.
   *   2. Ratio (stockBufferRaw = elo mais fraco disponível/necessário).
   *      Só diferencia quando o total absoluto empata, o que quase nunca acontece.
   *   3. priorityScore manual (cadastrado em /lojas).
   *   4. Último recurso: score composto (inclui distância CEP).
   *
   * Por que absoluto antes de ratio: pedido 1×X, A=10, B=3 — ambos cobrem.
   * Ratio normalizado capa em 3, daria empate. Mas A tem MUITO mais estoque,
   * reduz risco de loja ficar zerada após concorrência.
   */
  private pickBestStore(stores: StoreInput[], ctx: RoutingContext, stockMap: Map<string, number>): StoreInput {
    // MODO V2 — proporcionalidade inversa ativa (batelada de pedidos).
    // Quando ctx.cedeStats está presente, usa o score composto V2 com pesos do CEO.
    if (ctx.cedeStats) {
      return [...stores].sort((a, b) => {
        // 1. Quantidade absoluta do pedido ainda manda (uma loja com 10 peças desse
        //    SKU sempre vai ser melhor que 3 — protege contra concorrência física).
        const qtyA = this.totalRawQty(a, ctx.items, stockMap);
        const qtyB = this.totalRawQty(b, ctx.items, stockMap);
        if (qtyA !== qtyB) return qtyB - qtyA;

        // 2. Score proporcional V2 (entra pesado quando qtys empatam)
        return this.scoreStoreV2(b, ctx, stockMap) - this.scoreStoreV2(a, ctx, stockMap);
      })[0];
    }

    // MODO LEGADO (sem cedeStats) — mantém comportamento hierárquico anterior.
    return [...stores].sort((a, b) => {
      // 1. Quantidade absoluta total das peças do pedido que a loja tem
      const qtyA = this.totalRawQty(a, ctx.items, stockMap);
      const qtyB = this.totalRawQty(b, ctx.items, stockMap);
      if (qtyA !== qtyB) return qtyB - qtyA;

      // 2. Ratio (elo mais fraco)
      const ratioA = this.stockBufferRaw(a, ctx.items, stockMap);
      const ratioB = this.stockBufferRaw(b, ctx.items, stockMap);
      if (ratioA !== ratioB) return ratioB - ratioA;

      // 3. Prioridade manual
      if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore;

      // 4. Score composto (distância CEP entra aqui)
      return this.scoreStore(b, ctx, stockMap) - this.scoreStore(a, ctx, stockMap);
    })[0];
  }

  /**
   * Score V2 — proporcionalidade inversa (ativa quando ctx.cedeStats presente).
   *
   * Calcula:
   *   qty_match  = totalRawQty da loja (peças do pedido disponíveis)
   *   delta_meta = targetQuota - currentShareCede  (positivo = loja deve ceder mais)
   *   ratio      = stockBufferRaw (elo mais fraco)
   *   priority   = priorityScore/100
   *   distance   = distanceScore (0..1)
   *
   * Retorna soma ponderada — quanto maior, melhor.
   */
  private scoreStoreV2(store: StoreInput, ctx: RoutingContext, stockMap: Map<string, number>): number {
    const qtyMatch = this.totalRawQty(store, ctx.items, stockMap);
    const ratio = Math.min(this.STOCK_BUFFER_CAP, this.stockBufferRaw(store, ctx.items, stockMap));
    const priority = store.priorityScore / 100;
    const distance = this.distanceScore(store.cep, ctx.shippingCep);
    const deltaMeta = this.computeDeltaMeta(store.code, ctx.cedeStats);

    return (
      this.W_PROP_QTY * qtyMatch +
      this.W_PROP_DELTA * deltaMeta +
      this.W_PROP_RATIO * ratio +
      this.W_PROP_PRIORITY * priority +
      this.W_PROP_DISTANCE * distance
    );
  }

  /**
   * deltaMeta = quota ideal - share atual de cessão.
   *
   *   share atual = currentCede[loja] / (totalCede + 1)
   *     → divide por (total+1) pra NUNCA dar infinito no primeiro pedido.
   *
   *   Se totalCede=0 (batelada virgem): share=0 pra todos, delta=quota (exato).
   *   Se loja já cedeu muito: share alto → delta negativo → score menor.
   *   Se loja ainda não cedeu: share 0 → delta = quota → score maior.
   */
  private computeDeltaMeta(storeCode: string, cedeStats?: RoutingCedeStats): number {
    if (!cedeStats) return 0;
    const quota = cedeStats.targetQuotaByStore[storeCode] ?? 0;
    const ceded = cedeStats.currentCedeByStore[storeCode] ?? 0;
    const denom = cedeStats.totalCedeSoFar + 1; // +1 pra evitar div/0 no 1º pedido
    const share = ceded / denom;
    return quota - share;
  }

  /**
   * Soma BRUTA do estoque que a loja tem dos SKUs do pedido (sem clamp).
   * É o que define "quem tem mais". Útil também quando o pedido é de 1 SKU:
   *   pedido 1× SKU-X, A=10, B=3 → totalRaw(A)=10, totalRaw(B)=3 → A ganha.
   */
  private totalRawQty(store: StoreInput, items: OrderItemInput[], stockMap: Map<string, number>): number {
    let total = 0;
    for (const item of items) {
      total += stockMap.get(this.stockKey(store.code, item.sku)) ?? 0;
    }
    return total;
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
   *
   * OBJETIVO: MINIMIZAR GASTO COM FRETE (Sedex/PAC).
   *   → Menos lojas envolvidas = menos pacotes postados.
   *   → Sempre escolhe loja que cobre O MAIOR NÚMERO DE SKUs restantes.
   *
   * Desempate (quando 2 lojas cobrem o mesmo # de SKUs):
   *   1. Maior quantidade ABSOLUTA dos SKUs que ela cobre (redundância = segurança
   *      contra concorrência de venda direta na loja física)
   *   2. Maior ratio (elo mais fraco / folga)
   *   3. priorityScore manual
   *   4. Score composto (distância CEP)
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
      let bestCoveredCount = -1;
      let bestCoveredTotalQty = -1;
      let bestRatio = -1;
      let bestPriority = -1;
      let bestScore = -1;

      for (const store of stores) {
        if (usedStores.has(store.id)) continue;

        // O que essa loja cobre do restante?
        const covered: OrderItemInput[] = [];
        let coveredTotalQty = 0;   // soma do estoque BRUTO dos SKUs cobertos
        let minRatio = Infinity;    // folga do elo mais fraco entre cobertos
        for (const [sku, qty] of remaining.entries()) {
          const available = stockMap.get(this.stockKey(store.code, sku)) ?? 0;
          if (available >= qty) {
            // REGRA 4: um SKU é 100% atendido por uma única loja (sem split).
            covered.push({ sku, quantity: qty });
            coveredTotalQty += available;
            const r = available / Math.max(1, qty);
            if (r < minRatio) minRatio = r;
          }
        }
        if (covered.length === 0) continue;

        // Se cedeStats está presente, usa score V2 (inclui delta_meta). Senão,
        // usa scoreStore legado pra compatibilidade total com routing atual.
        const storeScore = ctx.cedeStats
          ? this.scoreStoreV2(store, ctx, stockMap)
          : this.scoreStore(store, ctx, stockMap);
        const ratioNorm = minRatio === Infinity ? 0 : minRatio;

        // Comparação hierárquica (early-return ao achar diferença num nível superior).
        const isBetter =
          covered.length > bestCoveredCount ||
          (covered.length === bestCoveredCount && coveredTotalQty > bestCoveredTotalQty) ||
          (covered.length === bestCoveredCount && coveredTotalQty === bestCoveredTotalQty && ratioNorm > bestRatio) ||
          (covered.length === bestCoveredCount && coveredTotalQty === bestCoveredTotalQty && ratioNorm === bestRatio && store.priorityScore > bestPriority) ||
          (covered.length === bestCoveredCount && coveredTotalQty === bestCoveredTotalQty && ratioNorm === bestRatio && store.priorityScore === bestPriority && storeScore > bestScore);

        if (isBetter) {
          bestStore = store;
          bestCovered = covered;
          bestCoveredCount = covered.length;
          bestCoveredTotalQty = coveredTotalQty;
          bestRatio = ratioNorm;
          bestPriority = store.priorityScore;
          bestScore = storeScore;
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
      const base = {
        storeCode: s.code,
        storeName: s.name,
        priorityScore: Number(priority.toFixed(4)),
        stockBuffer: Number(stockBuffer.toFixed(2)),
        stockBufferScore: Number(stockBufferScore.toFixed(4)),
        distanceScore: Number(distance.toFixed(4)),
        finalScore: Number(finalScore.toFixed(4)),
        fullCoverage: this.canFulfillAll(s.code, ctx.items, stockMap),
      };
      if (ctx.cedeStats) {
        const quota = ctx.cedeStats.targetQuotaByStore[s.code] ?? 0;
        const ceded = ctx.cedeStats.currentCedeByStore[s.code] ?? 0;
        const delta = this.computeDeltaMeta(s.code, ctx.cedeStats);
        return {
          ...base,
          targetQuota: Number(quota.toFixed(4)),
          currentCede: ceded,
          proportionalityDelta: Number(delta.toFixed(4)),
        };
      }
      return base;
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  ROUTING DE PICKUP (retirada em loja)
  //
  //  Fluxo:
  //   1. Se a loja de retirada tem TUDO    → strategy=pickup-lock  (1 assignment nela)
  //   2. Se NÃO tem tudo mas outras lojas cobrem o que falta
  //        → strategy=pickup-transfer (assignments nas outras lojas, TODAS com
  //          isTransfer=true + transferToStoreCode=loja-de-retirada)
  //   3. Se nem com outras dá pra cobrir → strategy=pickup-blocked
  //
  //  Decisão de qual loja FONTE vai fazer a transferência (desempate):
  //   - Maior estoque disponível
  //   - Empate → maior priorityScore (prioridade manual)
  //   (Opção C — sem distância entre lojas porque ainda não temos essa tabela)
  // ═══════════════════════════════════════════════════════════════════════════
  private routePickup(
    ctx: RoutingContext,
    activeStores: StoreInput[],
    stockMap: Map<string, number>,
    allScores: RoutingResult['scoreBreakdown'],
  ): RoutingResult {
    const pickupStoreCode = ctx.pickupStoreCode!;
    const pickupStore = activeStores.find((s) => s.code === pickupStoreCode);

    if (!pickupStore) {
      // Loja de retirada não está ativa ou não existe — bloqueia.
      this.logger.warn(
        `Pickup store ${pickupStoreCode} não encontrada/ativa. Rotando como blocked.`,
      );
      return {
        success: false,
        strategy: 'pickup-blocked',
        assignments: [],
        missing: ctx.items,
        pickupStoreCode,
        pickupStoreName: null,
        scoreBreakdown: allScores,
      };
    }

    // CASO 1 — pickup-lock: loja de retirada cobre TUDO sozinha.
    if (this.canFulfillAll(pickupStore.code, ctx.items, stockMap)) {
      return {
        success: true,
        strategy: 'pickup-lock',
        assignments: [
          {
            ...this.buildAssignment(pickupStore, ctx.items),
            isTransfer: false, // cliente retira direto lá, não é transferência
            transferToStoreCode: null,
            transferToStoreName: null,
          },
        ],
        missing: [],
        pickupStoreCode: pickupStore.code,
        pickupStoreName: pickupStore.name,
        scoreBreakdown: allScores,
      };
    }

    // CASO 2 — pickup-transfer: outras lojas cobrem o que a pickup não tem.
    // Greedy simples: pra cada SKU faltando, acha loja com maior estoque (> qty).
    // Agrupa items por loja fonte escolhida.
    const sourceStores = activeStores.filter((s) => s.code !== pickupStore.code);
    const remaining = new Map<string, number>();
    for (const item of ctx.items) {
      const availAtPickup = stockMap.get(this.stockKey(pickupStore.code, item.sku)) ?? 0;
      if (availAtPickup >= item.quantity) {
        // Pickup já cobre esse SKU — continua, não precisa de transferência.
        continue;
      }
      // Pickup não cobre esse item — precisa vir de outra loja.
      remaining.set(item.sku, item.quantity);
    }

    // Quais SKUs a pickup cobre sozinha? Esses entram num assignment SEM transferência.
    const pickupCoversItems: OrderItemInput[] = ctx.items.filter((i) => !remaining.has(i.sku));

    // MINIMIZA FRETE DE TRANSFERÊNCIA: greedy — a cada rodada escolhe a loja fonte
    // que cobre o MAIOR NÚMERO de SKUs faltantes. Tiebreak = mais estoque absoluto → ratio → prioridade.
    const assignmentsByStore = new Map<string, { store: StoreInput; items: OrderItemInput[] }>();
    const sourceItemsCtx: OrderItemInput[] = Array.from(remaining.entries()).map(
      ([sku, quantity]) => ({ sku, quantity }),
    );

    while (sourceItemsCtx.length > 0) {
      let bestStore: StoreInput | null = null;
      let bestCovered: OrderItemInput[] = [];
      let bestCoveredCount = -1;
      let bestCoveredTotalQty = -1;
      let bestRatio = -1;
      let bestPriority = -1;

      for (const store of sourceStores) {
        if (assignmentsByStore.has(store.code)) continue; // uma loja fonte só entra 1x

        const covered: OrderItemInput[] = [];
        let coveredTotalQty = 0;
        let minRatio = Infinity;
        for (const it of sourceItemsCtx) {
          const avail = stockMap.get(this.stockKey(store.code, it.sku)) ?? 0;
          if (avail >= it.quantity) {
            covered.push(it);
            coveredTotalQty += avail;
            const r = avail / Math.max(1, it.quantity);
            if (r < minRatio) minRatio = r;
          }
        }
        if (covered.length === 0) continue;

        const ratioNorm = minRatio === Infinity ? 0 : minRatio;
        const isBetter =
          covered.length > bestCoveredCount ||
          (covered.length === bestCoveredCount && coveredTotalQty > bestCoveredTotalQty) ||
          (covered.length === bestCoveredCount && coveredTotalQty === bestCoveredTotalQty && ratioNorm > bestRatio) ||
          (covered.length === bestCoveredCount && coveredTotalQty === bestCoveredTotalQty && ratioNorm === bestRatio && store.priorityScore > bestPriority);

        if (isBetter) {
          bestStore = store;
          bestCovered = covered;
          bestCoveredCount = covered.length;
          bestCoveredTotalQty = coveredTotalQty;
          bestRatio = ratioNorm;
          bestPriority = store.priorityScore;
        }
      }

      if (!bestStore || bestCovered.length === 0) break;

      assignmentsByStore.set(bestStore.code, { store: bestStore, items: bestCovered });
      const takenSkus = new Set(bestCovered.map((i) => i.sku));
      for (let i = sourceItemsCtx.length - 1; i >= 0; i--) {
        if (takenSkus.has(sourceItemsCtx[i].sku)) sourceItemsCtx.splice(i, 1);
      }
    }

    const coveredSkus = new Set<string>();
    for (const i of pickupCoversItems) coveredSkus.add(i.sku);
    for (const entry of assignmentsByStore.values()) {
      for (const it of entry.items) coveredSkus.add(it.sku);
    }
    const missing = ctx.items.filter((i) => !coveredSkus.has(i.sku));

    // Se sobrou item sem cobertura → PICKUP_BLOCKED
    if (missing.length > 0) {
      return {
        success: false,
        strategy: 'pickup-blocked',
        assignments: [], // não persiste assignments parciais — operação precisa decidir
        missing,
        pickupStoreCode: pickupStore.code,
        pickupStoreName: pickupStore.name,
        scoreBreakdown: allScores,
      };
    }

    // Monta assignments finais: pickup (sem transferência) + transferências vindas de outras lojas
    const finalAssignments: PickAssignment[] = [];

    if (pickupCoversItems.length > 0) {
      finalAssignments.push({
        ...this.buildAssignment(pickupStore, pickupCoversItems),
        isTransfer: false,
        transferToStoreCode: null,
        transferToStoreName: null,
      });
    }

    for (const entry of assignmentsByStore.values()) {
      finalAssignments.push({
        ...this.buildAssignment(entry.store, entry.items),
        isTransfer: true,
        transferToStoreCode: pickupStore.code,
        transferToStoreName: pickupStore.name,
      });
    }

    return {
      success: true,
      strategy: 'pickup-transfer',
      assignments: finalAssignments,
      missing: [],
      pickupStoreCode: pickupStore.code,
      pickupStoreName: pickupStore.name,
      scoreBreakdown: allScores,
    };
  }
}
