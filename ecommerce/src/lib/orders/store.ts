import 'server-only';

/**
 * ARMAZENAMENTO DE PEDIDOS.
 *
 * ⚠️ LIMITE REAL, DECLARADO DE PROPÓSITO: a implementação padrão guarda em
 * MEMÓRIA. Na Vercel cada instância serverless tem a sua, elas somem quando a
 * função hiberna e não há garantia de que duas requisições caiam na mesma.
 * Um pedido criado numa instância pode "não existir" no poll seguinte. Isso é
 * bom o bastante pra desenvolver e demonstrar o fluxo completo — e NÃO é
 * storage de produção pra dinheiro de verdade.
 *
 * Por isso existem duas coisas aqui:
 *   1. `OrderStore`, a interface — trocar por Postgres é implementar 5 métodos
 *      e mudar uma linha em `getOrderStore()`. Nada mais no código muda.
 *   2. `console.log` estruturado em produção a cada transição de status — o
 *      Vercel captura stdout de forma durável, então mesmo sem banco existe
 *      trilha auditável de todo pedido que mudou de estado.
 *
 * Quando o Postgres entrar, o caminho é uma tabela `orders` com índice em
 * (status, created_at) e o webhook/cron lendo de lá — mesma filosofia do
 * outbox do FlowOps.
 */

import type { Order, OrderStatus } from '@/types/checkout';

export interface OrderStore {
  create(order: Order): Promise<Order>;
  get(id: string): Promise<Order | undefined>;
  list(): Promise<Order[]>;
  /** Transição awaiting_payment → paid. Devolve o pedido atualizado. */
  markPaid(id: string): Promise<Order | undefined>;
  /** Transição awaiting_payment → expired (PIX venceu sem pagamento). */
  markExpired(id: string): Promise<Order | undefined>;
}

const MAX_IN_MEMORY = 500;

/**
 * Trilha durável de transição — uma linha JSON por mudança de status.
 * Sem PII de propósito: id e número bastam pra cruzar com o pedido; nome,
 * e-mail e CPF NUNCA entram em log de aplicação.
 */
function logTransition(order: Order, from: OrderStatus | null, to: OrderStatus): void {
  if (process.env.NODE_ENV !== 'production') return;
  console.log(
    JSON.stringify({
      tag: 'order_event',
      order_id: order.id,
      number: order.number,
      from,
      to,
      total: order.total,
      method: order.payment.method,
      at: new Date().toISOString(),
    }),
  );
}

class InMemoryOrderStore implements OrderStore {
  private orders = new Map<string, Order>();

  async create(order: Order): Promise<Order> {
    this.orders.set(order.id, order);
    logTransition(order, null, order.status);

    // Teto de memória: descarta os mais antigos (Map preserva ordem de inserção).
    if (this.orders.size > MAX_IN_MEMORY) {
      const excedente = this.orders.size - MAX_IN_MEMORY;
      let i = 0;
      for (const key of this.orders.keys()) {
        if (i++ >= excedente) break;
        this.orders.delete(key);
      }
    }
    return order;
  }

  async get(id: string): Promise<Order | undefined> {
    return this.orders.get(id);
  }

  async list(): Promise<Order[]> {
    return [...this.orders.values()].reverse(); // mais recentes primeiro
  }

  async markPaid(id: string): Promise<Order | undefined> {
    const order = this.orders.get(id);
    if (!order) return undefined;
    if (order.status === 'paid') return order; // idempotente por construção

    const from = order.status;
    order.status = 'paid';
    order.paidAt = new Date().toISOString();
    logTransition(order, from, 'paid');
    return order;
  }

  async markExpired(id: string): Promise<Order | undefined> {
    const order = this.orders.get(id);
    if (!order) return undefined;
    // Expirar só faz sentido a partir de "aguardando" — pago não expira.
    if (order.status !== 'awaiting_payment') return order;

    order.status = 'expired';
    logTransition(order, 'awaiting_payment', 'expired');
    return order;
  }
}

// Módulo é reavaliado a cada hot-reload em dev; guardar no globalThis evita
// perder os pedidos a cada salvamento de arquivo (mesmo padrão do log-store).
const globalRef = globalThis as unknown as { __lurdsOrderStore?: OrderStore };
const store: OrderStore = globalRef.__lurdsOrderStore ?? new InMemoryOrderStore();
globalRef.__lurdsOrderStore = store;

export function getOrderStore(): OrderStore {
  return store;
}
