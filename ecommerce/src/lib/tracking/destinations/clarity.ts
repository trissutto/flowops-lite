/**
 * MICROSOFT CLARITY — heatmap e gravação de sessão.
 *
 * Clarity não é plataforma de conversão: não adianta mandar `add_to_cart` com
 * valor pra ele. O que serve é ETIQUETAR a sessão nos momentos que importam,
 * pra depois filtrar as gravações por "quem chegou no checkout" ou "quem
 * aplicou cupom". Por isso `accepts` é uma lista curta, e não `() => true`.
 *
 * Gravação de sessão é dado comportamental: exige consentimento de
 * `personalization`, não de `analytics`.
 */

import type { EventName, TrackingEvent } from '../types';
import { loadScript, type Destination } from './types';

/** Momentos que valem virar filtro na lista de gravações. */
const TAGGED: readonly EventName[] = [
  'add_to_cart',
  'begin_checkout',
  'add_payment_info',
  'purchase',
  'coupon_applied',
  'search',
  'size_guide',
  'ai_consultant',
];

function projectId(): string {
  return process.env.NEXT_PUBLIC_CLARITY_ID || '';
}

function clarity(): ((...args: unknown[]) => void) | undefined {
  return (window as unknown as { clarity?: (...args: unknown[]) => void }).clarity;
}

export const microsoftClarity: Destination = {
  id: 'clarity',
  label: 'Microsoft Clarity',
  consent: 'personalization',

  isEnabled: () => Boolean(projectId()),

  init() {
    if (typeof window === 'undefined' || clarity() || document.getElementById('clarity-sdk')) return;

    // Loader oficial (fila + script assíncrono).
    const w = window as unknown as Record<string, unknown>;
    const c: ((...args: unknown[]) => void) & { q?: unknown[] } = function (...args: unknown[]) {
      (c.q = c.q || []).push(args);
    };
    w.clarity = c;

    // Pelo `loadScript` (e não montando a tag na mão) pra herdar a espera pela
    // linha principal — a fila `c.q` acima segura os eventos até o script
    // chegar, igual ao dataLayer do Google e ao stub da Meta.
    loadScript(`https://www.clarity.ms/tag/${projectId()}`, 'clarity-sdk');
  },

  accepts: (event: EventName) => TAGGED.includes(event),

  send(event: TrackingEvent) {
    const c = clarity();
    if (!c) throw new Error('clarity indisponível');
    c('event', event.event);
    if (event.context.user_id) c('identify', event.context.user_id);
  },
};
