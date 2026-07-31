/**
 * POST /api/webhooks/payment — a porta que o gateway bate quando o dinheiro
 * entra.
 *
 * Segurança em camadas, mesmo padrão do /api/events/logs:
 *   - sem `PAYMENT_WEBHOOK_SECRET` configurada a rota responde 404 — ela
 *     simplesmente não existe pra quem não deveria saber que ela existe;
 *   - segredo errado TAMBÉM responde 404 (não confirmar a existência da rota
 *     pra quem está chutando) — comparação em tempo constante;
 *   - payload validado com zod; qualquer coisa fora do shape é recusada.
 *
 * IDEMPOTENTE POR CONSTRUÇÃO: a confirmação delega pro `confirmPayment`, que
 * trata pedido já pago como no-op. Gateway reenvia webhook (e reenvia MESMO
 * — é o contrato deles); nós respondemos 200 de novo e nada duplica, nem o
 * purchase (event_id derivado do pedido).
 */

import { createHash, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { confirmPayment } from '@/lib/orders/confirm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  orderId: z.string().min(1),
  status: z.literal('paid'),
});

/**
 * Comparação em tempo constante: hash dos dois lados iguala o tamanho, e o
 * `timingSafeEqual` impede que a diferença de tempo entregue o segredo byte
 * a byte.
 */
function segredoConfere(recebido: string, esperado: string): boolean {
  const a = createHash('sha256').update(recebido).digest();
  const b = createHash('sha256').update(esperado).digest();
  return timingSafeEqual(a, b);
}

/** Trilha de TODA chamada — webhook é raro e é dinheiro: loga sempre, sem PII. */
function logWebhook(dados: Record<string, unknown>): void {
  console.log(JSON.stringify({ tag: 'payment_webhook', at: new Date().toISOString(), ...dados }));
}

export async function POST(req: Request) {
  const esperado = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!esperado) {
    // Sem env a rota não existe — impossível autenticar, então nem conversa.
    return NextResponse.json({ error: 'não encontrado' }, { status: 404 });
  }

  const recebido = req.headers.get('x-webhook-secret') ?? '';
  if (!recebido || !segredoConfere(recebido, esperado)) {
    logWebhook({ outcome: 'segredo_invalido' });
    return NextResponse.json({ error: 'não encontrado' }, { status: 404 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    logWebhook({ outcome: 'json_invalido' });
    return NextResponse.json({ ok: false, error: 'JSON inválido' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    logWebhook({ outcome: 'payload_invalido' });
    return NextResponse.json({ ok: false, error: 'payload inválido' }, { status: 400 });
  }

  const { orderId } = parsed.data;
  const result = await confirmPayment(orderId);

  logWebhook({
    outcome: result.ok ? (result.already ? 'ja_estava_pago' : 'confirmado') : 'recusado',
    order_id: orderId,
    reason: result.reason,
  });

  if (!result.ok) {
    // 404 pro pedido inexistente (gateway pode reenfileirar); 409 pro estado
    // que não aceita pagamento (cancelado) — reenviar não vai mudar nada.
    const status = result.reason === 'pedido não encontrado' ? 404 : 409;
    return NextResponse.json({ ok: false, error: result.reason }, { status });
  }

  return NextResponse.json({ ok: true, already: result.already ?? false });
}
