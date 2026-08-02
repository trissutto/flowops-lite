/**
 * EVENT MANAGER — o único caminho de saída de evento do ecommerce.
 *
 * Fluxo, na ordem: registrar → validar → deduplicar → gate de consentimento →
 * Data Layer → destinos de navegador → fila do servidor → log.
 *
 * ORÇAMENTO DE PERFORMANCE (5ms, exigência da spec). O que roda no mesmo tick
 * da interação é só o barato e determinístico: montar o envelope e validar.
 * Tudo que pode demorar — script de terceiro, rede, serialização de lote — sai
 * num microtask. Na prática, `track()` devolve em fração de milissegundo e a
 * navegação nunca espera por pixel.
 *
 * O QUE ESTE MÓDULO NÃO FAZ, de propósito:
 *   • não dispara `purchase` nem `refund` — esses nascem no servidor, depois do
 *     pagamento confirmado (o console do navegador é território hostil);
 *   • não confia em consentimento implícito — sem opt-in, nada sai daqui.
 */

'use client';

import { BROWSER_DESTINATIONS, type Destination } from './destinations';
import { pushToDataLayer } from './data-layer';
import { getConsent, isAllowed, subscribeConsent } from './consent';
import { buildContext, getMetaBrowserIds, uuid } from './identity';
import {
  ALL_EVENTS,
  SERVER_ONLY_EVENTS,
  type DispatchLog,
  type EventName,
  type TrackedItem,
  type TrackingEvent,
} from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * Ajustes
 * ──────────────────────────────────────────────────────────────────────────── */

const QUEUE_FLUSH_MS = 5_000;
const QUEUE_MAX_BATCH = 20;
const QUEUE_MAX_HELD = 200;
const MAX_SEND_ATTEMPTS = 4;
/** Janela em que um evento idêntico é considerado repetição de clique. */
const DEDUP_WINDOW_MS = 1_000;
const DEDUP_MEMORY = 100;

const DEBUG = process.env.NEXT_PUBLIC_TRACKING_DEBUG === '1';

/* ────────────────────────────────────────────────────────────────────────────
 * Estado do módulo
 * ──────────────────────────────────────────────────────────────────────────── */

interface QueueItem {
  event: TrackingEvent;
  attempts: number;
  next_try_at: number;
}

let started = false;
const initialized = new Set<string>();
const queue: QueueItem[] = [];
const recent = new Map<string, number>();
const localLogs: DispatchLog[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

export interface TrackOptions {
  items?: TrackedItem[];
  value?: number;
  cupom?: string;
  transaction_id?: string;
  /** Chave de deduplicação explícita — use quando o mesmo clique pode repetir. */
  dedupe_key?: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Ciclo de vida
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Liga o Event Manager. Chamado uma vez pelo TrackingProvider.
 * Destinos cujo consentimento ainda não veio ficam de fora e são inicializados
 * assim que a visitante aceitar — sem recarregar a página.
 */
export function initTracking(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  initAllowedDestinations();
  subscribeConsent(() => initAllowedDestinations());

  flushTimer = setInterval(() => void flush(), QUEUE_FLUSH_MS);

  // Aba escondida é o último momento confiável pra despachar: em mobile, o
  // navegador mata a página sem passar por `unload`. `visibilitychange` é o
  // único gancho que dispara de forma consistente em iOS.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushBeacon();
  });
  window.addEventListener('pagehide', flushBeacon);
}

