/**
 * IDENTIDADE E CONTEXTO — quem está navegando, de onde veio, em que aparelho.
 *
 * Três identificadores, com vidas diferentes de propósito:
 *   anonymous_id — o aparelho. Vive ~2 anos no localStorage. É o que costura a
 *                  visitante que voltou 3 semanas depois pra comprar.
 *   session_id   — a visita. Vive no localStorage e morre em 30 min de
 *                  inatividade — mesma janela E mesmo escopo do GA4 (que usa
 *                  cookie), pra os relatórios baterem. Vale para o ORIGIN, não
 *                  para a aba: ver `getSessionId`.
 *   user_id      — a pessoa. Só existe depois do login; vem do CRM e é o mesmo
 *                  id do app, senão a visão única de cliente não fecha.
 *
 * Tudo aqui é client-side e defensivo: navegação anônima, storage cheio e
 * bloqueador de cookie fazem `localStorage` lançar exceção. Rastreamento nunca
 * pode derrubar a loja — na dúvida, devolve valor efêmero e segue.
 */

import type { Attribution, EventContext } from './types';

const ANON_KEY = 'lurds_anonymous_id';
const SESSION_KEY = 'lurds_session';
const ATTRIBUTION_KEY = 'lurds_attribution';
const USER_KEY = 'lurds_user_id';
const LOJA_KEY = 'lurds_loja';

/** Janela de inatividade que encerra a sessão — igual à do GA4. */
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Por quanto tempo a origem da visita continua valendo — a "janela de
 * atribuição". 30 dias é o padrão de last-click do mercado (é o mesmo default
 * do Meta e do GA4), então o relatório da casa bate com o do Gerenciador.
 */
const ATTRIBUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* ────────────────────────────────────────────────────────────────────────────
 * Storage à prova de bala
 * ──────────────────────────────────────────────────────────────────────────── */

function safeGet(storage: 'local' | 'session', key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return (storage === 'local' ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: 'local' | 'session', key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    (storage === 'local' ? window.localStorage : window.sessionStorage).setItem(key, value);
  } catch {
    /* storage indisponível — o id vira efêmero, e tudo bem */
  }
}

export function safeRemove(storage: 'local' | 'session', key: string): void {
  if (typeof window === 'undefined') return;
  try {
    (storage === 'local' ? window.localStorage : window.sessionStorage).removeItem(key);
  } catch {
    /* idem */
  }
}

/** UUID v4. `crypto.randomUUID` não existe em http:// nem em browser velho. */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Último recurso: colisão é improvável o bastante pro uso (id de evento).
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Identificadores
 * ──────────────────────────────────────────────────────────────────────────── */

export function getAnonymousId(): string {
  const existing = safeGet('local', ANON_KEY);
  if (existing) return existing;
  const created = uuid();
  safeSet('local', ANON_KEY, created);
  return created;
}

interface SessionRecord {
  id: string;
  started_at: number;
  last_seen: number;
}

/** Lê um registro de sessão de um dos storages, já validando a inatividade. */
function sessaoViva(storage: 'local' | 'session', agora: number): SessionRecord | null {
  const raw = safeGet(storage, SESSION_KEY);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as SessionRecord;
    if (rec?.id && agora - rec.last_seen < SESSION_TIMEOUT_MS) return rec;
  } catch {
    /* registro corrompido → vale como inexistente */
  }
  return null;
}

/**
 * Devolve a sessão viva, criando ou renovando conforme a inatividade.
 * Chamado a cada evento — é ele que empurra o `last_seen`.
 *
 * ── POR QUE `localStorage` E NÃO `sessionStorage` (16/08/2026) ──
 *
 * `sessionStorage` é POR ABA. Enquanto a sessão morava lá, a cliente que abre
 * quatro peças em quatro abas — comportamento normal de quem compra roupa —
 * virava QUATRO pessoas no relatório: quatro que viram produto e uma que pôs
 * na sacola. Toda taxa a jusante afundava sem ninguém ter desistido de nada.
 *
 * Pior: o comentário lá em cima promete "mesma janela do GA4, pra os
 * relatórios baterem", e o GA4 guarda a sessão em COOKIE, compartilhado entre
 * abas. A janela batia; o escopo, não.
 *
 * `localStorage` é do ORIGIN inteiro, então a sessão atravessa aba e recarga.
 * A regra de fim continua a mesma e é o que segura o escopo: 30 min sem
 * evento nenhum encerra. Aba fechada e reaberta dentro da janela continua a
 * mesma visita — que é exatamente o que o GA4 faz.
 *
 * Isto NÃO resolve robô: crawler não guarda storage entre páginas, então
 * continua ganhando sessão nova a cada peça varrida. Quem corta robô é o
 * `bot-detect.ts` aqui e a régua de "sessão de gente" no FlowOps.
 */
