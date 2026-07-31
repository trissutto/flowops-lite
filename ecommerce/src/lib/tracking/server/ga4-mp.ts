import 'server-only';

/**
 * GA4 MEASUREMENT PROTOCOL (servidor).
 *
 * Complementa o gtag do navegador nos casos em que ele não roda: bloqueador
 * ativo e, principalmente, `purchase` — que nasce no servidor quando o
 * pagamento confirma, e nunca no navegador.
 *
 * PEGADINHA do MP: ele responde 204 pra QUASE tudo, inclusive payload inválido.
 * "Sem erro" não significa "foi aceito". A única forma de conferir de verdade é
 * o endpoint `/debug/mp/collect`, que é o que `GA4_MP_DEBUG=1` usa.
 */

import type { TrackedItem, TrackingEvent } from '../types';

export function isGa4MpEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_GA4_ID && process.env.GA4_API_SECRET);
}

export interface Ga4Result {
  ok: boolean;
  status: number;
  error?: string;
}

function toItem(item: TrackedItem, index: number): Record<string, unknown> {
  return {
    item_id: item.sku || item.product_id,
    item_name: item.name,
    item_category: item.categoria,
    item_variant: [item.cor, item.tamanho].filter(Boolean).join(' / ') || undefined,
    index: item.index ?? index,
    price: item.valor,
    discount: item.desconto,
    quantity: item.quantidade,
    item_brand: "Lurd's Plus Size",
  };
}

/**
 * O MP aceita um `client_id` por chamada, então agrupamos por visitante.
 * `client_id` PRECISA ser o mesmo do gtag do navegador, senão a mesma pessoa
 * vira dois usuários e a sessão se parte em duas no relatório.
 */
export async function sendToGa4Mp(events: TrackingEvent[]): Promise<Ga4Result> {
  const measurementId = process.env.NEXT_PUBLIC_GA4_ID!;
  const apiSecret = process.env.GA4_API_SECRET!;
  const debug = process.env.GA4_MP_DEBUG === '1';

  const path = debug ? '/debug/mp/collect' : '/mp/collect';
  const url = `https://www.google-analytics.com${path}?measurement_id=${measurementId}&api_secret=${apiSecret}`;

  const porCliente = new Map<string, TrackingEvent[]>();
  for (const ev of events) {
    const key = ev.context.anonymous_id;
    porCliente.set(key, [...(porCliente.get(key) ?? []), ev]);
  }

  let lastStatus = 204;
  let firstError: string | undefined;

  for (const [clientId, doCliente] of porCliente) {
    const body = {
      client_id: clientId,
      user_id: doCliente[0].context.user_id ?? undefined,
      // Sem isso o GA4 marca tudo como "(not set)" na dimensão de sessão.
      events: doCliente.map((ev) => ({
        name: ev.event,
        params: {
          ...ev.params,
          session_id: ev.context.session_id,
          engagement_time_msec: 1,
          currency: ev.context.currency,
          value: ev.value,
          transaction_id: ev.transaction_id,
          coupon: ev.cupom,
          page_location: ev.context.page.url,
          page_title: ev.context.page.title,
          items: ev.items?.map(toItem),
        },
      })),
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });

    lastStatus = res.status;

    if (debug) {
      const json = (await res.json().catch(() => ({}))) as { validationMessages?: Array<{ description?: string }> };
      const problema = json.validationMessages?.[0]?.description;
      if (problema && !firstError) firstError = problema;
    } else if (!res.ok) {
      firstError ??= `HTTP ${res.status}`;
    }
  }

  return { ok: !firstError, status: lastStatus, error: firstError };
}
