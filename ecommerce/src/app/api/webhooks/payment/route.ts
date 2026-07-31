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

import { createHash, createHmac, timingSafeEqual } from 'crypto';
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
 * Formato Pagar.me (v5): { type: 'order.paid', data: { id, status, metadata } }.
 * O nosso id de pedido volta em `data.metadata.ecommerce_order_id` — foi
 * plantado lá na criação da order exatamente pra este momento.
 */
const pagarmeSchema = z.object({
  type: z.string(),
  data: z.object({
    id: z.string().optional(),
    status: z.string().optional(),
    metadata: z.object({ ecommerce_order_id: z.string().min(1) }).partial().optional(),
  }),
});

/**
 * Assinatura da Pagar.me: HMAC-SHA256 do CORPO CRU no header X-Hub-Signature
 * (formato `sha256=<hex>`), com o secret configurado junto do webhook no
 * dashboard. Validar sobre o corpo cru é obrigatório — re-serializar o JSON
 * muda bytes e invalida um HMAC legítimo.
 */
function assinaturaPagarmeConfere(rawBody: string, header: string, secret: string): boolean {
  const esperado = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const recebido = header.replace(/^sha256=/i, '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(recebido)) return false;
  return timingSafeEqual(Buffer.from(esperado, 'hex'), Buffer.from(recebido, 'hex'));
}

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
  const secretPagarme = process.env.PAGARME_WEBHOOK_SECRET;
  const secretSimples = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secretPagarme && !secretSimples) {
    // Sem env a rota não existe — impossível autenticar, então nem conversa.
    return NextResponse.json({ error: 'não encontrado' }, { status: 404 });
  }

  // Corpo CRU primeiro: o HMAC da Pagar.me é sobre os bytes originais.
  const rawBody = await req.text();

  /* ── Autenticação: Pagar.me (X-Hub-Signature) OU modo simples ── */
  const hubSignature = req.headers.get('x-hub-signature') ?? '';
  let viaPagarme = false;

  if (hubSignature && secretPagarme) {
    if (!assinaturaPagarmeConfere(rawBody, hubSignature, secretPagarme)) {
      logWebhook({ outcome: 'assinatura_pagarme_invalida' });
      return NextResponse.json({ error: 'não encontrado' }, { status: 404 });
    }
    viaPagarme = true;
  } else {
    const recebido = req.headers.get('x-webhook-secret') ?? '';
    if (!secretSimples || !recebido || !segredoConfere(recebido, secretSimples)) {
      logWebhook({ outcome: 'segredo_invalido' });
      return NextResponse.json({ error: 'não encontrado' }, { status: 404 });
    }
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    logWebhook({ outcome: 'json_invalido' });
    return NextResponse.json({ ok: false, error: 'JSON inválido' }, { status: 400 });
  }

  /* ── Resolve o id do NOSSO pedido nos dois formatos ── */
  let orderId: string | null = null;

  if (viaPagarme) {
    const parsed = pagarmeSchema.safeParse(raw);
    if (!parsed.success) {
      logWebhook({ outcome: 'payload_pagarme_invalido' });
      return NextResponse.json({ ok: false, error: 'payload inválido' }, { status: 400 });
    }
    // Só `order.paid` confirma dinheiro. Os demais eventos (created, canceled,
    // charge.*) são aceitos com 200 e ignorados — responder erro faria a
    // Pagar.me reenfileirar pra sempre um evento que não nos interessa.
    if (parsed.data.type !== 'order.paid') {
      logWebhook({ outcome: 'evento_ignorado', type: parsed.data.type });
      return NextResponse.json({ ok: true, ignored: true });
    }
    orderId = parsed.data.data.metadata?.ecommerce_order_id ?? null;
    if (!orderId) {
      // order.paid sem o nosso metadata: pode ser cobrança de OUTRO sistema
      // na mesma conta (a live usa a mesma Pagar.me). Ignorar com 200.
      logWebhook({ outcome: 'sem_metadata_ecommerce', gateway_order: parsed.data.data.id });
      return NextResponse.json({ ok: true, ignored: true });
    }
  } else {
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      logWebhook({ outcome: 'payload_invalido' });
      return NextResponse.json({ ok: false, error: 'payload inválido' }, { status: 400 });
    }
    orderId = parsed.data.orderId;
  }

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
