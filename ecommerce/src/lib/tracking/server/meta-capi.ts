import 'server-only';

/**
 * META CONVERSIONS API (servidor).
 *
 * A perna que sobrevive a bloqueador de anúncio, iOS e ao fim do cookie de
 * terceiro — hoje ela entrega mais conversão que o Pixel. As duas mandam o
 * MESMO `event_id`; a Meta cruza e conta uma só.
 *
 * DADO PESSOAL: e-mail e telefone vão SEMPRE em SHA-256, normalizados antes do
 * hash (minúscula, sem espaço, telefone só dígitos com DDI). Hash de string não
 * normalizada não casa com nada — e mandar em texto puro seria vazar dado de
 * cliente pra um terceiro, o que não acontece aqui em hipótese nenhuma.
 */

import type { TrackingEvent } from '../types';

const API_VERSION = 'v21.0';

export interface MetaUserSignals {
  fbp?: string;
  fbc?: string;
  client_ip_address?: string;
  client_user_agent?: string;
  email?: string;
  phone?: string;
  external_id?: string;
}

const META_EVENTS: Record<string, string> = {
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

export function isMetaCapiEnabled(): boolean {
  return Boolean(process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN);
}

/** SHA-256 em hex via Web Crypto — funciona em Node e no runtime Edge. */
async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const normEmail = (v: string) => v.trim().toLowerCase();

/** Telefone: só dígitos, com DDI. Brasileiro sem 55 não casa na base da Meta. */
function normPhone(v: string): string {
  const digits = v.replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('55') ? digits : `55${digits}`;
}

async function buildUserData(event: TrackingEvent, signals: MetaUserSignals): Promise<Record<string, unknown>> {
  const user: Record<string, unknown> = {};

  if (signals.email) user.em = [await sha256(normEmail(signals.email))];
  if (signals.phone) {
    const phone = normPhone(signals.phone);
    if (phone) user.ph = [await sha256(phone)];
  }

  // external_id identifica a pessoa entre sessões. Sem cadastro, o
  // anonymous_id já melhora bastante o casamento — e não é dado pessoal.
  const externalId = signals.external_id || event.context.user_id || event.context.anonymous_id;
  if (externalId) user.external_id = [await sha256(externalId)];

  if (signals.fbp) user.fbp = signals.fbp;
  if (signals.fbc) user.fbc = signals.fbc;
  if (signals.client_ip_address) user.client_ip_address = signals.client_ip_address;
  if (signals.client_user_agent) user.client_user_agent = signals.client_user_agent;

  return user;
}

function buildCustomData(event: TrackingEvent): Record<string, unknown> {
  const items = event.items ?? [];
  const custom: Record<string, unknown> = { ...event.params, currency: event.context.currency };

  if (event.value !== undefined) custom.value = event.value;
  if (event.transaction_id) custom.order_id = event.transaction_id;

  if (items.length) {
    custom.content_type = 'product';
    custom.content_ids = items.map((i) => i.sku || i.product_id);
    custom.contents = items.map((i) => ({ id: i.sku || i.product_id, quantity: i.quantidade, item_price: i.valor }));
    custom.content_name = items[0].name;
    if (items[0].categoria) custom.content_category = items[0].categoria;
    if (custom.value === undefined) {
      custom.value = Math.round(items.reduce((s, i) => s + i.valor * i.quantidade, 0) * 100) / 100;
    }
  }
  return custom;
}

export interface CapiResult {
  ok: boolean;
  status: number;
  error?: string;
  received?: number;
}

/** Envia um lote. A Meta aceita até 1.000 eventos por chamada. */
export async function sendToMetaCapi(events: TrackingEvent[], signals: MetaUserSignals): Promise<CapiResult> {
  const pixelId = process.env.META_PIXEL_ID!;
  const token = process.env.META_CAPI_TOKEN!;
  const testCode = process.env.META_CAPI_TEST_CODE;

  const data = await Promise.all(
    events.map(async (event) => ({
      event_name: META_EVENTS[event.event] ?? event.event,
      // Unix em SEGUNDOS. Em milissegundos a Meta recusa o lote inteiro.
      event_time: Math.floor(new Date(event.timestamp).getTime() / 1000),
      event_id: event.event_id,
      event_source_url: event.context.page.url,
      action_source: 'website',
      user_data: await buildUserData(event, signals),
      custom_data: buildCustomData(event),
    })),
  );

  const body: Record<string, unknown> = { data };
  if (testCode) body.test_event_code = testCode;

  const res = await fetch(`https://graph.facebook.com/${API_VERSION}/${pixelId}/events?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // A Meta às vezes demora; sem teto a função serverless estoura antes.
    signal: AbortSignal.timeout(8_000),
  });

  const json = (await res.json().catch(() => ({}))) as { events_received?: number; error?: { message?: string } };
  return {
    ok: res.ok,
    status: res.status,
    received: json.events_received,
    error: res.ok ? undefined : json.error?.message || `HTTP ${res.status}`,
  };
}
