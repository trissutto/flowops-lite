/**
 * CONTRATO DE EVENTOS — a fonte da verdade do rastreamento.
 *
 * Regra da Sprint 007: nenhum componente fala com Meta, Google ou TikTok.
 * Todo evento nasce aqui, com este formato, e o Event Manager decide pra onde
 * vai. Quem quiser rastrear algo novo declara o evento NESTE arquivo primeiro —
 * evento fora da lista é recusado na validação, de propósito: é assim que a
 * taxonomia não vira sopa de letrinha depois de seis meses de sprint.
 *
 * Os nomes seguem o padrão GA4 (snake_case, e-commerce) porque é o vocabulário
 * mais próximo de "neutro" que existe: o mapa pra Meta/TikTok fica dentro de
 * cada destino, não espalhado pelo app.
 */

import { z } from 'zod';

/* ────────────────────────────────────────────────────────────────────────────
 * Eventos
 * ──────────────────────────────────────────────────────────────────────────── */

/** Eventos de catálogo padrão do mercado (GA4 / Meta / TikTok entendem todos). */
export const STANDARD_EVENTS = [
  'page_view',
  'view_item',
  'view_item_list',
  'search',
  'select_item',
  'add_to_wishlist',
  'remove_from_wishlist',
  'add_to_cart',
  'remove_from_cart',
  'view_cart',
  'begin_checkout',
  'add_shipping_info',
  'add_payment_info',
  'purchase',
  'refund',
  'login',
  'logout',
  'sign_up',
  'generate_lead',
  'contact',
] as const;

/** Eventos de engajamento e de canal — o que a Lurd's mede além da compra. */
export const ENGAGEMENT_EVENTS = [
  'store_locator',
  'whatsapp_click',
  'instagram_click',
  'phone_click',
  'share_product',
  'video_watched',
  'time_on_page',
  'scroll_depth',
  'newsletter_signup',
  'coupon_applied',
  'coupon_removed',
  'filter_used',
  'sort_changed',
  'buy_look',
  'quick_view',
  'store_reservation',
  'buy_and_pickup',
] as const;

/**
 * Eventos próprios da marca. Não existem em plataforma nenhuma — vão pro GA4
 * como evento customizado e pra Meta como custom event. São eles que respondem
 * as perguntas que só a Lurd's faz ("tecido pesa na decisão?", "quem usa a
 * consultora compra mais?").
 */
export const LURDS_EVENTS = [
  'view_look',
  'view_fabric',
  'view_collection',
  'view_occasion',
  'body_shape_filter',
  'ai_consultant',
  'virtual_fitting',
  'size_guide',
  'color_switch',
  'size_switch',
  'store_availability',
] as const;

export const ALL_EVENTS = [...STANDARD_EVENTS, ...ENGAGEMENT_EVENTS, ...LURDS_EVENTS] as const;

export type EventName = (typeof ALL_EVENTS)[number];

const eventNameSchema = z.enum(ALL_EVENTS);

/**
 * Eventos que SÓ podem nascer no servidor. O navegador é território hostil:
 * qualquer pessoa com o console aberto dispara um `purchase` de R$ 50 mil e
 * contamina o ROAS de todas as campanhas. Compra e estorno saem do backend,
 * depois da confirmação do pagamento — nunca do clique.
 */
export const SERVER_ONLY_EVENTS: readonly EventName[] = ['purchase', 'refund'];

/* ────────────────────────────────────────────────────────────────────────────
 * Consentimento
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Categorias da LGPD. `necessary` nunca é negociável (é o que faz o site
 * funcionar); as outras três começam NEGADAS e só ligam com ação da visitante.
 */
export const CONSENT_CATEGORIES = ['necessary', 'analytics', 'marketing', 'personalization'] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

export const consentStateSchema = z.object({
  necessary: z.literal(true),
  analytics: z.boolean(),
  marketing: z.boolean(),
  personalization: z.boolean(),
  /** ISO — quando a visitante decidiu. Prova de consentimento pra LGPD. */
  decided_at: z.string().nullable(),
  /** Versão do texto aceito; subir a versão faz o banner voltar a perguntar. */
  version: z.number().int(),
});
export type ConsentState = z.infer<typeof consentStateSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Contexto (o "quem/onde/como" que acompanha TODO evento)
 * ──────────────────────────────────────────────────────────────────────────── */

