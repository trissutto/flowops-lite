/**
 * HELPERS SEMÂNTICOS — a API que os componentes realmente usam.
 *
 * Um componente NUNCA chama `track('view_item', {...})` na mão: chama
 * `trackViewItem(produto)`. A diferença importa por dois motivos:
 *
 *   1. o formato do item fica num lugar só. Quando a Meta mudar o que espera em
 *      `contents`, muda aqui — não em 40 componentes;
 *   2. a regra de negócio de cada evento fica explícita e testável. `add_to_cart`
 *      só dispara DEPOIS que a peça entrou no carrinho, `purchase` não existe no
 *      cliente — isso está escrito no tipo, não num comentário de PR.
 */

'use client';

import { track, type TrackOptions } from './event-manager';
import type { EventName, TrackedItem } from './types';
import type { CheckoutErrorCode } from '@/types/checkout';

/* ────────────────────────────────────────────────────────────────────────────
 * Adaptador de produto
 * ──────────────────────────────────────────────────────────────────────────── */

/** O mínimo que um produto precisa ter pra virar item rastreado. */
export interface TrackableProduct {
  id: string | number;
  sku?: string;
  name: string;
  price: number;
  salePrice?: number;
  category?: string;
  collection?: string;
  fabric?: string;
}

export function toTrackedItem(
  product: TrackableProduct,
  extra: { cor?: string; tamanho?: string; quantidade?: number; index?: number; list_name?: string } = {},
): TrackedItem {
  // `valor` é o que a cliente PAGA — com promoção aplicada. Mandar o preço
  // cheio infla o ROAS e a campanha parece melhor do que é.
  const valor = product.salePrice ?? product.price;
  return {
    product_id: String(product.id),
    sku: product.sku,
    name: product.name,
    categoria: product.category,
    colecao: product.collection,
    tecido: product.fabric,
    cor: extra.cor,
    tamanho: extra.tamanho,
    quantidade: extra.quantidade ?? 1,
    valor,
    desconto: product.salePrice ? Math.round((product.price - product.salePrice) * 100) / 100 : undefined,
    index: extra.index,
    list_name: extra.list_name,
  };
}

const somaItens = (items: TrackedItem[]) =>
  Math.round(items.reduce((s, i) => s + i.valor * i.quantidade, 0) * 100) / 100;

/* ────────────────────────────────────────────────────────────────────────────
 * Navegação
 * ──────────────────────────────────────────────────────────────────────────── */

export const trackPageView = (params: { path: string; title?: string } = { path: '/' }) =>
  track('page_view', { page_path: params.path, page_title: params.title });

export const trackScrollDepth = (percent: 25 | 50 | 75 | 100, path: string) =>
  // Um evento com parâmetro, não quatro eventos. No GA4 vira um relatório só,
  // com a profundidade como dimensão — bem mais útil que 4 linhas soltas.
  track('scroll_depth', { percent, page_path: path }, { dedupe_key: `scroll:${path}:${percent}` });

export const trackTimeOnPage = (seconds: number, path: string) =>
  track('time_on_page', { seconds, page_path: path }, { dedupe_key: `time:${path}:${Math.round(seconds)}` });

/* ────────────────────────────────────────────────────────────────────────────
 * Catálogo
 * ──────────────────────────────────────────────────────────────────────────── */

export const trackViewItem = (product: TrackableProduct, extra?: { cor?: string; tamanho?: string }) => {
  const item = toTrackedItem(product, extra);
  track('view_item', {}, { items: [item], value: item.valor });
};

export const trackViewItemList = (products: TrackableProduct[], listName: string) =>
  track(
    'view_item_list',
    { item_list_name: listName, item_count: products.length },
    { items: products.slice(0, 20).map((p, i) => toTrackedItem(p, { index: i, list_name: listName })) },
  );

export const trackSelectItem = (product: TrackableProduct, listName: string, index: number) =>
  track('select_item', { item_list_name: listName }, { items: [toTrackedItem(product, { index, list_name: listName })] });

export const trackQuickView = (product: TrackableProduct) =>
  track('quick_view', {}, { items: [toTrackedItem(product)] });

export const trackSearch = (termo: string, resultados: number) =>
  track('search', { search_term: termo, results_count: resultados }, { dedupe_key: `search:${termo}` });

export const trackFilterUsed = (filtro: string, valor: string | string[]) =>
  track('filter_used', { filter_name: filtro, filter_value: Array.isArray(valor) ? valor.join(',') : valor });

export const trackSortChanged = (ordem: string) => track('sort_changed', { sort_by: ordem });

/* ────────────────────────────────────────────────────────────────────────────
 * Carrinho e lista de desejos
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ Chamar SÓ depois que a peça entrou no carrinho de verdade. Se a API
 * recusar (sem estoque, tamanho esgotado), NÃO chamar — a spec é explícita, e
 * medir intenção como se fosse ação estraga toda a análise de funil.
 */
