import 'server-only';

/**
 * DESPACHO SERVER-SIDE — o fan-out pras plataformas, com retry e log.
 *
 * ⚠️ LIMITE DE ARQUITETURA, declarado em vez de escondido: o retry aqui é
 * DENTRO da requisição (2 tentativas com espera curta). "Nunca perder evento"
 * de verdade exige fila durável — Postgres, Redis ou QStash — porque uma função
 * serverless morre no fim da resposta e leva qualquer `setTimeout` junto.
 *
 * O que já está pronto pra isso: `EventQueueStore` abaixo é a interface, e o
 * único lugar que precisa mudar é `dispatchBatch`. Enquanto a fila durável não
 * existe, falha depois de 2 tentativas vira log de erro — e o painel de debug
 * mostra, que é melhor do que sumir em silêncio.
 */

import { getLogStore } from './log-store';
import { isMetaCapiEnabled, sendToMetaCapi, type MetaUserSignals } from './meta-capi';
import { isGa4MpEnabled, sendToGa4Mp } from './ga4-mp';
import type { DispatchLog, TrackingEvent } from '../types';

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 400;

/**
 * Contrato da fila durável (ainda não implementada — ver aviso acima).
 * Implementar isto + trocar a chamada em `dispatchBatch` é tudo que falta.
 */
export interface EventQueueStore {
  enqueue(event: TrackingEvent, destination: string, attempt: number): Promise<void>;
  claimDue(limit: number): Promise<Array<{ event: TrackingEvent; destination: string; attempt: number }>>;
  resolve(id: string): Promise<void>;
}

interface ServerDestination {
  id: string;
  isEnabled(): boolean;
  send(events: TrackingEvent[], signals: MetaUserSignals): Promise<{ ok: boolean; error?: string }>;
}

const SERVER_DESTINATIONS: ServerDestination[] = [
  { id: 'meta_capi', isEnabled: isMetaCapiEnabled, send: (events, signals) => sendToMetaCapi(events, signals) },
  // O GA4 recebe os MESMOS sinais que a Meta (e-mail/telefone, hasheados lá
  // dentro): é isso que alimenta o Enhanced Conversions do Google Ads. Antes
  // os sinais chegavam aqui e eram descartados na porta do GA4 — a flag do
  // recurso estava ligada no gtag sem nunca ter dado pra processar.
  { id: 'ga4_mp', isEnabled: isGa4MpEnabled, send: (events, signals) => sendToGa4Mp(events, signals) },
];

/**
 * IDEMPOTÊNCIA DO PURCHASE. Guarda os `transaction_id` já despachados pra que
 * um retry de rede, um refresh na página de obrigado ou um webhook repetido não
 * contem a mesma venda duas vezes.
 *
 * Mesma ressalva da memória: vale por instância. A garantia definitiva é a
 * deduplicação por `event_id` da própria Meta somada à checagem no banco do
 * pedido — esta camada é a primeira linha, não a única.
 */
const globalRef = globalThis as unknown as { __lurdsPurchases?: Set<string> };
const purchasesVistos = globalRef.__lurdsPurchases ?? new Set<string>();
globalRef.__lurdsPurchases = purchasesVistos;

function jaDespachado(event: TrackingEvent): boolean {
  if (event.event !== 'purchase' || !event.transaction_id) return false;
  const key = `purchase:${event.transaction_id}`;
  if (purchasesVistos.has(key)) return true;
  purchasesVistos.add(key);
  // Teto de memória — 5 mil pedidos é muito mais que qualquer janela útil.
  if (purchasesVistos.size > 5_000) {
    const primeiro = purchasesVistos.values().next().value;
    if (primeiro !== undefined) purchasesVistos.delete(primeiro);
  }
  return false;
}

async function registrar(entry: Omit<DispatchLog, 'id' | 'created_at'>): Promise<void> {
  await getLogStore().append({
    ...entry,
    id: `${entry.event_id}-${entry.destination}-${entry.attempt}`,
    created_at: new Date().toISOString(),
  });
}

/** Despacha o lote pra todos os destinos servidor habilitados. */
export async function dispatchBatch(events: TrackingEvent[], signals: MetaUserSignals): Promise<{ dispatched: number }> {
  const novos = events.filter((ev) => !jaDespachado(ev));
  const repetidos = events.length - novos.length;

  for (const ev of events.filter((e) => !novos.includes(e))) {
    await registrar({
      event_id: ev.event_id,
      event: ev.event,
      destination: 'dedup',
      status: 'skipped',
      duration_ms: 0,
      attempt: 1,
      reason: `purchase ${ev.transaction_id} já despachado`,
    });
  }

  if (!novos.length) return { dispatched: 0 };

  // Os destinos são independentes: Meta fora do ar não pode segurar o GA4.
  await Promise.all(
    SERVER_DESTINATIONS.map(async (dest) => {
      if (!dest.isEnabled()) {
        await registrar({
          event_id: novos[0].event_id,
          event: novos[0].event,
          destination: dest.id,
          status: 'skipped',
          duration_ms: 0,
          attempt: 1,
          reason: 'destino sem credencial configurada',
        });
        return;
      }

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const t0 = Date.now();
        try {
          const result = await dest.send(novos, signals);
          const duration = Date.now() - t0;

          if (result.ok) {
            for (const ev of novos) {
              await registrar({ event_id: ev.event_id, event: ev.event, destination: dest.id, status: 'success', duration_ms: duration, attempt });
            }
            return;
          }
          if (attempt === MAX_ATTEMPTS) {
            for (const ev of novos) {
              await registrar({ event_id: ev.event_id, event: ev.event, destination: dest.id, status: 'error', duration_ms: duration, attempt, error: result.error });
            }
            return;
          }
          await registrar({ event_id: novos[0].event_id, event: novos[0].event, destination: dest.id, status: 'retrying', duration_ms: duration, attempt, error: result.error });
        } catch (err) {
          const duration = Date.now() - t0;
          const error = err instanceof Error ? err.message : String(err);
          if (attempt === MAX_ATTEMPTS) {
            for (const ev of novos) {
              await registrar({ event_id: ev.event_id, event: ev.event, destination: dest.id, status: 'error', duration_ms: duration, attempt, error });
            }
            return;
          }
          await registrar({ event_id: novos[0].event_id, event: novos[0].event, destination: dest.id, status: 'retrying', duration_ms: duration, attempt, error });
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }),
  );

  return { dispatched: novos.length - repetidos };
}
