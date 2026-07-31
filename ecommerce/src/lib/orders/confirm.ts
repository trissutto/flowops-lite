import 'server-only';

/**
 * CONFIRMAÇÃO DE PAGAMENTO — o ÚNICO caminho que marca um pedido como pago.
 *
 * Webhook do gateway, auto-confirm do mock, futura conciliação manual: todos
 * chamam esta função. Concentrar aqui garante que:
 *   1. a idempotência mora num lugar só (pedido já pago → no-op — webhook
 *      repete, e repete MESMO);
 *   2. o `purchase` dispara exatamente uma vez por venda, e SÓ com pagamento
 *      confirmado — a regra da spec que o tracking inteiro protege.
 */

import { getOrderStore } from '@/lib/orders/store';
import { trackPurchase } from '@/lib/tracking/server/track-server';
import type { TrackedItem } from '@/lib/tracking/types';
import type { Order } from '@/types/checkout';

export interface ConfirmResult {
  ok: boolean;
  /** true = já estava pago; a chamada foi um no-op (idempotência). */
  already?: boolean;
  reason?: string;
}

/** CartLine → TrackedItem: o vocabulário do pedido vira o do tracking. */
function toTrackedItems(order: Order): TrackedItem[] {
  return order.items.map((line) => ({
    product_id: line.productId,
    name: line.name,
    cor: line.color,
    tamanho: line.size,
    quantidade: line.quantity,
    valor: line.unitPrice,
  }));
}

function metodoPurchase(method: Order['payment']['method']): 'pix' | 'credit_card' | 'boleto' {
  return method === 'card' ? 'credit_card' : method;
}

export async function confirmPayment(orderId: string): Promise<ConfirmResult> {
  const store = getOrderStore();
  const order = await store.get(orderId);

  if (!order) return { ok: false, reason: 'pedido não encontrado' };
  if (order.status === 'paid') return { ok: true, already: true };
  if (order.status === 'cancelled') return { ok: false, reason: 'pedido cancelado não pode ser pago' };
  // `expired` NÃO recusa de propósito: PIX pago no último segundo chega ao
  // webhook depois do nosso relógio expirar o pedido. Dinheiro entrou → pago.

  const pago = await store.markPaid(orderId);
  if (!pago) return { ok: false, reason: 'pedido sumiu entre o get e o markPaid' };

  // ── purchase — emitido AQUI e em nenhum outro lugar ──────────────────────
  // Falha no tracking NUNCA desfaz o pagamento: o pedido está pago, a Meta
  // que espere o retry. Por isso o try/catch engole e só loga.
  try {
    await trackPurchase({
      transaction_id: pago.id,
      value: pago.total,
      items: toTrackedItems(pago),
      cupom: pago.couponCode,
      context: {
        // Sem tracking capturado no checkout, um id derivado do pedido mantém
        // o evento válido — a atribuição se perde, a venda não.
        anonymous_id: pago.tracking?.anonymous_id ?? `order-${pago.id}`,
        session_id: pago.tracking?.session_id,
        attribution: pago.tracking?.attribution,
        // Retirada em loja liga a venda online ao acerto da loja física.
        loja: pago.shipping.storeSlug ?? null,
      },
      user: {
        email: pago.customer.email,
        phone: pago.customer.phone,
        // CPF como external_id: identifica a PESSOA entre pedidos e canais.
        // Pode ir porque `trackPurchase` → meta-capi faz SHA-256 de TODO
        // external_id antes de sair do servidor — o CPF nunca viaja em claro.
        external_id: pago.customer.cpf,
      },
      meta: { fbp: pago.tracking?.fbp, fbc: pago.tracking?.fbc },
      payment: {
        status: 'paid',
        method: metodoPurchase(pago.payment.method),
        confirmed_at: pago.paidAt ?? new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[orders] purchase não despachado (pedido segue pago):', err);
  }

  return { ok: true };
}
