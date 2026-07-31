/**
 * TIKTOK PIXEL — arquitetura preparada, desligada por padrão.
 *
 * A spec pede "preparar arquitetura", não ligar. Como o destino só acorda com
 * `NEXT_PUBLIC_TIKTOK_PIXEL_ID` preenchida, ele fica invisível no fluxo até
 * alguém decidir usar: sem custo de bundle relevante, sem chamada, sem log.
 * Quando ligar, a Events API (server-side) entra em `server/dispatch.ts` no
 * mesmo molde da CAPI, reaproveitando o `event_id` que já existe.
 */

import type { EventName, TrackingEvent } from '../types';
import { loadScript, type Destination } from './types';

const TIKTOK_EVENTS: Partial<Record<EventName, string>> = {
  page_view: 'Pageview',
  view_item: 'ViewContent',
  search: 'Search',
  add_to_wishlist: 'AddToWishlist',
  add_to_cart: 'AddToCart',
  begin_checkout: 'InitiateCheckout',
  add_payment_info: 'AddPaymentInfo',
  purchase: 'CompletePayment',
  sign_up: 'CompleteRegistration',
  generate_lead: 'SubmitForm',
  contact: 'Contact',
};

function pixelId(): string {
  return process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID || '';
}

function ttq(): { track?: (...a: unknown[]) => void; page?: () => void } | undefined {
  return (window as unknown as { ttq?: { track?: (...a: unknown[]) => void; page?: () => void } }).ttq;
}

export const tiktok: Destination = {
  id: 'tiktok',
  label: 'TikTok Pixel',
  consent: 'marketing',

  isEnabled: () => Boolean(pixelId()),

  init() {
    if (typeof window === 'undefined' || ttq()) return;
    loadScript(`https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${pixelId()}&lib=ttq`, 'tiktok-sdk');
  },

  /** Só os eventos que o TikTok entende — custom no TikTok é pouco útil. */
  accepts: (event: EventName) => event in TIKTOK_EVENTS,

  send(event: TrackingEvent) {
    const q = ttq();
    if (!q?.track) throw new Error('ttq indisponível');

    const name = TIKTOK_EVENTS[event.event];
    if (!name) return;

    if (event.event === 'page_view') {
      q.page?.();
      return;
    }

    q.track(
      name,
      {
        contents: (event.items ?? []).map((i) => ({
          content_id: i.sku || i.product_id,
          content_name: i.name,
          content_type: 'product',
          quantity: i.quantidade,
          price: i.valor,
        })),
        value: event.value,
        currency: event.context.currency,
      },
      { event_id: event.event_id },
    );
  },
};
