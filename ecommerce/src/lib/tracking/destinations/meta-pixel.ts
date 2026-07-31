/**
 * META PIXEL (navegador).
 *
 * A metade browser do par Pixel + CAPI. As duas pernas mandam o MESMO
 * `event_id` — é isso, e só isso, que faz a Meta contar uma conversão em vez
 * de duas. Se algum dia alguém disparar `fbq` direto de um componente, sem id,
 * o número de compras da conta infla e ninguém descobre por semanas.
 */

import type { EventName, TrackingEvent } from '../types';
import { loadScript, type Destination } from './types';

/** Canônico → nome padrão da Meta. Fora daqui vira `trackCustom`. */
const META_EVENTS: Partial<Record<EventName, string>> = {
  page_view: 'PageView',
  view_item: 'ViewContent',
  view_item_list: 'ViewCategory',
  search: 'Search',
  add_to_cart: 'AddToCart',
  add_to_wishlist: 'AddToWishlist',
  begin_checkout: 'InitiateCheckout',
  add_payment_info: 'AddPaymentInfo',
  purchase: 'Purchase',
  sign_up: 'CompleteRegistration',
  generate_lead: 'Lead',
  contact: 'Lead',
  store_reservation: 'Schedule',
};

function pixelId(): string {
  return process.env.NEXT_PUBLIC_META_PIXEL_ID || '';
}

function fbq(): ((...args: unknown[]) => void) | undefined {
  return (window as unknown as { fbq?: (...args: unknown[]) => void }).fbq;
}

export const metaPixel: Destination = {
  id: 'meta_pixel',
  label: 'Meta Pixel',
  consent: 'marketing',

  isEnabled: () => Boolean(pixelId()),

  init() {
    if (typeof window === 'undefined' || fbq()) return;

    // Stub oficial da Meta: enfileira chamadas até o script real chegar, então
    // podemos disparar eventos no mesmo tick sem perder nada.
    const w = window as unknown as Record<string, unknown>;
    const n: ((...args: unknown[]) => void) & { queue?: unknown[]; loaded?: boolean; version?: string; push?: unknown } =
      function (...args: unknown[]) {
        (n.queue as unknown[]).push(args);
      };
    n.queue = [];
    n.loaded = true;
    n.version = '2.0';
    n.push = n;
    w.fbq = n;
    w._fbq = w._fbq || n;

    loadScript('https://connect.facebook.net/en_US/fbevents.js', 'meta-pixel-sdk');

    // Sem PageView automático: quem manda page_view é o Event Manager, e ele
    // precisa carimbar event_id pra casar com a CAPI.
    fbq()?.('init', pixelId());
  },

  accepts: () => true,

  send(event: TrackingEvent) {
    const f = fbq();
    if (!f) throw new Error('fbq indisponível (script bloqueado ou ainda carregando)');

    const standard = META_EVENTS[event.event];
    const payload = buildPayload(event);
    // 3º argumento — o eventID — é o que fecha a deduplicação com a CAPI.
    f(standard ? 'track' : 'trackCustom', standard ?? event.event, payload, { eventID: event.event_id });
  },
};

function buildPayload(event: TrackingEvent): Record<string, unknown> {
  const items = event.items ?? [];
  const payload: Record<string, unknown> = {
    ...event.params,
    currency: event.context.currency,
  };

  if (event.value !== undefined) payload.value = event.value;

  if (items.length) {
    payload.content_type = 'product';
    payload.content_ids = items.map((i) => i.sku || i.product_id);
    payload.contents = items.map((i) => ({
      id: i.sku || i.product_id,
      quantity: i.quantidade,
      item_price: i.valor,
    }));
    payload.content_name = items[0].name;
    if (items[0].categoria) payload.content_category = items[0].categoria;
    // Valor não informado explicitamente: soma a partir dos itens, senão o
    // ROAS da campanha fica zerado no Gerenciador.
    if (payload.value === undefined) {
      payload.value = Math.round(items.reduce((s, i) => s + i.valor * i.quantidade, 0) * 100) / 100;
    }
  }

  if (event.transaction_id) payload.order_id = event.transaction_id;
  return payload;
}
