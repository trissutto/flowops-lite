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
 *
 * ⚠️ ESTE ARQUIVO NÃO IMPORTA ZOD. Ele é alcançado pelo TrackingProvider, que
 * mora no layout raiz — ou seja, tudo que entra aqui entra no bundle de TODAS
 * as páginas. O zod sozinho eram 74 KB (23% do JS da home). Os schemas vivem
 * em `schemas.ts` e são usados onde o dado é DE FATO não confiável: a rota
 * `/api/events`. No cliente, `consent.ts` e `event-manager.ts` usam guardas
 * escritas à mão.
 *
 * Mexeu num tipo daqui? Mexa no schema equivalente em `schemas.ts` — eles são
 * amarrados por `satisfies z.ZodType<...>`, então divergência quebra o build.
 */

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

export interface ConsentState {
  necessary: true;
  analytics: boolean;
  marketing: boolean;
  personalization: boolean;
  /** ISO — quando a visitante decidiu. Prova de consentimento pra LGPD. */
  decided_at: string | null;
  /** Versão do texto aceito; subir a versão faz o banner voltar a perguntar. */
  version: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Contexto (o "quem/onde/como" que acompanha TODO evento)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PageContext {
  path: string;
  url: string;
  title?: string;
  referrer?: string;
}

export type DeviceType = 'mobile' | 'tablet' | 'desktop';

export interface DeviceContext {
  type: DeviceType;
  viewport?: { w: number; h: number };
  language?: string;
  timezone?: string;
}

/**
 * Atribuição. Capturada na PRIMEIRA página da sessão e carimbada em todos os
 * eventos seguintes — senão o purchase (que acontece 4 páginas depois) aparece
 * como tráfego direto e a campanha que pagou pela venda não recebe o crédito.
 */
export interface Attribution {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
  /**
   * `utm_id` — o ID da campanha no Meta (`{{campaign.id}}`). O backend já
   * gravava isso em `Order.utmId`, mas o campo não existia aqui: o dado
   * chegava na URL e era descartado antes de virar pedido. Nome do parâmetro é
   * `id` (não `utmId`) porque `LojaOrdersService` lê `attr.id`.
   */
  id?: string;
  gclid?: string;
  fbclid?: string;
  landing_page?: string;
}

export interface EventContext {
  session_id: string;
  anonymous_id: string;
  user_id: string | null;
  page: PageContext;
  device: DeviceContext;
  attribution: Attribution;
  /** Loja física atribuída à visitante (por CEP) — liga o online ao acerto. */
  loja: string | null;
  /** Os três abaixo têm default no schema (BRL / pt-BR / BR), por isso não são
      opcionais: depois de validado, o evento SEMPRE os traz preenchidos. */
  currency: string;
  language: string;
  country: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Item de catálogo
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `valor` é SEMPRE o preço unitário em reais, já com desconto aplicado, como
 * número — nunca string formatada. Preço com vírgula chegando em plataforma de
 * anúncio vira `NaN` em silêncio e o ROAS some sem ninguém notar.
 */
export interface TrackedItem {
  product_id: string;
  sku?: string;
  name: string;
  categoria?: string;
  colecao?: string;
  tecido?: string;
  cor?: string;
  tamanho?: string;
  quantidade: number;
  valor: number;
  desconto?: number;
  /** Posição na lista de onde a peça foi clicada (0-based) — mede vitrine. */
  index?: number;
  list_name?: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Envelope
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `event_id` é o coração da deduplicação: o MESMO id vai no Pixel (browser) e
 * na CAPI (servidor). A Meta recebe os dois, reconhece o par e conta UMA
 * conversão. Sem isso, todo purchase conta em dobro.
 */
export type EventSource = 'browser' | 'server';

export interface TrackingEvent {
  event: EventName;
  /** Mínimo de 8 caracteres — validado no schema. */
  event_id: string;
  timestamp: string;
  context: EventContext;
  params: Record<string, unknown>;
  items?: TrackedItem[];
  /** Soma da transação (purchase/refund/checkout) em reais. */
  value?: number;
  cupom?: string;
  /** Id do pedido — chave de idempotência do purchase. */
  transaction_id?: string;
  /** De onde o evento partiu; o servidor confia só no que ele mesmo criou. */
  source: EventSource;
}

/** Lote enviado ao `/api/events`. Limite protege contra payload gigante. */
export interface EventBatch {
  events: TrackingEvent[];
  consent: ConsentState;
}

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
