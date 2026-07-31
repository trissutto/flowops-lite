import 'server-only';

/**
 * PAGAR.ME — o gateway REAL do checkout (decisão do dono, 31/07/2026:
 * "estrutura pagar.me, checkout transparente, sem sair da página e sem pedir
 * dados da cliente de novo — igual ao WordPress de hoje").
 *
 * Mesma API v5 que o FlowOps já usa no PIX da live (backend/src/pagarme/):
 *   - Auth: Basic com a Secret Key como usuário e senha vazia;
 *   - sk_test_* = sandbox · sk_* = produção (mesma URL, a chave decide);
 *   - PIX dinâmico funciona em produção sem homologação prévia.
 *
 * TRANSPARENTE DE VERDADE (modelo PCI do plugin do Woo): o NAVEGADOR tokeniza
 * o cartão direto na Pagar.me com a Public Key (pk_) — número/CVV nunca tocam
 * o nosso servidor. Aqui chega só o `card_token`, que vale uma única cobrança.
 *
 * VALOR COBRADO = `order.total` como item único. Mandar as peças como itens
 * separados obrigaria a redistribuir desconto de cupom e frete linha a linha
 * (a API soma os itens), e qualquer arredondamento cobraria diferente do que a
 * cliente viu. Item único garante o centavo exato; o detalhe das peças vai em
 * `metadata` pra conciliação.
 */

import { confirmPayment } from '@/lib/orders/confirm';
import { getOrderStore } from '@/lib/orders/store';
import type { Order, OrderStatus } from '@/types/checkout';
import { buildCardPayment, buildOrderPayload, buildPixPayment, PIX_EXPIRES_SECONDS } from './pagarme-payload';
import type { CardChargeResult, PaymentProvider, PixCharge } from './provider';

const BASE_URL = 'https://api.pagar.me/core/v5';

export function isPagarmeConfigured(): boolean {
  return Boolean(process.env.PAGARME_SECRET_KEY);
}

function authHeader(): string {
  const sk = process.env.PAGARME_SECRET_KEY ?? '';
  return `Basic ${Buffer.from(`${sk}:`).toString('base64')}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Chamada HTTP
 * ──────────────────────────────────────────────────────────────────────────── */

interface PagarmeOrderResponse {
  id?: string;
  status?: string; // 'paid' | 'pending' | 'failed' | 'canceled'
  charges?: Array<{
    id?: string;
    status?: string;
    last_transaction?: {
      status?: string;
      qr_code?: string;
      qr_code_url?: string;
      expires_at?: string;
      acquirer_message?: string;
      gateway_response?: { errors?: Array<{ message?: string }> };
    };
  }>;
  message?: string;
}

async function pagarmeFetch(path: string, init?: RequestInit): Promise<PagarmeOrderResponse> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    // A Pagar.me às vezes demora; sem teto a função serverless estoura antes.
    signal: AbortSignal.timeout(12_000),
  });
  const json = (await res.json().catch(() => ({}))) as PagarmeOrderResponse;
  if (!res.ok) {
    const motivo = json.message || `HTTP ${res.status}`;
    throw new Error(`Pagar.me: ${motivo}`);
  }
  return json;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Provider
 * ──────────────────────────────────────────────────────────────────────────── */

export class PagarmeProvider implements PaymentProvider {
  readonly id = 'pagarme';

  async createPixCharge(order: Order): Promise<PixCharge> {
    const payload = { ...buildOrderPayload(order), payments: [buildPixPayment()] };
    const resp = await pagarmeFetch('/orders', { method: 'POST', body: JSON.stringify(payload) });

    const tx = resp.charges?.[0]?.last_transaction;
    if (!resp.id || !tx?.qr_code) {
      throw new Error('Pagar.me criou a order mas não devolveu o QR do PIX');
    }

    return {
      copyPaste: tx.qr_code,
      txid: resp.charges?.[0]?.id ?? resp.id,
      expiresAt: tx.expires_at ?? new Date(Date.now() + PIX_EXPIRES_SECONDS * 1000).toISOString(),
      gatewayOrderId: resp.id,
    };
  }

  /**
   * Cobrança de cartão — síncrona: a resposta já diz pago ou recusado.
   * Recusa NÃO é exceção (é fluxo normal de checkout) — volta como resultado
   * com a mensagem elegante pra UI.
   */
  async createCardCharge(order: Order, cardToken: string, installments: number): Promise<CardChargeResult> {
    const payload = {
      ...buildOrderPayload(order),
      payments: [buildCardPayment(order, cardToken, installments)],
    };
    const resp = await pagarmeFetch('/orders', { method: 'POST', body: JSON.stringify(payload) });

    if (resp.status === 'paid') {
      return { status: 'paid', gatewayOrderId: resp.id ?? '' };
    }

    // Recusado/failed: loga o motivo TÉCNICO (sem PII) e devolve o elegante.
    const tx = resp.charges?.[0]?.last_transaction;
    console.log(
      JSON.stringify({
        tag: 'pagarme_card_refused',
        at: new Date().toISOString(),
        order_number: order.number,
        gateway_order: resp.id,
        acquirer: tx?.acquirer_message,
        errors: tx?.gateway_response?.errors?.map((e) => e.message),
      }),
    );
    return {
      status: 'refused',
      gatewayOrderId: resp.id ?? '',
      reason:
        'O cartão não foi autorizado pela operadora. Confira os dados ou tente outro cartão — e, se preferir, o Pix aprova na hora.',
    };
  }

  /**
   * Poll do PixPanel. O webhook é o caminho principal; isto é a rede de
   * segurança pra webhook atrasado (mesma filosofia do reconcile da live).
   */
  async checkStatus(order: Order): Promise<OrderStatus> {
    if (order.status !== 'awaiting_payment') return order.status;
    const gatewayId = order.payment.gatewayOrderId;
    if (!gatewayId) return order.status;

    const resp = await pagarmeFetch(`/orders/${gatewayId}`, { method: 'GET' });

    if (resp.status === 'paid') {
      await confirmPayment(order.id);
      return 'paid';
    }
    if (resp.status === 'canceled' || resp.status === 'failed') {
      await getOrderStore().markExpired(order.id);
      return 'expired';
    }
    // PIX vencido pelo relógio local enquanto o gateway ainda diz pending:
    // deixa o gateway mandar — expirar cedo demais mata pagamento no limite.
    return 'awaiting_payment';
  }
}