export const pageContextSchema = z.object({
  path: z.string(),
  url: z.string(),
  title: z.string().optional(),
  referrer: z.string().optional(),
});

export const deviceContextSchema = z.object({
  type: z.enum(['mobile', 'tablet', 'desktop']),
  viewport: z.object({ w: z.number().int(), h: z.number().int() }).optional(),
  language: z.string().optional(),
  timezone: z.string().optional(),
});

/**
 * Atribuição. Capturada na PRIMEIRA página da sessão e carimbada em todos os
 * eventos seguintes — senão o purchase (que acontece 4 páginas depois) aparece
 * como tráfego direto e a campanha que pagou pela venda não recebe o crédito.
 */
export const attributionSchema = z.object({
  source: z.string().optional(),
  medium: z.string().optional(),
  campaign: z.string().optional(),
  term: z.string().optional(),
  content: z.string().optional(),
  gclid: z.string().optional(),
  fbclid: z.string().optional(),
  landing_page: z.string().optional(),
});

export const eventContextSchema = z.object({
  session_id: z.string(),
  anonymous_id: z.string(),
  user_id: z.string().nullable(),
  page: pageContextSchema,
  device: deviceContextSchema,
  attribution: attributionSchema,
  /** Loja física atribuída à visitante (por CEP) — liga o online ao acerto. */
  loja: z.string().nullable(),
  currency: z.string().default('BRL'),
  language: z.string().default('pt-BR'),
  country: z.string().default('BR'),
});
export type EventContext = z.infer<typeof eventContextSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Item de catálogo
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `valor` é SEMPRE o preço unitário em reais, já com desconto aplicado, como
 * número — nunca string formatada. Preço com vírgula chegando em plataforma de
 * anúncio vira `NaN` em silêncio e o ROAS some sem ninguém notar.
 */
export const trackedItemSchema = z.object({
  product_id: z.string(),
  sku: z.string().optional(),
  name: z.string(),
  categoria: z.string().optional(),
  colecao: z.string().optional(),
  tecido: z.string().optional(),
  cor: z.string().optional(),
  tamanho: z.string().optional(),
  quantidade: z.number().int().positive().default(1),
  valor: z.number().nonnegative(),
  desconto: z.number().nonnegative().optional(),
  /** Posição na lista de onde a peça foi clicada (0-based) — mede vitrine. */
  index: z.number().int().nonnegative().optional(),
  list_name: z.string().optional(),
});
export type TrackedItem = z.infer<typeof trackedItemSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Envelope
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `event_id` é o coração da deduplicação: o MESMO id vai no Pixel (browser) e
 * na CAPI (servidor). A Meta recebe os dois, reconhece o par e conta UMA
 * conversão. Sem isso, todo purchase conta em dobro.
 */
export const trackingEventSchema = z.object({
  event: eventNameSchema,
  event_id: z.string().min(8),
  timestamp: z.string(),
  context: eventContextSchema,
  params: z.record(z.string(), z.unknown()).default({}),
  items: z.array(trackedItemSchema).optional(),
  /** Soma da transação (purchase/refund/checkout) em reais. */
  value: z.number().nonnegative().optional(),
  cupom: z.string().optional(),
  /** Id do pedido — chave de idempotência do purchase. */
  transaction_id: z.string().optional(),
  /** De onde o evento partiu; o servidor confia só no que ele mesmo criou. */
  source: z.enum(['browser', 'server']).default('browser'),
});
export type TrackingEvent = z.infer<typeof trackingEventSchema>;

/** Lote enviado ao `/api/events`. Limite protege contra payload gigante. */
export const eventBatchSchema = z.object({
  events: z.array(trackingEventSchema).min(1).max(50),
  consent: consentStateSchema,
});
export type EventBatch = z.infer<typeof eventBatchSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Log de despacho
 * ──────────────────────────────────────────────────────────────────────────── */

export type DispatchStatus = 'success' | 'error' | 'skipped' | 'retrying';

export interface DispatchLog {
  id: string;
  event_id: string;
  event: EventName;
  /** 'meta_capi' | 'ga4_mp' | 'meta_pixel' | … */
  destination: string;
  status: DispatchStatus;
  /** Milissegundos da chamada ao destino. */
  duration_ms: number;
  attempt: number;
  error?: string;
  /** Motivo do skip (sem consentimento, destino desligado, evento ignorado). */
  reason?: string;
  payload?: unknown;
  created_at: string;
}
