/**
 * POST /api/events — porta de entrada dos eventos do navegador.
 *
 * Recebe o lote, RE-VALIDA (nada que veio do cliente é confiável), aplica o
 * gate de consentimento de novo e despacha server-side. Responde 202 assim que
 * aceita: quem está do outro lado é uma aba prestes a fechar, não pode esperar
 * a Meta responder.
 *
 * Roda no runtime Node, não Edge — `server-only` e o SHA-256 da CAPI já
 * funcionariam nos dois, mas o Node dá timeout mais folgado pro fan-out.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { detectarRobo } from '@/lib/tracking/bot-detect';
import { posturaDe, type PosturaConsentimento } from '@/lib/tracking/consent';
import { dispatchBatch } from '@/lib/tracking/server/dispatch';
import { persistirCliquesDeLoja, persistirEventosSite } from '@/lib/tracking/server/flowops-store';
import { getLogStore } from '@/lib/tracking/server/log-store';
import type { MetaUserSignals } from '@/lib/tracking/server/meta-capi';
import { consentStateSchema, trackingEventSchema } from '@/lib/tracking/schemas';
import { SERVER_ONLY_EVENTS, type TrackingEvent } from '@/lib/tracking/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  events: z.array(trackingEventSchema).min(1).max(50),
  consent: consentStateSchema,
  meta: z.object({ fbp: z.string().optional(), fbc: z.string().optional() }).optional(),
});

/* ────────────────────────────────────────────────────────────────────────────
 * Rate limit
 * ──────────────────────────────────────────────────────────────────────────── */

const JANELA_MS = 60_000;
const MAX_REQ_POR_JANELA = 60;

const globalRef = globalThis as unknown as { __lurdsRate?: Map<string, { count: number; reset: number }> };
const buckets = globalRef.__lurdsRate ?? new Map<string, { count: number; reset: number }>();
globalRef.__lurdsRate = buckets;

/** Teto por IP. Contém aba em loop e script de terceiro — não é anti-DDoS. */
function excedeuLimite(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now > b.reset) {
    buckets.set(ip, { count: 1, reset: now + JANELA_MS });
    if (buckets.size > 10_000) buckets.clear(); // teto de memória
    return false;
  }
  b.count += 1;
  return b.count > MAX_REQ_POR_JANELA;
}

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd?.split(',')[0].trim() || req.headers.get('x-real-ip') || '0.0.0.0';
}

/* ────────────────────────────────────────────────────────────────────────────
 * Despacho por postura
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * O que a Meta recebe de quem AINDA NÃO DECIDIU o banner.
 *
 * É o mínimo que faz a campanha existir pro algoritmo: `page_view` é a
 * "Visualização da página de destino" que o Gerenciador mostra, e `view_item`
 * é o que alimenta o remarketing de catálogo. Sacola e checkout ficam de fora
 * de propósito — quanto mais fundo no funil, mais o evento fala da PESSOA e
 * menos do anúncio, e aí o opt-in volta a ser o certo.
 */
const EVENTOS_CAMPANHA: readonly string[] = ['page_view', 'view_item'];

/** Sem aceite vai só pra Meta; o GA4 continua exigindo opt-in. */
const SO_META = ['meta_capi'] as const;

