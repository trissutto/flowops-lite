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
import { dispatchBatch } from '@/lib/tracking/server/dispatch';
import { getLogStore } from '@/lib/tracking/server/log-store';
import { consentStateSchema, trackingEventSchema } from '@/lib/tracking/schemas';
import { SERVER_ONLY_EVENTS } from '@/lib/tracking/types';

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

  // Gate de consentimento, de novo. O cliente já filtrou, mas quem garante é
  // quem tem o token da plataforma na mão.
  if (!consent.analytics && !consent.marketing) {
    return NextResponse.json({ ok: true, dispatched: 0, reason: 'sem consentimento' }, { status: 202 });
  }

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

  const signals = {
    fbp: meta?.fbp,
    fbc: meta?.fbc,
    client_ip_address: ip,
    client_user_agent: req.headers.get('user-agent') || undefined,
  };

  try {
    const { dispatched } = await dispatchBatch(aceitos, signals);
    return NextResponse.json({ ok: true, dispatched, rejeitados: recusados }, { status: 202 });
  } catch (err) {
    // Falha aqui não pode virar erro visível: o navegador não tem o que fazer
    // com isso, e o log já registrou o problema real.
    console.error('[tracking] falha no despacho:', err);
    return NextResponse.json({ ok: false, error: 'falha no despacho' }, { status: 202 });
  }
}