/**
 * `origem` diz POR ONDE a peça entrou na sacola — e existe pra não repetir o
 * erro de 16/08, quando a folha de tamanhos derrubou o `add_to_cart_blocked` e
 * isso foi lido como conserto: o erro sumiu porque o clique mudou de nome, e a
 * conversão peça→sacola caiu junto. Com a barra fixa virando seletor (22/08) o
 * mesmo risco volta, então a barra CARIMBA a origem: dá pra medir se ela está
 * puxando venda ou só apagando o evento.
 */
export const trackAddToCart = (
  product: TrackableProduct,
  extra: { cor?: string; tamanho?: string; quantidade?: number; origem?: 'barra' | 'botao' | 'folha' } = {},
) => {
  const { origem, ...doItem } = extra;
  const item = toTrackedItem(product, doItem);
  track('add_to_cart', origem ? { origem } : {}, { items: [item], value: item.valor * item.quantidade });
};

/** Idem: só após a remoção acontecer. */
export const trackRemoveFromCart = (product: TrackableProduct, extra: { cor?: string; tamanho?: string; quantidade?: number } = {}) => {
  const item = toTrackedItem(product, extra);
  track('remove_from_cart', {}, { items: [item], value: item.valor * item.quantidade });
};

export const trackViewCart = (items: TrackedItem[]) =>
  track('view_cart', { item_count: items.length }, { items, value: somaItens(items) });

export const trackAddToWishlist = (product: TrackableProduct) => {
  const item = toTrackedItem(product);
  track('add_to_wishlist', {}, { items: [item], value: item.valor });
};

export const trackRemoveFromWishlist = (product: TrackableProduct) =>
  track('remove_from_wishlist', {}, { items: [toTrackedItem(product)] });

/* ────────────────────────────────────────────────────────────────────────────
 * Checkout — tudo menos o purchase, que é do servidor
 * ──────────────────────────────────────────────────────────────────────────── */

export const trackBeginCheckout = (items: TrackedItem[], cupom?: string) =>
  track('begin_checkout', {}, { items, value: somaItens(items), cupom });

export const trackAddShippingInfo = (items: TrackedItem[], metodo: string, frete: number) =>
  track('add_shipping_info', { shipping_tier: metodo, shipping_value: frete }, { items, value: somaItens(items) });

export const trackAddPaymentInfo = (items: TrackedItem[], metodo: string) =>
  track('add_payment_info', { payment_type: metodo }, { items, value: somaItens(items) });

export const trackCouponApplied = (cupom: string, desconto: number) =>
  track('coupon_applied', { coupon: cupom, discount_value: desconto });

export const trackCouponRemoved = (cupom: string) => track('coupon_removed', { coupon: cupom });

/* ────────────────────────────────────────────────────────────────────────────
 * Conta
 * ──────────────────────────────────────────────────────────────────────────── */

export const trackLogin = (metodo: string) => track('login', { method: metodo });
export const trackLogout = () => track('logout', {});
export const trackSignUp = (metodo: string) => track('sign_up', { method: metodo });
export const trackNewsletter = (origem: string) => track('newsletter_signup', { source: origem });
export const trackGenerateLead = (origem: string, valor?: number) => track('generate_lead', { source: origem }, { value: valor });

/* ────────────────────────────────────────────────────────────────────────────
 * Canais e lojas
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ A UNIDADE VIAJA EM `store`, SEMPRE COM O MESMO NOME.
 *
 * É esse campo que a tela de cliques da retaguarda agrupa e que a dimensão
 * personalizada do GA4 lê. Chamar de `loja` num evento e `store` noutro faz a
 * coluna vir vazia sem erro nenhum — foi o que aconteceu com a dimensão criada
 * em 13/08, registrada como `loja` enquanto o código mandava `store`.
 *
 * `store` opcional no Instagram e no "Como chegar" porque os dois também são
 * clicados fora de uma unidade (o Instagram da marca no rodapé, por exemplo).
 * Nesses casos a linha entra agrupada em "—" na tela, em vez de sumir.
 */
export const trackWhatsAppClick = (origem: string, loja?: string) => track('whatsapp_click', { source: origem, store: loja });
export const trackInstagramClick = (origem: string, loja?: string) => track('instagram_click', { source: origem, store: loja });
export const trackPhoneClick = (loja: string, origem?: string) => track('phone_click', { store: loja, source: origem });
export const trackStoreLocator = (cidade?: string, loja?: string, origem?: string) =>
  track('store_locator', { city: cidade, store: loja, source: origem });
export const trackStoresOnlineCta = (sourcePosition: string, loja?: string) =>
  track('stores_online_cta_click', { source_position: sourcePosition, store: loja });
export const trackStoresProductClick = (product: TrackableProduct, index: number, loja?: string) =>
  track(
    'stores_product_click',
    { source_position: 'products_section', store: loja, product_ref: product.sku ?? product.id, item_index: index },
    { items: [toTrackedItem(product, { index, list_name: 'Lojas — novidades' })] },
  );
export const trackStoreAvailability = (product: TrackableProduct, loja: string, disponivel: boolean) =>
  track('store_availability', { store: loja, available: disponivel }, { items: [toTrackedItem(product)] });
export const trackStoreReservation = (product: TrackableProduct, loja: string) =>
  track('store_reservation', { store: loja }, { items: [toTrackedItem(product)] });
