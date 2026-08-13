import 'server-only';

/**
 * EVENTOS QUE NASCEM NO SERVIDOR — `purchase` e `refund`.
 *
 * A regra da spec, ao pé da letra: purchase só dispara com PIX confirmado,
 * cartão aprovado ou PIX compensado. Nunca na criação do pedido, nunca no
 * início do checkout. Por isso ele não existe no cliente: a única forma de
 * emitir é chamar `trackPurchase` daqui, e o lugar certo pra isso é o webhook
 * do gateway — não a página de obrigado, que a cliente pode recarregar dez
 * vezes ou abrir sem ter pago.
 *
 * O `event_id` é derivado do id do pedido, não aleatório. Assim, se o webhook
 * repetir (e ele repete), a Meta recebe o mesmo id e conta uma venda só.
 */

import { dispatchBatch } from './dispatch';
import { persistirEventosSite } from './flowops-store';
import type { MetaUserSignals } from './meta-capi';
import type { EventContext, TrackedItem, TrackingEvent } from '../types';

export interface ServerPurchaseInput {
  transaction_id: string;
  value: number;
  items: TrackedItem[];
  cupom?: string;
  /** Contexto capturado no checkout — sem ele a atribuição se perde. */
  context: Partial<EventContext> & { anonymous_id: string };
  /** Dados da compradora pro Advanced Matching (vão em hash na CAPI). */
  user?: { email?: string; phone?: string; external_id?: string };
  /** `_fbp` / `_fbc` guardados junto com o pedido no checkout. */
  meta?: { fbp?: string; fbc?: string };
  /** Confirmação do pagamento. Obrigatória e conferida abaixo. */
  payment: { status: 'paid'; method: 'pix' | 'credit_card'; confirmed_at: string };
}

function fullContext(partial: ServerPurchaseInput['context']): EventContext {
  return {
    session_id: partial.session_id ?? `server-${partial.anonymous_id}`,
    anonymous_id: partial.anonymous_id,
    user_id: partial.user_id ?? null,
    page: partial.page ?? { path: '/checkout/confirmacao', url: 'https://www.lurdsplussize.com.br/checkout/confirmacao' },
    device: partial.device ?? { type: 'desktop' },
    attribution: partial.attribution ?? {},
    loja: partial.loja ?? null,
    currency: partial.currency ?? 'BRL',
    language: partial.language ?? 'pt-BR',
    country: partial.country ?? 'BR',
  };
}

/**
 * Emite o purchase. Recusa qualquer coisa que não seja pagamento confirmado —
 * a checagem é aqui, no ponto de emissão, e não em quem chama: guarda que
 * depende de disciplina de quem integra é guarda que um dia falha.
 */
export async function trackPurchase(input: ServerPurchaseInput): Promise<{ ok: boolean; reason?: string }> {
  if (input.payment?.status !== 'paid') {
    return { ok: false, reason: 'purchase só é emitido com pagamento confirmado' };
  }
  if (!input.transaction_id) {
    return { ok: false, reason: 'transaction_id é obrigatório (é a chave de idempotência)' };
  }

  const event: TrackingEvent = {
    event: 'purchase',
    // Derivado do pedido: webhook repetido gera o MESMO id e não duplica.
    event_id: `purchase-${input.transaction_id}`,
    timestamp: input.payment.confirmed_at || new Date().toISOString(),
    context: fullContext(input.context),
    params: { payment_method: input.payment.method },
    items: input.items,
    value: input.value,
    cupom: input.cupom,
    transaction_id: input.transaction_id,
    source: 'server',
  };

  const signals: MetaUserSignals = {
    ...input.meta,
    email: input.user?.email,
    phone: input.user?.phone,
    external_id: input.user?.external_id,
  };

  /**
   * A cópia de primeira parte TAMBÉM recebe o purchase (13/08): o funil da
   * retaguarda fecha da visita à compra no NOSSO banco. Sem isto a última
   * etapa ficava estruturalmente zerada — o purchase nasce aqui no servidor
   * e nunca passa pelo `/api/events` do navegador. Vai o mínimo de sempre
   * (REFs, valor, sessão) — e-mail/telefone ficam só nos sinais das
   * plataformas.
   */
  await Promise.allSettled([
    dispatchBatch([event], signals),
    persistirEventosSite([event], false),
  ]);
  return { ok: true };
}

export interface ServerRefundInput {
  transaction_id: string;
  value: number;
  items?: TrackedItem[];
  context: Partial<EventContext> & { anonymous_id: string };
  /** Estorno parcial devolve só parte do pedido — muda o valor, não o id. */
  partial?: boolean;
}

/**
 * Estorno. Preparado pra ligar no ERP (a troca/devolução já existe no FlowOps);
 * hoje só emite quando alguém chama.
 */
export async function trackRefund(input: ServerRefundInput): Promise<{ ok: boolean; reason?: string }> {
  if (!input.transaction_id) return { ok: false, reason: 'transaction_id é obrigatório' };

  const event: TrackingEvent = {
    event: 'refund',
    event_id: `refund-${input.transaction_id}${input.partial ? `-${Math.round(input.value * 100)}` : ''}`,
    timestamp: new Date().toISOString(),
    context: fullContext(input.context),
    params: { partial: Boolean(input.partial) },
    items: input.items,
    value: input.value,
    transaction_id: input.transaction_id,
    source: 'server',
  };

  await dispatchBatch([event], {});
  return { ok: true };
}
