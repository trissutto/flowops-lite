/**
 * DATA LAYER PRÓPRIO.
 *
 * A spec é explícita: nunca depender exclusivamente do GTM. O motivo é
 * prático — bloqueador de anúncio derruba o `gtm.js` em boa parte do tráfego, e
 * quando o data layer mora dentro do GTM, o site fica sem histórico nenhum pra
 * depurar. Aqui o histórico é nosso: vive em memória, alimenta o painel de
 * debug e continua existindo mesmo com todo script de terceiro bloqueado.
 *
 * O espelho pro `window.dataLayer` é de mão única e opcional: se o GTM estiver
 * lá, ele recebe; se não estiver, nada acontece. Nunca lemos de volta.
 */

import type { TrackingEvent } from './types';

/** Últimos N eventos. Suficiente pra depurar uma sessão sem virar vazamento. */
const MAX_ENTRIES = 200;

type DataLayerListener = (event: TrackingEvent) => void;

const entries: TrackingEvent[] = [];
const listeners = new Set<DataLayerListener>();

declare global {
  interface Window {
    dataLayer?: unknown[];
    /** Espelho de leitura pro time de marketing inspecionar no console. */
    lurdsDataLayer?: TrackingEvent[];
  }
}

/** Empurra o evento pro histórico, avisa os ouvintes e espelha pro GTM. */
export function pushToDataLayer(event: TrackingEvent): void {
  entries.push(event);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

  if (typeof window !== 'undefined') {
    window.lurdsDataLayer = entries;
    // GTM entende o formato achatado; o aninhado fica em `lurds` pra quem
    // quiser montar variável customizada sem depender do formato do GA4.
    try {
      window.dataLayer?.push({
        event: event.event,
        event_id: event.event_id,
        ecommerce: event.items ? { currency: event.context.currency, value: event.value, items: event.items } : undefined,
        lurds: event,
      });
    } catch {
      /* dataLayer quebrado por terceiro — o nosso histórico não se perde */
    }
  }

  listeners.forEach((fn) => {
    try {
      fn(event);
    } catch {
      /* ouvinte com defeito não derruba o despacho */
    }
  });
}

/** Cópia do histórico — o painel de debug lê por aqui. */
export function getDataLayer(): TrackingEvent[] {
  return [...entries];
}

export function subscribeDataLayer(fn: DataLayerListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clearDataLayer(): void {
  entries.length = 0;
  if (typeof window !== 'undefined') window.lurdsDataLayer = entries;
}
