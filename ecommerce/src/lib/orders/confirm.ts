import 'server-only';

/**
 * PURCHASE A PARTIR DO WEBHOOK DO BACKEND (Sprint 011).
 *
 * ── POR QUE ESTE ARQUIVO SOBREVIVEU (e o que mudou) ─────────────────────────
 * O antigo `confirmPayment(orderId)` marcava o pedido como pago no store local
 * E emitia o `purchase`. A primeira metade morreu: quem confirma pagamento
 * agora é o backend FlowOps, dono do pedido no Postgres — o ecommerce não tem
 * mais estado nenhum pra transicionar.
 *
 * A segunda metade continua valendo, e por isso o arquivo não virou lixo: o
 * `purchase` é o evento mais delicado do sistema (é ele que alimenta ROAS de
 * Meta e GA4), e ele merece UM lugar só onde é montado. Se essa montagem
 * morasse dentro da rota do webhook, o dia em que existir um segundo gatilho
 * (conciliação manual, reprocessamento de fila) alguém ia copiar e colar a
 * lógica — e purchase copiado e colado é purchase duplicado.
 *
 * Então: virou um HELPER que traduz o corpo do webhook em `trackPurchase`.
 * Zero acesso a store, zero decisão sobre estado de pedido. Ver docs/purchase.md.
 */

import { trackPurchase } from '@/lib/tracking/server/track-server';
import type { TrackedItem } from '@/lib/tracking/types';

/** Item como o backend manda no webhook (vocabulário do tracking, não do carrinho). */
export interface WebhookPurchaseItem {
  product_id: string;
  sku?: string;
  name: string;
  cor?: string;
  tamanho?: string;
  quantidade: number;
  valor: number;
}

/** O bloco `purchase` do corpo do webhook backend → ecommerce. */
export interface WebhookPurchase {
  number: string;
  total: number;
  coupon?: string;
  payment_method: string;
  items: WebhookPurchaseItem[];
  customer: { email?: string; phone?: string; cpf?: string };
  tracking?: {
    anonymous_id?: string;
    session_id?: string;
    fbp?: string;
    fbc?: string;
    /** Cookies do gtag guardados no checkout — sem eles o GA4 não casa a venda. */
    ga4_client_id?: string;
    ga4_session_id?: string;
    attribution?: Record<string, string | undefined>;
  };
  /**
   * Slug da loja quando o pedido é retirada — liga a venda online ao acerto da
   * loja física. Fora do contrato mínimo: se o backend mandar, usamos; se não,
   * o purchase sai sem `loja` (perde-se o corte por unidade, não a venda).
   */
  store_slug?: string;
}

export interface ConfirmResult {
  ok: boolean;
  reason?: string;
}

/**
 * `card` no vocabulário do checkout é `credit_card` no do tracking (GA4/Meta).
 * Tolerante a já vir traduzido — webhook de backend em evolução manda os dois.
 */
function metodoPurchase(method: string): 'pix' | 'credit_card' {
  if (method === 'pix') return 'pix';
  return 'credit_card';
}

function toTrackedItems(items: WebhookPurchaseItem[]): TrackedItem[] {
  return items.map((i) => ({
    product_id: i.product_id,
    sku: i.sku,
    name: i.name,
    cor: i.cor,
    tamanho: i.tamanho,
    quantidade: i.quantidade,
    valor: i.valor,
  }));
}

/**
 * Emite o purchase de um pedido JÁ CONFIRMADO pelo backend.
 *
 * Não valida pagamento — quem valida é o `trackPurchase` (recusa qualquer
 * coisa que não seja `status: 'paid'`) e, antes dele, o backend, que só chama
 * este webhook quando o dinheiro entrou.
 *
 * Idempotência em duas camadas: o `event_id` é derivado do `transaction_id`
 * (retry manda o mesmo id, a Meta conta uma venda só) e a rota do webhook tem
 * um guard em memória pra nem chegar aqui numa rajada de retry.
 */
export async function emitirPurchaseConfirmado(
  orderId: string,
  paidAt: string,
  purchase: WebhookPurchase,
): Promise<ConfirmResult> {
  try {
    const resultado = await trackPurchase({
      // O UUID do pedido é a chave de idempotência — o mesmo dos dois lados.
      transaction_id: orderId,
      value: purchase.total,
      items: toTrackedItems(purchase.items ?? []),
      cupom: purchase.coupon,
      context: {
        // Sem tracking capturado no checkout, um id derivado do pedido mantém
        // o evento válido — a atribuição se perde, a venda não.
        anonymous_id: purchase.tracking?.anonymous_id ?? `order-${orderId}`,
        session_id: purchase.tracking?.session_id,
        // O que costura a compra à visita que veio do anúncio. Vazio aqui =
        // venda contada como tráfego direto no GA4 e invisível pro Ads.
        ga4:
          purchase.tracking?.ga4_client_id || purchase.tracking?.ga4_session_id
            ? {
                client_id: purchase.tracking?.ga4_client_id,
                session_id: purchase.tracking?.ga4_session_id,
              }
            : undefined,
        attribution: purchase.tracking?.attribution,
        loja: purchase.store_slug ?? null,
      },
      user: {
        email: purchase.customer?.email,
        phone: purchase.customer?.phone,
        // CPF como external_id: identifica a PESSOA entre pedidos e canais.
        // Pode ir porque `trackPurchase` → meta-capi faz SHA-256 de TODO
        // external_id antes de sair do servidor — o CPF nunca viaja em claro.
        external_id: purchase.customer?.cpf,
      },
      meta: { fbp: purchase.tracking?.fbp, fbc: purchase.tracking?.fbc },
      payment: {
        status: 'paid',
        method: metodoPurchase(purchase.payment_method),
        confirmed_at: paidAt || new Date().toISOString(),
      },
    });

    return { ok: resultado.ok, reason: resultado.reason };
  } catch (err) {
    // Falha no tracking NUNCA vira erro pro backend: o pedido está pago no
    // Postgres, e devolver erro só faria o backend reenfileirar um retry que
    // não conserta nada. A Meta que espere o próximo ciclo.
    console.error('[orders] purchase não despachado (pedido segue pago):', err);
    return { ok: false, reason: 'falha ao despachar purchase' };
  }
}
