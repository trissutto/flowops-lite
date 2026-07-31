/**
 * CONTRATO DE DESTINO.
 *
 * Um destino é um plugue: sabe carregar seu script, sabe traduzir o nosso
 * evento canônico pro dialeto da plataforma e sabe qual consentimento exige.
 * Nada além disso. Ligar uma plataforma nova é escrever um arquivo e registrar
 * na lista — sem tocar em componente, em página ou no Event Manager.
 */

import type { ConsentCategory, EventName, TrackingEvent } from '../types';

export interface Destination {
  /** Id curto usado no log e no painel de debug (`meta_pixel`, `ga4`, …). */
  id: string;
  label: string;
  /** Categoria da LGPD sem a qual este destino não recebe NADA. */
  consent: ConsentCategory;
  /** False quando falta a variável de ambiente — some do fluxo sem erro. */
  isEnabled(): boolean;
  /** Carrega o script da plataforma. Chamado no máximo uma vez. */
  init(): void;
  /** Nem todo destino quer todo evento (Clarity não quer `scroll_depth`). */
  accepts(event: EventName): boolean;
  /** Entrega o evento. Pode lançar — quem chama trata e registra o log. */
  send(event: TrackingEvent): void;
}

/** Carrega script externo uma única vez, mesmo com chamadas concorrentes. */
const loading = new Set<string>();

export function loadScript(src: string, id: string): void {
  if (typeof document === 'undefined' || loading.has(id) || document.getElementById(id)) return;
  loading.add(id);
  const el = document.createElement('script');
  el.id = id;
  el.async = true;
  el.src = src;
  document.head.appendChild(el);
}
