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
  /**
   * Filtro por destino. Omitido = o destino recebe o lote inteiro.
   *
   * Existe porque Meta e GA4 tratam evento repetido de formas OPOSTAS.
   */
  aceita?(event: TrackingEvent): boolean;
  send(events: TrackingEvent[], signals: MetaUserSignals): Promise<{ ok: boolean; error?: string }>;
}

const SERVER_DESTINATIONS: ServerDestination[] = [
  // A Meta recebe TUDO de propósito: a CAPI é feita pra andar em paralelo com
  // o Pixel e deduplica pelo `event_id`. Mandar dos dois lados é o que ela
  // recomenda — aumenta o casamento sem contar duas vezes.
  { id: 'meta_capi', isEnabled: isMetaCapiEnabled, send: (events, signals) => sendToMetaCapi(events, signals) },
  /**
   * 🚨 O GA4 SÓ RECEBE O QUE O NAVEGADOR NÃO PODE MANDAR.
   *
   * O Measurement Protocol **não deduplica nada** — não existe `event_id` do
   * lado do GA4. Até 27/08/2026 este destino recebia o lote inteiro, incluindo
   * os eventos que o gtag do navegador já tinha acabado de enviar (o destino
   * `ga4` do cliente tem `accepts: () => true`). Cada `view_item`, `scroll` e
   * `add_to_cart` de quem aceitou o banner chegava DUAS vezes.
   *
   * E chegava com identidade diferente: a cópia do servidor ia com o
   * `anonymous_id`, então nascia numa sessão órfã. Medido no GA4 em 28 dias:
   * **"Unassigned" com 7.032 sessões, 289 mil eventos (41 por sessão, contra
   * 5-20 dos canais de gente), taxa de engajamento de 5,77% e R$ 45.156 —
   * quase METADE da receita da propriedade** carimbada como origem
   * desconhecida. O relatório de aquisição inteiro mentia por causa disto.
   *
   * `source === 'server'` deixa passar exatamente `purchase` e `refund`, que
   * são `SERVER_ONLY_EVENTS` e nascem depois do pagamento, sem navegador
   * aberto. É o único caso em que o servidor é a ÚNICA rota até o GA4 — e é
   * também o que leva os sinais de Enhanced Conversions (e-mail/telefone
   * hasheados em `ga4-mp.ts`), que o gtag nunca teve.
   */
  {
    id: 'ga4_mp',
    isEnabled: isGa4MpEnabled,
    aceita: (event) => event.source === 'server',
    send: (events, signals) => sendToGa4Mp(events, signals),
  },
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

/**
 * Despacha o lote pros destinos servidor habilitados.
 *
 * `somenteDestinos` existe pra uma situação só, e é melhor declarar do que
 * deixar implícito: a visitante que ainda NÃO decidiu o banner tem os eventos
 * de campanha repassados à Meta (que atende por interesse legítimo de medição,
 * anonimizada), mas NÃO ao GA4. Omitir = todos, que é o caminho do purchase.
 */
export async function dispatchBatch(
  events: TrackingEvent[],
  signals: MetaUserSignals,
  somenteDestinos?: readonly string[],
): Promise<{ dispatched: number }> {
  const destinos = somenteDestinos
    ? SERVER_DESTINATIONS.filter((d) => somenteDestinos.includes(d.id))
    : SERVER_DESTINATIONS;

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
    destinos.map(async (dest) => {
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

      // O filtro do destino (ver `aceita`). Lote vazio depois dele não vira
      // requisição — e não vira log: evento que este destino nunca deveria
      // receber não é "pulado", é fora de escopo.
      const doDestino = dest.aceita ? novos.filter((ev) => dest.aceita!(ev)) : novos;
      if (!doDestino.length) return;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const t0 = Date.now();
        try {
          const result = await dest.send(doDestino, signals);
          const duration = Date.now() - t0;

          if (result.ok) {
            for (const ev of doDestino) {
              await registrar({ event_id: ev.event_id, event: ev.event, destination: dest.id, status: 'success', duration_ms: duration, attempt });
            }
            return;
          }
          if (attempt === MAX_ATTEMPTS) {
            for (const ev of doDestino) {
              await registrar({ event_id: ev.event_id, event: ev.event, destination: dest.id, status: 'error', duration_ms: duration, attempt, error: result.error });
            }
            return;
          }
          await registrar({ event_id: doDestino[0].event_id, event: doDestino[0].event, destination: dest.id, status: 'retrying', duration_ms: duration, attempt, error: result.error });
        } catch (err) {
          const duration = Date.now() - t0;
          const error = err instanceof Error ? err.message : String(err);
          if (attempt === MAX_ATTEMPTS) {
            for (const ev of doDestino) {
              await registrar({ event_id: ev.event_id, event: ev.event, destination: dest.id, status: 'error', duration_ms: duration, attempt, error });
            }
            return;
          }
          await registrar({ event_id: doDestino[0].event_id, event: doDestino[0].event, destination: dest.id, status: 'retrying', duration_ms: duration, attempt, error });
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }),
  );

  return { dispatched: novos.length - repetidos };
}
