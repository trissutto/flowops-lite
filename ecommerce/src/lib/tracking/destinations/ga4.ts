/**
 * GOOGLE ANALYTICS 4 + GOOGLE ADS (navegador).
 *
 * Nossa taxonomia já nasceu em dialeto GA4, então aqui quase não há tradução —
 * o trabalho é montar o bloco `items` no formato do e-commerce e repassar.
 *
 * `send_page_view: false` é proposital: o gtag dispara page_view sozinho no
 * carregamento, o que num app de rota client-side gera uma pageview a menos
 * (a primeira) e nenhuma nas trocas de rota. Quem manda page_view é o
 * TrackingProvider, que enxerga toda navegação.
 */

import type { TrackingEvent, TrackedItem } from '../types';
import { loadScript, type Destination } from './types';

function measurementId(): string {
  return process.env.NEXT_PUBLIC_GA4_ID || '';
}

function adsId(): string {
  return process.env.NEXT_PUBLIC_GOOGLE_ADS_ID || '';
}

function gtag(): ((...args: unknown[]) => void) | undefined {
  return (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
}

export const ga4: Destination = {
  id: 'ga4',
  label: 'GA4 / Google Ads',
  consent: 'analytics',

  isEnabled: () => Boolean(measurementId()),

  init() {
    if (typeof window === 'undefined') return;

    // O dataLayer e a função gtag já foram criados pelo bootstrap de consent no
    // <head> — o `default: denied` PRECISA existir antes deste script.
    const w = window as unknown as { dataLayer?: unknown[]; gtag?: (...a: unknown[]) => void };
    w.dataLayer = w.dataLayer || [];
    if (!w.gtag) {
      w.gtag = function (...args: unknown[]) {
        w.dataLayer!.push(args);
      };
    }

    loadScript(`https://www.googletagmanager.com/gtag/js?id=${measurementId()}`, 'ga4-sdk');

    gtag()?.('js', new Date());
    gtag()?.('config', measurementId(), { send_page_view: false });
    if (adsId()) {
      // Enhanced Conversions liga aqui; os dados do usuário vão por evento.
      gtag()?.('config', adsId(), { allow_enhanced_conversions: true });
    }
  },

  accepts: () => true,

  send(event: TrackingEvent) {
    const g = gtag();
    if (!g) throw new Error('gtag indisponível (script bloqueado ou ainda carregando)');

    const payload: Record<string, unknown> = {
      ...event.params,
      currency: event.context.currency,
      session_id: event.context.session_id,
      // Mesmo id do Pixel/CAPI — permite cruzar as plataformas na auditoria.
      event_id: event.event_id,
    };

    if (event.value !== undefined) payload.value = event.value;
    if (event.transaction_id) payload.transaction_id = event.transaction_id;
    if (event.cupom) payload.coupon = event.cupom;
    if (event.context.user_id) payload.user_id = event.context.user_id;
    if (event.items?.length) payload.items = event.items.map(toGa4Item);

    g('event', event.event, payload);
  },
};

/** Nosso item → item do GA4. Os campos da marca viram dimensões customizadas. */
function toGa4Item(item: TrackedItem, index: number): Record<string, unknown> {
  return {
    item_id: item.sku || item.product_id,
    item_name: item.name,
    item_category: item.categoria,
    item_variant: [item.cor, item.tamanho].filter(Boolean).join(' / ') || undefined,
    item_list_name: item.list_name,
    index: item.index ?? index,
    price: item.valor,
    discount: item.desconto,
    quantity: item.quantidade,
    // Dimensões customizadas — registrar no painel do GA4 pra aparecerem.
    item_brand: "Lurd's Plus Size",
    tecido: item.tecido,
    colecao: item.colecao,
  };
}
