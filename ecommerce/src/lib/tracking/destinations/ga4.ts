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

/**
 * CONTAS DO GOOGLE ADS — plural, de propósito.
 *
 * A rede tem duas: uma pras LOJAS FÍSICAS e outra pro E-COMMERCE. As duas
 * anunciam pro mesmo site, então as duas precisam enxergar o que acontece
 * aqui — senão a conta de lojas fica cega justamente pros sinais que ela
 * deveria otimizar (clique no WhatsApp da unidade, pedido de rota).
 *
 * Aceita lista separada por vírgula:
 *   NEXT_PUBLIC_GOOGLE_ADS_ID=AW-11353612462,AW-878832356
 *
 * ⚠️ O QUE ISTO **NÃO** FAZ: escolher qual conta conta o quê. Os eventos são
 * enviados às duas; quem decide o que vira conversão é a **ação de conversão**
 * configurada dentro de cada conta do Ads. Ou seja: a conta de e-commerce
 * marca `purchase` como conversão, a de lojas marca os eventos de intenção de
 * ir à loja. Se as duas marcarem tudo, as duas vão reportar a mesma venda — e
 * a soma dos dois painéis passa a mentir. Isso é configuração do gestor de
 * tráfego, não tem como o site resolver por ele.
 */
function adsIds(): string[] {
  return (process.env.NEXT_PUBLIC_GOOGLE_ADS_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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
    /**
     * Uma linha de `config` por conta do Ads — é assim que o gtag envia pra
     * mais de uma. Elas são independentes: uma fora do ar não afeta a outra.
     *
     * Enhanced Conversions: a flag liga o recurso, mas quem o alimenta é o
     * `user_data` que sai do SERVIDOR, em `server/ga4-mp.ts`. Tem que ser lá
     * porque o `purchase` é server-side: a compra só é confirmada depois do
     * pagamento, sem navegador aberto. Enquanto esta flag existiu sozinha
     * (até 10/08/2026) o recurso aparecia ativo no painel do Google e não
     * fazia absolutamente nada — não havia dado nenhum chegando pra casar.
     */
    for (const id of adsIds()) {
      gtag()?.('config', id, { allow_enhanced_conversions: true });
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
