/**
 * CONSENTIMENTO (LGPD + Consent Mode v2).
 *
 * Regra: tudo começa NEGADO, menos o necessário. O Event Manager consulta este
 * módulo antes de qualquer despacho, e cada destino declara a categoria que
 * exige. Não existe caminho que contorne isso — é por construção, não por
 * disciplina de quem escreve componente.
 *
 * Consent Mode v2 do Google tem uma exigência de ORDEM que quebra em silêncio:
 * o estado `default` precisa ser enviado ANTES do gtag.js carregar. Por isso o
 * `consentBootstrapSnippet()` vai inline no <head>, antes de qualquer script de
 * terceiro. Se essa ordem inverter, o Google assume consentimento concedido e
 * a conformidade vira ficção.
 */

import type { ConsentCategory, ConsentState } from './types';

/**
 * Guarda do estado de consentimento vindo do localStorage.
 *
 * Aqui o dado É não confiável (a visitante pode ter editado o storage, ou o
 * registro pode ser de uma versão antiga do app), então a checagem é campo a
 * campo — o equivalente exato do `consentStateSchema` de `schemas.ts`, escrito
 * à mão pra não arrastar o zod (74 KB) pro bundle de todas as páginas.
 *
 * Qualquer coisa fora do formato devolve `null`, e quem chama cai no default
 * TUDO NEGADO. Na dúvida, não rastreia — é o lado seguro da LGPD.
 */
function parseConsentState(valor: unknown): ConsentState | null {
  if (typeof valor !== 'object' || valor === null) return null;
  const v = valor as Record<string, unknown>;

  // `necessary` é literal `true`: nem `false` nem "true" passam.
  if (v.necessary !== true) return null;
  if (typeof v.analytics !== 'boolean') return null;
  if (typeof v.marketing !== 'boolean') return null;
  if (typeof v.personalization !== 'boolean') return null;
  if (v.decided_at !== null && typeof v.decided_at !== 'string') return null;
  if (typeof v.version !== 'number' || !Number.isInteger(v.version)) return null;

  return {
    necessary: true,
    analytics: v.analytics,
    marketing: v.marketing,
    personalization: v.personalization,
    decided_at: v.decided_at,
    version: v.version,
  };
}

const STORAGE_KEY = 'lurds_consent';

/**
 * Subir esta versão invalida o consentimento já dado e faz o banner voltar.
 * Mexer nela é decisão jurídica: só quando o TEXTO ou as finalidades mudarem.
 */
export const CONSENT_VERSION = 1;

/** Estado inicial: só o necessário. Vale enquanto a visitante não decidir. */
export const DEFAULT_CONSENT: ConsentState = {
  necessary: true,
  analytics: false,
  marketing: false,
  personalization: false,
  decided_at: null,
  version: CONSENT_VERSION,
};

type Listener = (state: ConsentState) => void;

let current: ConsentState = DEFAULT_CONSENT;
let hydrated = false;
const listeners = new Set<Listener>();

/* ────────────────────────────────────────────────────────────────────────────
 * Leitura e escrita
 * ──────────────────────────────────────────────────────────────────────────── */

/** Lê o consentimento salvo. Idempotente — pode chamar à vontade. */
export function hydrateConsent(): ConsentState {
  if (hydrated || typeof window === 'undefined') return current;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = parseConsentState(JSON.parse(raw));
      // Versão antiga = consentimento de outro texto: não vale mais.
      if (parsed && parsed.version === CONSENT_VERSION) {
        current = parsed;
      }
    }
  } catch {
    /* storage bloqueado → segue com o default negado, que é o lado seguro */
  }
  return current;
}

export function getConsent(): ConsentState {
  return hydrated ? current : hydrateConsent();
}

/** True quando a visitante ainda não decidiu (o banner precisa aparecer). */
export function needsDecision(): boolean {
  return getConsent().decided_at === null;
}

export function isAllowed(category: ConsentCategory): boolean {
  return category === 'necessary' ? true : getConsent()[category] === true;
}

/**
 * Grava a decisão, avisa quem estiver ouvindo e atualiza o Google.
 * `partial` permite "aceitar só analytics" sem inventar as outras chaves.
 */
export function setConsent(partial: Partial<Omit<ConsentState, 'necessary' | 'version'>>): ConsentState {
  const next: ConsentState = {
    ...current,
    ...partial,
    necessary: true,
    version: CONSENT_VERSION,
    decided_at: partial.decided_at ?? new Date().toISOString(),
  };
  current = next;
  hydrated = true;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* sem storage, a decisão vale só nesta aba */
  }

  pushConsentModeUpdate(next);
  listeners.forEach((fn) => {
    try {
      fn(next);
    } catch {
      /* um ouvinte quebrado não pode derrubar os outros */
    }
  });
  return next;
}

export function acceptAll(): ConsentState {
  return setConsent({ analytics: true, marketing: true, personalization: true });
}

export function rejectAll(): ConsentState {
  return setConsent({ analytics: false, marketing: false, personalization: false });
}

export function subscribeConsent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Consent Mode v2
 * ──────────────────────────────────────────────────────────────────────────── */

/** Traduz as nossas 4 categorias pros 7 sinais que o Google espera. */
function toGoogleSignals(state: ConsentState): Record<string, 'granted' | 'denied'> {
  const g = (b: boolean): 'granted' | 'denied' => (b ? 'granted' : 'denied');
  return {
    ad_storage: g(state.marketing),
    ad_user_data: g(state.marketing),
    ad_personalization: g(state.personalization),
    analytics_storage: g(state.analytics),
    functionality_storage: 'granted',
    personalization_storage: g(state.personalization),
    security_storage: 'granted',
  };
}

function pushConsentModeUpdate(state: ConsentState): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { gtag?: (...args: unknown[]) => void; fbq?: (...args: unknown[]) => void };
  w.gtag?.('consent', 'update', toGoogleSignals(state));
  // Meta: `revoke` para o Pixel de vez; `grant` volta a permitir.
  w.fbq?.('consent', state.marketing ? 'grant' : 'revoke');
}

/**
 * Script inline pro <head>, ANTES de qualquer tag de terceiro. Faz três coisas
 * na ordem certa: cria o dataLayer, manda o `default` negado e reaplica o que
 * já estiver salvo. Sem esta última parte, quem já aceitou veria o site voltar
 * ao estado negado a cada carregamento até o React hidratar.
 */
export function consentBootstrapSnippet(): string {
  return `
(function(){
  window.dataLayer = window.dataLayer || [];
  function gtag(){window.dataLayer.push(arguments);}
  window.gtag = window.gtag || gtag;
  gtag('consent','default',{
    ad_storage:'denied', ad_user_data:'denied', ad_personalization:'denied',
    analytics_storage:'denied', functionality_storage:'granted',
    personalization_storage:'denied', security_storage:'granted',
    wait_for_update: 500
  });
  try {
    var raw = localStorage.getItem('${STORAGE_KEY}');
    if (raw) {
      var s = JSON.parse(raw);
      if (s && s.version === ${CONSENT_VERSION} && s.decided_at) {
        var g = function(b){ return b ? 'granted' : 'denied'; };
        gtag('consent','update',{
          ad_storage:g(s.marketing), ad_user_data:g(s.marketing),
          ad_personalization:g(s.personalization), analytics_storage:g(s.analytics),
          functionality_storage:'granted', personalization_storage:g(s.personalization),
          security_storage:'granted'
        });
      }
    }
  } catch(e){}
})();`.trim();
}
