// Enums em string — SQLite não suporta enums nativos no Prisma,
// então mantemos as constantes aqui para tipagem segura.

export const OrderStatus = {
  pending: 'pending',           // aguardando pagamento
  processing: 'processing',     // PAGO - pronto pra separar
  routing: 'routing',
  awaiting_stock: 'awaiting_stock',
  separating: 'separating',
  ready: 'ready',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
  failed: 'failed',             // falha de pagto / problema
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const PickStatus = {
  new: 'new',
  separating: 'separating',
  ready: 'ready',
  shipped: 'shipped',
} as const;
export type PickStatus = (typeof PickStatus)[keyof typeof PickStatus];

export const Role = {
  admin: 'admin',
  operator: 'operator',
  store: 'store',
} as const;
export type Role = (typeof Role)[keyof typeof Role];