export function getSessionId(): string {
  const now = Date.now();

  const atual = sessaoViva('local', now);
  if (atual) {
    safeSet('local', SESSION_KEY, JSON.stringify({ ...atual, last_seen: now }));
    return atual.id;
  }

  /**
   * ADOÇÃO DO REGISTRO ANTIGO: quem estava navegando na hora do deploy tem a
   * sessão no `sessionStorage`. Sem isto, a visita dela se parte em duas no
   * meio do funil — e a que perde é sempre a de baixo, a que ia comprar.
   */
  const legado = sessaoViva('session', now);
  const rec: SessionRecord = legado
    ? { ...legado, last_seen: now }
    : { id: uuid(), started_at: now, last_seen: now };

  safeSet('local', SESSION_KEY, JSON.stringify(rec));
  // O registro antigo já foi absorvido; deixá-lo vivo só convida a divergir.
  if (legado) safeRemove('session', SESSION_KEY);
  return rec.id;
}

export function getUserId(): string | null {
  return safeGet('local', USER_KEY);
}

/** Chamado no login (Sprint 008+, quando o CRM entrar). */
export function setUserId(id: string | null): void {
  if (id) safeSet('local', USER_KEY, id);
  else safeRemove('local', USER_KEY);
}

/** Loja física atribuída à visitante (por CEP) — liga a venda online ao acerto. */
export function getLoja(): string | null {
  return safeGet('local', LOJA_KEY);
}

