/**
 * Tipos usados pelo Routing Engine.
 * Mantê-los aqui (e não no Prisma) torna a engine pura e testável.
 */

export interface OrderItemInput {
  sku: string;
  quantity: number;
}

export interface StoreInput {
  id: string;
  code: string;
  name: string;
  cep?: string | null;
  priorityScore: number;
  active: boolean;
}

/**
 * Item do estoque de uma loja.
 * Obs.: a engine não sabe de onde veio (ERP, cache, mock) — só consome.
 */
export interface StockEntry {
  storeCode: string;
  sku: string;
  availableQty: number;
}

/**
 * Estatísticas de PROPORCIONALIDADE INVERSA pro desempate do routing.
 *
 * - targetQuotaByStore: quota IDEAL de cessão de cada loja (soma=1 nas lojas elegíveis).
 *     Loja que vende MAIS → quota MENOR (cede menos).
 *     Loja que vende MENOS → quota MAIOR (cede mais).
 *
 * - currentCedeByStore: quanto a loja JÁ cedeu NA BATELADA ATUAL (contador
 *     acumulado por loja). Começa zerado a cada batch e incrementa 1 peça por
 *     peça atendida. Usado pra calcular o "deltaMeta" — distância entre quanto
 *     deveria ter cedido e quanto já cedeu até agora.
 *
 * - totalCedeSoFar: total de peças cedidas nessa batelada (soma de currentCede).
 *
 * Essa estrutura é preenchida pela `routing.service.previewBatchForWc()` e
 * ATUALIZADA em memória pedido-a-pedido. O engine usa como desempate após as
 * regras existentes (quantidade absoluta / ratio) quando o placar tá apertado.
 */
export interface RoutingCedeStats {
  targetQuotaByStore: Record<string, number>;
  salesShareByStore?: Record<string, number>;
  currentCedeByStore: Record<string, number>;
  totalCedeSoFar: number;
  /** Janela em dias usada pra calcular salesShare (pra debug/UI). */
  windowDays?: number;
}

export interface RoutingContext {
  items: OrderItemInput[];
  stores: StoreInput[];
  stock: StockEntry[];
  shippingCep?: string | null;
  /**
   * Quando preenchido, ativa a lógica de RETIRADA EM LOJA:
   *   - Se a loja de retirada tem estoque de tudo → single-store nela (strategy=pickup-lock)
   *   - Se NÃO tem → outras lojas separam e ENVIAM PRA LOJA DE RETIRADA (strategy=pickup-transfer)
   *   - Se nem com outras lojas dá pra cobrir tudo → strategy=pickup-blocked
   * Não usa score de distância (cliente nem recebe em casa) — desempate é estoque > prioridade.
   */
  pickupStoreCode?: string | null;
  /**
   * Quando preenchido, ativa o desempate de PROPORCIONALIDADE INVERSA baseada
   * em venda física dos últimos 30d. Só entra em jogo depois dos desempates
   * tradicionais (qty absoluta / ratio) pra preservar a otimização de frete
   * e redundância. Se não passado, routing funciona como antes.
   */
  cedeStats?: RoutingCedeStats;
  /**
   * Override manual: se preenchido E a loja cobre TODOS os itens do pedido,
   * essa loja é escolhida em vez do pickBestStore automático. Permite ao
   * usuário escolher uma loja específica via radio button no frontend.
   * Se não cobrir tudo, o routing volta pro fluxo normal (multi-store ou
   * single-store automático). Ignorado em estratégia pickup.
   */
  preferStoreCode?: string | null;
  /**
   * TROCA MANUAL NO PREVIEW (20/08) — lojas FIXADAS pelo operador no botão
   * "↔ Trocar loja" da tela do pedido. Diferente do `preferStoreCode` (que só
   * vale quando a loja cobre o pedido INTEIRO), a loja fixada entra no plano
   * ANTES de qualquer heurística com as peças que ela tem por inteiro — mesmo
   * cobertura parcial — e o greedy resolve o resto. Combinado com
   * `excludeStoreCodes` (na service) implementa "tira a loja X, põe a Y".
   */
  pinStoreCodes?: string[];
  /**
   * LOJA QUE VENDEU (17/08) — `Order.sellerStoreCode`. No split (REGRA 2) ela
   * entra no plano ANTES do greedy com as peças que já tem: peça na mão de
   * quem vendeu tem frete zero, e mandar buscar em outra loja é desperdício.
   *
   * Diferente do `preferStoreCode`: aquele é override manual da retaguarda e só
   * vale quando a loja cobre o pedido INTEIRO (single-store). Este cobre o caso
   * PARCIAL, que era onde a loja vendedora ficava de fora mesmo tendo metade
   * das peças.
   *
   * No pedido do site é a loja-canal 13 (sem estoque) → semeadura vira no-op e
   * o comportamento do site não muda.
   */
  sellerStoreCode?: string | null;
  /**
   * Kill-switch do SPLIT DE SKU entre lojas. Por padrão (undefined) o split
   * está LIGADO: quando nenhuma loja tem a quantidade inteira de um SKU, a
   * engine divide a quantidade entre várias lojas (o mínimo de pacotes) em vez
   * de dar ruptura falsa. `true` volta ao comportamento antigo (1 SKU = 1 loja,
   * ou ruptura). A service liga/desliga por env `ROUTING_SPLIT_SKU=0`.
   */
  disableSkuSplit?: boolean;
}

export interface PickAssignment {
  storeId: string;
  storeCode: string;
  storeName: string;
  items: OrderItemInput[];
  /** true = loja separa e ENVIA pra outra loja (transferência). false = separa pra envio direto ao cliente. */
  isTransfer?: boolean;
  /** Quando isTransfer=true, código da loja que vai receber a transferência (loja de retirada escolhida pelo cliente). */
  transferToStoreCode?: string | null;
  /** Quando isTransfer=true, nome da loja de retirada pra facilitar a UI / mensagens. */
  transferToStoreName?: string | null;
}

export type RoutingStrategy =
  | 'single-store'
  | 'multi-store'
  | 'insufficient-stock'
  | 'pickup-lock'       // loja de retirada tem tudo → separa lá
  | 'pickup-transfer'   // loja de retirada não tem tudo → outras lojas transferem pra ela
  | 'pickup-blocked';   // nem com transferência cobre tudo

export interface RoutingResult {
  success: boolean;
  strategy: RoutingStrategy;
  assignments: PickAssignment[];
  missing: OrderItemInput[]; // itens que não foram cobertos (em caso de ruptura)
  /** Quando estratégia é pickup-*, código da loja de retirada (pra UI) */
  pickupStoreCode?: string | null;
  pickupStoreName?: string | null;
  scoreBreakdown?: Array<{
    storeCode: string;
    storeName: string;
    priorityScore: number;   // 0..1 (a prioridade manual cadastrada)
    stockBuffer: number;     // folga de estoque (menor ratio disponível/necessário entre os itens, capped em 3)
    stockBufferScore: number;// 0..1 (stockBuffer normalizado)
    distanceScore: number;   // 0..1 (proximidade com o CEP do cliente)
    finalScore: number;      // soma ponderada final (0..1)
    fullCoverage: boolean;   // true se essa loja tem TODOS os itens
    /** Diferença entre quota ideal e cessão atual; positiva = loja está DEVENDO, precisa ceder mais. */
    proportionalityDelta?: number;
    /** Quota ideal (0..1) pra essa loja, baseada na proporcionalidade inversa de venda. */
    targetQuota?: number;
    /** Cessões acumuladas dessa loja na batelada atual. */
    currentCede?: number;
  }>;
}