function initAllowedDestinations(): void {
  for (const dest of BROWSER_DESTINATIONS) {
    if (initialized.has(dest.id) || !dest.isEnabled() || !isAllowed(dest.consent)) continue;
    try {
      dest.init();
      initialized.add(dest.id);
      debug(`destino ${dest.id} inicializado`);
    } catch (err) {
      log({ destination: dest.id, event: 'page_view', event_id: '-', status: 'error', duration_ms: 0, attempt: 1, error: msg(err) });
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * API pública
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Registra um evento. Nunca lança — rastreamento com defeito não pode derrubar
 * a loja. Erro vira log e o fluxo segue.
 */
export function track(name: EventName, params: Record<string, unknown> = {}, options: TrackOptions = {}): void {
  try {
    if (typeof window === 'undefined') return;

    if (SERVER_ONLY_EVENTS.includes(name)) {
      // Chamada de componente jamais deveria chegar aqui. Recusar em vez de
      // aceitar é o que impede um `purchase` forjado de sujar o ROAS.
      console.warn(`[tracking] "${name}" só pode ser emitido pelo servidor. Evento descartado.`);
      return;
    }

    const candidate: TrackingEvent = {
      event: name,
      event_id: uuid(),
      timestamp: new Date().toISOString(),
      context: buildContext(),
      params,
      items: options.items,
      value: options.value,
      cupom: options.cupom,
      transaction_id: options.transaction_id,
      source: 'browser',
    };

    const problema = validarEvento(candidate);
    if (problema) {
      console.warn(`[tracking] evento "${name}" recusado na validação: ${problema}`);
      return;
    }
    const event = candidate;

    if (isDuplicate(event, options.dedupe_key)) {
      debug(`evento "${name}" ignorado (duplicado na janela de ${DEDUP_WINDOW_MS}ms)`);
      return;
    }

    // Histórico próprio: sempre. É dado de primeira parte e é o que sustenta o
    // painel de debug mesmo com todo script de terceiro bloqueado.
    pushToDataLayer(event);

    // O caro sai do caminho da interação.
    queueMicrotask(() => {
      dispatchToBrowser(event);
      enqueueForServer(event);
    });
  } catch (err) {
    console.warn('[tracking] falha ao registrar evento:', msg(err));
  }
}

/**
 * Guarda do evento antes de despachar. Devolve a descrição do problema, ou
 * `undefined` quando está tudo certo.
 *
 * Aqui o objeto é construído pelo próprio app e já passou pelo TypeScript, e o
 * `/api/events` revalida tudo com zod na chegada — esta checagem existe pra
 * pegar o que o tipo não pega: número que virou `NaN` ou `Infinity` no meio de
 * uma conta de preço. É o risco real que o cabeçalho de `types.ts` descreve:
 * valor quebrado entra em silêncio na plataforma de anúncio e o ROAS some sem
 * ninguém notar. Escrita à mão pra não trazer o zod (74 KB) pro navegador.
 */
function numeroInvalido(n: unknown): boolean {
  return typeof n !== 'number' || !Number.isFinite(n) || n < 0;
}

function validarEvento(e: TrackingEvent): string | undefined {
  if (!ALL_EVENTS.includes(e.event)) return `evento fora da taxonomia`;
  if (typeof e.event_id !== 'string' || e.event_id.length < 8) return 'event_id inválido';
  if (e.value !== undefined && numeroInvalido(e.value)) return `value inválido (${e.value})`;

  for (const item of e.items ?? []) {
    if (numeroInvalido(item.valor)) {
      return `item "${item.product_id}" com valor inválido (${item.valor})`;
    }
    if (!Number.isInteger(item.quantidade) || item.quantidade < 1) {
      return `item "${item.product_id}" com quantidade inválida (${item.quantidade})`;
    }
    if (item.desconto !== undefined && numeroInvalido(item.desconto)) {
      return `item "${item.product_id}" com desconto inválido (${item.desconto})`;
    }
  }
  return undefined;
}

/** Deduplicação: mesmo evento, mesma carga, dentro da janela = um só. */
function isDuplicate(event: TrackingEvent, explicitKey?: string): boolean {
  const key =
    explicitKey ??
    (event.transaction_id
      ? // Pedido é único pra sempre — nunca repete, nem daqui a uma hora.
        `${event.event}:${event.transaction_id}`
      : `${event.event}:${event.context.page.path}:${JSON.stringify(event.params)}:${JSON.stringify(
          (event.items ?? []).map((i) => `${i.product_id}/${i.tamanho ?? ''}/${i.cor ?? ''}`),
        )}`);

  const now = Date.now();
  const seen = recent.get(key);
  const janela = event.transaction_id ? Number.POSITIVE_INFINITY : DEDUP_WINDOW_MS;
  if (seen !== undefined && now - seen < janela) return true;

  recent.set(key, now);
  if (recent.size > DEDUP_MEMORY) {
    // Descarta o mais antigo — Map preserva ordem de inserção.
    const oldest = recent.keys().next().value;
    if (oldest !== undefined) recent.delete(oldest);
  }
  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Destinos de navegador
 * ──────────────────────────────────────────────────────────────────────────── */

function dispatchToBrowser(event: TrackingEvent): void {
  for (const dest of BROWSER_DESTINATIONS) {
    if (!dest.isEnabled()) continue;

    if (!isAllowed(dest.consent)) {
      log({ ...base(event, dest), status: 'skipped', reason: `sem consentimento de ${dest.consent}` });
      continue;
    }
    if (!dest.accepts(event.event)) {
      log({ ...base(event, dest), status: 'skipped', reason: 'destino não recebe este evento' });
      continue;
    }
    if (!initialized.has(dest.id)) {
      try {
        dest.init();
        initialized.add(dest.id);
      } catch {
        /* segue: o send abaixo registra o erro real */
      }
    }

    const t0 = perfNow();
    try {
      dest.send(event);
      log({ ...base(event, dest), status: 'success', duration_ms: perfNow() - t0 });
    } catch (err) {
      // Destino de navegador não tem retry: script bloqueado continua
      // bloqueado no próximo tick. A perna servidor é quem garante a entrega.
      log({ ...base(event, dest), status: 'error', duration_ms: perfNow() - t0, error: msg(err) });
    }
  }
}

function base(event: TrackingEvent, dest: Destination) {
  return { event: event.event, event_id: event.event_id, destination: dest.id, duration_ms: 0, attempt: 1 };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Fila do servidor
 * ──────────────────────────────────────────────────────────────────────────── */

function enqueueForServer(event: TrackingEvent): void {
  // O servidor repassa pra Meta e Google. Sem opt-in pra nenhuma das duas
  // finalidades, não há motivo pro evento sair do navegador.
  if (!isAllowed('analytics') && !isAllowed('marketing')) {
    log({ ...base(event, { id: 'server' } as Destination), status: 'skipped', reason: 'sem consentimento de analytics/marketing' });
    return;
  }

  queue.push({ event, attempts: 0, next_try_at: 0 });

  // Fila estourada = rede fora há muito tempo. Descarta o mais VELHO: evento
  // recente vale mais, e crescer sem limite trava a aba.
  if (queue.length > QUEUE_MAX_HELD) queue.splice(0, queue.length - QUEUE_MAX_HELD);

  if (queue.length >= QUEUE_MAX_BATCH) void flush();
}

/** Envia o lote pronto. Um flush por vez — `flushing` evita corrida. */
async function flush(): Promise<void> {
  if (flushing || typeof navigator === 'undefined' || !navigator.onLine) return;

  const now = Date.now();
  const ready = queue.filter((q) => q.next_try_at <= now).slice(0, QUEUE_MAX_BATCH);
  if (!ready.length) return;

  flushing = true;
  for (const item of ready) queue.splice(queue.indexOf(item), 1);

  const t0 = perfNow();
  try {
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: ready.map((r) => r.event), consent: getConsent(), meta: getMetaBrowserIds() }),
      keepalive: true,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    for (const item of ready) {
      log({ ...base(item.event, { id: 'server' } as Destination), status: 'success', duration_ms: perfNow() - t0, attempt: item.attempts + 1 });
    }
  } catch (err) {
    // Backoff exponencial: 1s, 2s, 4s. Depois de MAX_SEND_ATTEMPTS desiste —
    // "nunca perder evento" tem limite físico quando o aparelho está offline.
    for (const item of ready) {
      const attempts = item.attempts + 1;
      const desistiu = attempts >= MAX_SEND_ATTEMPTS;
      log({
        ...base(item.event, { id: 'server' } as Destination),
        status: desistiu ? 'error' : 'retrying',
        duration_ms: perfNow() - t0,
        attempt: attempts,
        error: msg(err),
      });
      if (!desistiu) queue.push({ ...item, attempts, next_try_at: Date.now() + 1000 * 2 ** (attempts - 1) });
    }
  } finally {
    flushing = false;
  }
}

/**
 * Descarga final, quando a página está morrendo. `sendBeacon` é o único método
 * que o navegador garante entregar depois que a aba fecha — `fetch`, mesmo com
 * `keepalive`, é cancelado. Em troca não dá pra saber se chegou nem repetir.
 */
function flushBeacon(): void {
  if (!queue.length || typeof navigator === 'undefined' || !navigator.sendBeacon) return;

  const events = queue.splice(0, queue.length).map((q) => q.event);
  try {
    const blob = new Blob([JSON.stringify({ events, consent: getConsent(), meta: getMetaBrowserIds() })], {
      type: 'application/json',
    });
    navigator.sendBeacon('/api/events', blob);
    debug(`sendBeacon com ${events.length} evento(s)`);
  } catch {
    /* último suspiro da página — não há o que fazer se falhar */
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Logs locais (alimentam o painel de debug)
 * ──────────────────────────────────────────────────────────────────────────── */

type LogInput = Omit<DispatchLog, 'id' | 'created_at' | 'duration_ms' | 'attempt'> & {
  duration_ms?: number;
  attempt?: number;
};

const logListeners = new Set<(log: DispatchLog) => void>();

function log(input: LogInput): void {
  const entry: DispatchLog = {
    ...input,
    id: uuid(),
    created_at: new Date().toISOString(),
    duration_ms: input.duration_ms ?? 0,
    attempt: input.attempt ?? 1,
  };
  localLogs.push(entry);
  if (localLogs.length > 500) localLogs.splice(0, localLogs.length - 500);
  logListeners.forEach((fn) => fn(entry));
  if (DEBUG) {
    const icon = entry.status === 'success' ? '✓' : entry.status === 'skipped' ? '·' : '✗';
    console.info(`[tracking] ${icon} ${entry.event} → ${entry.destination}`, entry.reason || entry.error || '');
  }
}

export function getLocalLogs(): DispatchLog[] {
  return [...localLogs];
}

export function subscribeLogs(fn: (log: DispatchLog) => void): () => void {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}

/** Só pros testes: zera o estado do módulo entre casos. */
export function __resetTracking(): void {
  started = false;
  initialized.clear();
  queue.length = 0;
  recent.clear();
  localLogs.length = 0;
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  flushing = false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Utilitários
 * ──────────────────────────────────────────────────────────────────────────── */

function perfNow(): number {
  return typeof performance !== 'undefined' ? Math.round(performance.now()) : Date.now();
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function debug(text: string): void {
  if (DEBUG) console.info(`[tracking] ${text}`);
}