export const trackBuyAndPickup = (items: TrackedItem[], loja: string) =>
  track('buy_and_pickup', { store: loja }, { items, value: somaItens(items) });
export const trackContact = (canal: string) => track('contact', { channel: canal });

/* ────────────────────────────────────────────────────────────────────────────
 * Conteúdo e eventos da marca
 * ──────────────────────────────────────────────────────────────────────────── */

export const trackShareProduct = (product: TrackableProduct, canal: string) =>
  track('share_product', { method: canal }, { items: [toTrackedItem(product)] });

export const trackVideoWatched = (id: string, titulo: string, percent: number) =>
  track('video_watched', { video_id: id, video_title: titulo, percent }, { dedupe_key: `video:${id}:${percent}` });

export const trackViewLook = (lookId: string, nome: string) => track('view_look', { look_id: lookId, look_name: nome });
export const trackBuyLook = (lookId: string, items: TrackedItem[]) =>
  track('buy_look', { look_id: lookId }, { items, value: somaItens(items) });
export const trackViewFabric = (tecido: string) => track('view_fabric', { fabric: tecido });
export const trackViewCollection = (colecao: string) => track('view_collection', { collection: colecao });
export const trackViewOccasion = (ocasiao: string) => track('view_occasion', { occasion: ocasiao });
export const trackBodyShapeFilter = (formato: string) => track('body_shape_filter', { body_shape: formato });
export const trackSizeGuide = (product?: TrackableProduct) =>
  track('size_guide', {}, product ? { items: [toTrackedItem(product)] } : {});
export const trackColorSwitch = (product: TrackableProduct, cor: string) =>
  track('color_switch', { color: cor }, { items: [toTrackedItem(product, { cor })] });
export const trackSizeSwitch = (product: TrackableProduct, tamanho: string) =>
  track('size_switch', { size: tamanho }, { items: [toTrackedItem(product, { tamanho })] });
export const trackAddToCartBlocked = (product: TrackableProduct, reason: 'size_missing' | 'sold_out' | 'color_missing') =>
  track('add_to_cart_blocked', { reason }, { items: [toTrackedItem(product)] });
export const trackCheckoutSubmission = (method: 'pix' | 'card') =>
  track('checkout_submission', { method });
export const trackCheckoutError = (
  method: 'pix' | 'card',
  reason: CheckoutErrorCode,
  context?: { stage?: string; order_id?: string; attempt?: number; field?: string },
) => track('checkout_error', {
  method,
  reason,
  stage: context?.stage ?? 'submission',
  ...(context?.order_id ? { order_id: context.order_id } : {}),
  ...(context?.attempt ? { attempt: context.attempt } : {}),
  // Nome do campo que o server reprovou (nunca o valor) — é o que faz o
  // painel dizer "Dados do pedido incompletos · número" em vez de só a
  // primeira metade.
  ...(context?.field ? { field: context.field } : {}),
});
export const trackCheckoutValidationError = (section: 'identification' | 'shipping' | 'card', field: string) =>
  track('checkout_validation_error', { section, field: field.slice(0, 40) });
/**
 * COTAÇÃO CAIU NO PARAQUEDAS (17/08): o backend do frete não respondeu (429,
 * timeout, fora) e o site mostrou a tabela local. É evento NOSSO, de
 * infraestrutura — não é a cliente errando um campo. Antes ia como
 * `checkout_validation_error` e o painel do funil, que agrupa por campo,
 * contava "cotação caiu" como erro de validação de quem compra.
 */
export const trackShippingQuoteFallback = (motivo: string) =>
  track('shipping_quote_fallback', { motivo: motivo.slice(0, 40) });
export const trackPixCreated = () => track('pix_created', { method: 'pix' });
export const trackPaymentMethodSelected = (method: 'pix' | 'card') =>
  track('payment_method_selected', { method });
export const trackPixCopied = (orderId: string) =>
  track('pix_copied', { method: 'pix', order_id: orderId });
export const trackPixExpired = (orderId: string) =>
  track('pix_expired', { method: 'pix', order_id: orderId });
export const trackCardDeclined = (attempt: number) =>
  track('card_declined', { method: 'card', attempt });
export const trackPaymentRetry = (method: 'pix' | 'card', attempt: number) =>
  track('payment_retry', { method, attempt });
export const trackCheckoutRecovered = (method: 'pix' | 'card', orderId: string) =>
  track('checkout_recovered', { method, order_id: orderId });
export const trackAiConsultant = (acao: string) => track('ai_consultant', { action: acao });
export const trackVirtualFitting = (product: TrackableProduct) =>
  track('virtual_fitting', {}, { items: [toTrackedItem(product)] });

/* ────────────────────────────────────────────────────────────────────────────
 * Escotilha de escape
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Para evento novo que ainda não ganhou helper. Continua passando por validação
 * e consentimento — só pula o açúcar sintático. Se você usar isto duas vezes
 * pro mesmo evento, é sinal de que falta um helper acima.
 */
export const trackCustom = (event: EventName, params?: Record<string, unknown>, options?: TrackOptions) =>
  track(event, params, options);