function despacharPorPostura(
  postura: PosturaConsentimento,
  eventos: TrackingEvent[],
  signals: MetaUserSignals,
): Promise<{ dispatched: number }> {
  if (postura === 'aceitou') return dispatchBatch(eventos, signals);
  if (postura === 'recusou') return Promise.resolve({ dispatched: 0 });

  const deCampanha = eventos.filter((e) => EVENTOS_CAMPANHA.includes(e.event));
  if (!deCampanha.length) return Promise.resolve({ dispatched: 0 });
  return dispatchBatch(deCampanha, signals, SO_META);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Handler
 * ──────────────────────────────────────────────────────────────────────────── */

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (excedeuLimite(ip)) {
    return NextResponse.json({ ok: false, error: 'rate limit' }, { status: 429 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'JSON inválido' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'payload inválido', issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
  }

  const { events, consent, meta } = parsed.data;

  /**
   * O CONSENTIMENTO DECIDE O DESTINO, não a entrada (dono, 13/08: "preciso de
   * todos os cliques registrados — para todo o site").
   *
   *   · ACEITOU     → Meta + GA4 + cópia de primeira parte.
   *   · NÃO DECIDIU → cópia de primeira parte + Meta pela CAPI, e SÓ os eventos
   *     de campanha (`EVENTOS_CAMPANHA`), já anonimizados na origem (sem
   *     user_id). GA4 fica de fora: ali o dado alimenta relatório de audiência,
   *     não a entrega do anúncio que a gente paga.
   *   · RECUSOU     → SÓ a cópia de primeira parte. O "não" é respeitado.
   *
   * A regra de quem pode receber mora em `posturaDe`/`metaServidorPodeReceber`
   * (consent.ts), a MESMA que o navegador usa pra decidir se anexa fbp/fbc.
   * Duplicar isso aqui já custou caro em outros pontos do site.
   */
  const postura = posturaDe(consent);
  const consentido = postura === 'aceitou';

  // `purchase` e `refund` NUNCA são aceitos por esta rota, venham como vierem.
  // Quem os emite é `trackServerEvent`, chamado depois do pagamento confirmar.
  const aceitos = events.filter((e) => !SERVER_ONLY_EVENTS.includes(e.event));
  const recusados = events.length - aceitos.length;

  if (recusados > 0) {
    const store = getLogStore();
    for (const ev of events.filter((e) => SERVER_ONLY_EVENTS.includes(e.event))) {
      await store.append({
        id: `${ev.event_id}-rejeitado`,
        event_id: ev.event_id,
        event: ev.event,
        destination: 'api',
        status: 'skipped',
        duration_ms: 0,
        attempt: 1,
        reason: `"${ev.event}" recusado: evento server-only chegou pelo navegador`,
        created_at: new Date().toISOString(),
      });
    }
  }

  if (!aceitos.length) {
    return NextResponse.json({ ok: true, dispatched: 0, rejeitados: recusados }, { status: 202 });
  }

  const userAgent = req.headers.get('user-agent') || undefined;

  /**
   * ESTE É O ÚNICO LUGAR COM O USER-AGENT NA MÃO.
   *
   * O FlowOps recebe o evento deste servidor, não do navegador — pra ele todo
   * mundo tem o user-agent da Vercel. Se o carimbo não sair daqui, não sai de
   * lugar nenhum, e o card "Agora no site" volta a contar robô como pessoa
   * (16/08/2026: 25 "pessoas" em /lojas numa manhã de 1 visita por hora).
   */
  const robo = detectarRobo(userAgent);

  const signals = {
    fbp: meta?.fbp,
    fbc: meta?.fbc,
    client_ip_address: ip,
    client_user_agent: userAgent,
  };

  try {
    /**
     * Em paralelo, não em sequência: a gravação no FlowOps não pode atrasar o
     * despacho pras plataformas. `allSettled` porque as duas pontas já engolem
     * o próprio erro — e se uma escapar, a outra ainda tem que acontecer.
     *
     * Awaited de propósito, apesar de ser "fire and forget" conceitual: função
     * serverless morre quando a resposta termina e leva junto qualquer promise
     * solta (ver docs/limitacoes.md). Não dá pra soltar sem await aqui.
     */
    /**
     * `semAceite` continua sendo `!consentido` — e não pode virar
     * `postura === 'recusou'`. É essa coluna que responde "quanto do funil o
     * Meta enxerga de verdade"; afrouxá-la aqui apagaria a régua justamente
     * quando ela passou a ter duas respostas diferentes.
     */
    const [despacho] = await Promise.allSettled([
      despacharPorPostura(postura, aceitos, signals),
      persistirCliquesDeLoja(aceitos),
      persistirEventosSite(aceitos, !consentido, robo),
    ]);
    const dispatched = despacho.status === 'fulfilled' ? despacho.value.dispatched : 0;
    if (despacho.status === 'rejected') throw despacho.reason;
    return NextResponse.json({ ok: true, dispatched, rejeitados: recusados }, { status: 202 });
  } catch (err) {
    // Falha aqui não pode virar erro visível: o navegador não tem o que fazer
    // com isso, e o log já registrou o problema real.
    console.error('[tracking] falha no despacho:', err);
    return NextResponse.json({ ok: false, error: 'falha no despacho' }, { status: 202 });
  }
}