export function setLoja(code: string | null): void {
  if (code) safeSet('local', LOJA_KEY, code);
  else safeRemove('local', LOJA_KEY);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Atribuição
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A forma da atribuição mora em `types.ts`, junto do resto do contrato de
 * evento — antes existia uma cópia aqui, e cópia de tipo diverge.
 */
export type { Attribution } from './types';

/**
 * De onde a visitante veio. Capturada na primeira página em que ela chega com
 * origem identificável, e mantida por 30 dias.
 *
 * ── DUAS REGRAS QUE PARECEM A MESMA E NÃO SÃO ──
 *
 * 1. Não reescrever a cada navegação. Senão a campanha é apagada no instante
 *    em que ela clica em qualquer link interno, e toda venda vira "direto".
 *
 * 2. Não morrer com a aba. Era o comportamento até 10/08/2026: a origem vivia
 *    em `sessionStorage`. A cliente clicava no anúncio na segunda, gostava do
 *    vestido, ia pensar — e voltava na quarta digitando o site direto. A
 *    origem tinha sumido, a venda entrava como "Direto", e a campanha que
 *    trouxe ela levava crédito ZERO. Roupa tem decisão de dias, então isso
 *    subestimava sistematicamente o retorno da mídia paga.
 *
 * A janela de 30 dias é o last-click padrão do mercado (mesmo default do Meta
 * e do GA4), então o relatório da casa bate com o do Gerenciador de Anúncios.
 * Origem NOVA dentro da janela sobrescreve a antiga — é last-click, não
 * first-click: se ela voltou por outro anúncio, quem levou ela de volta é
 * quem fecha a venda.
 */
export function captureAttribution(): Attribution {
  if (typeof window === 'undefined') return {};

  const q = new URLSearchParams(window.location.search);
  const ref = document.referrer || '';

  /**
   * Só conta como "toque novo" o que identifica origem de verdade: UTM na URL
   * ou clique de anúncio (gclid/fbclid). Referrer sozinho não vale — senão
   * voltar do Google depois de uma busca por "lurds" sobrescreveria a campanha
   * paga que trouxe ela na semana passada.
   */
  const temToqueNovo = Boolean(
    q.get('utm_source') || q.get('utm_campaign') || q.get('gclid') || q.get('fbclid'),
  );

  const guardada = lerAtribuicao();
  if (guardada && !temToqueNovo) return guardada;

  const attr: Attribution = {
    source: q.get('utm_source') || inferSource(ref),
    medium: q.get('utm_medium') || (ref ? 'referral' : 'direct'),
    campaign: q.get('utm_campaign') || undefined,
    term: q.get('utm_term') || undefined,
    content: q.get('utm_content') || undefined,
    // O ID da campanha existe como coluna no pedido (`utmId`) e nunca era
    // capturado aqui — se o Meta manda `utm_id={{campaign.id}}`, o dado
    // chegava e era jogado fora.
    id: q.get('utm_id') || undefined,
    gclid: q.get('gclid') || undefined,
    fbclid: q.get('fbclid') || undefined,
    landing_page: window.location.pathname,
  };

  // Remove chave sem valor pra não poluir o payload com `undefined`.
  const clean = Object.fromEntries(Object.entries(attr).filter(([, v]) => v)) as Attribution;

  // Primeiro acesso sem origem nenhuma (digitou o endereço): não vale gravar
  // "direto" por 30 dias — isso blindaria a visitante contra qualquer
  // campanha futura durante um mês.
  if (!temToqueNovo && !clean.source) return clean;

  safeSet(
    'local',
    ATTRIBUTION_KEY,
    JSON.stringify({ attr: clean, expiraEm: Date.now() + ATTRIBUTION_TTL_MS }),
  );
  return clean;
}

/**
 * Lê a origem guardada, respeitando a validade. Aceita o formato ANTIGO (o
 * objeto cru, sem `expiraEm`) que ficou em `sessionStorage` nos navegadores
 * de quem estava com o site aberto na virada — sem isso, a atribuição dessas
 * visitantes se perderia justamente no deploy.
 */
function lerAtribuicao(): Attribution | null {
  const bruto = safeGet('local', ATTRIBUTION_KEY) ?? safeGet('session', ATTRIBUTION_KEY);
  if (!bruto) return null;
  try {
    const parsed = JSON.parse(bruto);
    if (parsed && typeof parsed === 'object' && 'attr' in parsed) {
      if (typeof parsed.expiraEm === 'number' && parsed.expiraEm < Date.now()) return null;
      return parsed.attr as Attribution;
    }
    return parsed as Attribution; // formato antigo
  } catch {
    return null;
  }
}

function inferSource(referrer: string): string | undefined {
  if (!referrer) return undefined;
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '');
    if (host === window.location.hostname) return undefined; // navegação interna
    if (/google\./.test(host)) return 'google';
    if (/(facebook|fb)\./.test(host)) return 'facebook';
    if (/instagram\./.test(host)) return 'instagram';
    if (/(whatsapp|wa\.me)/.test(host)) return 'whatsapp';
    if (/tiktok\./.test(host)) return 'tiktok';
    return host;
  } catch {
    return undefined;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Aparelho
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Classifica pela LARGURA, não pelo user-agent. UA mente (iPad se apresenta
 * como Mac há anos) e os breakpoints aqui são os mesmos do Tailwind do projeto,
 * então "mobile" no relatório é literalmente o layout que a visitante viu.
 */
function detectDevice(): EventContext['device'] {
  if (typeof window === 'undefined') {
    return { type: 'desktop' };
  }
  const w = window.innerWidth;
  const type: EventContext['device']['type'] = w < 768 ? 'mobile' : w < 1024 ? 'tablet' : 'desktop';
  let timezone: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timezone = undefined;
  }
  return {
    type,
    viewport: { w, h: window.innerHeight },
    language: navigator.language,
    timezone,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Cookies do Meta (Advanced Matching / CAPI)
 * ──────────────────────────────────────────────────────────────────────────── */

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : undefined;
}

/**
 * `_fbp` (browser id) e `_fbc` (click id) são o que mais aumenta a taxa de
 * casamento da CAPI. O Pixel grava os dois; aqui só lemos e mandamos junto
 * pro servidor. Sem eles, evento server-side casa muito pior.
 */
export function getMetaBrowserIds(): { fbp?: string; fbc?: string } {
  const fbp = readCookie('_fbp');
  let fbc = readCookie('_fbc');

  // Chegou por anúncio nesta pageview e o Pixel ainda não gravou o _fbc:
  // monta no formato oficial fb.1.<timestamp>.<fbclid>.
  if (!fbc && typeof window !== 'undefined') {
    const fbclid = new URLSearchParams(window.location.search).get('fbclid');
    if (fbclid) fbc = `fb.1.${Date.now()}.${fbclid}`;
  }
  return { fbp, fbc };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Contexto completo
 * ──────────────────────────────────────────────────────────────────────────── */

/** Monta o contexto que acompanha todo evento. Barato: só lê storage e DOM. */
export function buildContext(): EventContext {
  const path = typeof window !== 'undefined' ? window.location.pathname : '/';
  return {
    session_id: getSessionId(),
    anonymous_id: getAnonymousId(),
    user_id: getUserId(),
    page: {
      path,
      url: typeof window !== 'undefined' ? window.location.href : path,
      title: typeof document !== 'undefined' ? document.title : undefined,
      referrer: typeof document !== 'undefined' ? document.referrer || undefined : undefined,
    },
    device: detectDevice(),
    attribution: captureAttribution(),
    loja: getLoja(),
    currency: 'BRL',
    language: 'pt-BR',
    country: 'BR',
  };
}
