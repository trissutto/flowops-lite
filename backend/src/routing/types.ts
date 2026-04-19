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

export interface RoutingContext {
  items: OrderItemInput[];
  stores: StoreInput[];
  stock: StockEntry[];
  shippingCep?: string | null;
}

export interface PickAssignment {
  storeId: string;
  storeCode: string;
  storeName: string;
  items: OrderItemInput[];
}

export interface RoutingResult {
  success: boolean;
  strategy: 'single-store' | 'multi-store' | 'insufficient-stock';
  assignments: PickAssignment[];
  missing: OrderItemInput[]; // itens que não foram cobertos (em caso de ruptura)
  scoreBreakdown?: Array<{
    storeCode: string;
    storeName: string;
    priorityScore: number;   // 0..1 (a prioridade manual cadastrada)
    stockBuffer: number;     // folga de estoque (menor ratio disponível/necessário entre os itens, capped em 3)
    stockBufferScore: number;// 0..1 (stockBuffer normalizado)
    distanceScore: number;   // 0..1 (proximidade com o CEP do cliente)
    finalScore: number;      // soma ponderada final (0..1)
    fullCoverage: boolean;   // true se essa loja tem TODOS os itens
  }>;
}
