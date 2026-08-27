/**
 * POST /api/webhooks/payment — "o pedido X foi pago".
 *
 * ── QUEM BATE NESTA PORTA MUDOU (Sprint 011) ────────────────────────────────
 * ANTES: a Pagar.me chamava aqui direto, e a rota validava a assinatura HMAC
 * do corpo antes de marcar o pedido como pago no store em memória.
 *
 * AGORA: quem fala com a Pagar.me é o BACKEND FlowOps — ele é dono do pedido
 * (Postgres) e da cobrança. O webhook do gateway vai pra lá, o backend confirma
 * o pagamento, e só então chama ESTA rota pra dizer "pode contar a venda".
 *
 * Consequência direta: a validação HMAC da Pagar.me SAIU daqui. Não é
 * simplificação por preguiça — é que ela viraria teatro: o corpo não é mais o
 * da Pagar.me, é o nosso, então não haveria assinatura deles pra conferir. A
 * autenticação agora é o SEGREDO COMPARTILHADO `PAYMENT_WEBHOOK_SECRET`, a
 * mesma env dos dois lados (backend e ecommerce). Chamada server-to-server
 * entre sistemas nossos, com segredo, sobre TLS.
 *
 * O QUE ESTA ROTA FAZ: emite o `purchase` (GA4 + Meta CAPI). Só isso. Ela não
 * marca nada como pago — não há mais o que marcar. Por isso o corpo traz os
 * DADOS DA COMPRA junto: o ecommerce não tem mais o pedido em memória pra
 * consultar, e ir buscar no backend só pra montar o evento seria um round-trip
 * a mais no caminho crítico do dinheiro.
 *
 * Segurança em camadas, mesmo padrão do /api/events/logs:
 *   - sem `PAYMENT_WEBHOOK_SECRET` a rota responde 404 — ela simplesmente não
 *     existe pra quem não deveria saber que ela existe;
 *   - segredo errado TAMBÉM responde 404 (não confirmar a existência da rota
 *     pra quem está chutando) — comparação em tempo constante;
 *   - payload validado com zod; qualquer coisa fora do shape é recusada.
 *
 * IDEMPOTÊNCIA EM DUAS CAMADAS: o `event_id` do purchase é derivado do
 * `transaction_id` (a Meta conta uma venda só, mesmo com retry), e o guard em
 * memória abaixo corta a rajada antes de gastar rede — retry de fila costuma
 * vir em lote de 3-5 em segundos.
 */

import { createHash, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { emitirPurchaseConfirmado } from '@/lib/orders/confirm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * SCHEMA DELIBERADAMENTE TOLERANTE.
 *
 * Do outro lado tem um Prisma: campo opcional vem `null`, não ausente, e
 * `Decimal` serializa como STRING ("80.00") quando escapa de um `toNumber()`.
 * Um zod rígido transformaria isso em 400 — e 400 aqui significa purchase que
 * nunca dispara, em silêncio, com o pedido já pago. É a armadilha do "vazio
 * tratado como resposta" que a casa já pagou caro pra aprender.
 *
 * Então: `null` vira `undefined`, número aceita string numérica, e nada que
 * seja só rótulo (nome, número do pedido) derruba a chamada.
 */
const texto = z.string().nullish().transform((v) => v ?? undefined);
const textoObrigatorio = z.string().nullish().transform((v) => v ?? '');

const purchaseItemSchema = z.object({
  product_id: textoObrigatorio,
  sku: texto,
  name: textoObrigatorio,
  cor: texto,
  tamanho: texto,
  quantidade: z.coerce.number().int().positive().catch(1),
  valor: z.coerce.number().nonnegative(),
});

const purchaseSchema = z.object({
  number: textoObrigatorio,
  total: z.coerce.number().nonnegative(),
  coupon: texto,
  payment_method: textoObrigatorio,
  items: z.array(purchaseItemSchema).nullish().transform((v) => v ?? []),
  customer: z
    .object({ email: texto, phone: texto, cpf: texto })
    .nullish()
    .transform((v) => v ?? {}),
  tracking: z
    .object({
      anonymous_id: texto,
      session_id: texto,
      fbp: texto,
      fbc: texto,
      // ⚠️ zod poda chave desconhecida: sem estas duas linhas o cookie do
      // gtag chega do backend e morre aqui, e o purchase volta a ser "direto".
      ga4_client_id: texto,
      ga4_session_id: texto,
      attribution: z.record(z.string(), z.string().optional()).nullish().transform((v) => v ?? undefined),
    })
    .nullish()
    .transform((v) => v ?? undefined),
  // Fora do contrato mínimo, aceito se vier: liga a venda online ao acerto da
  // loja física quando o pedido é retirada.
  store_slug: texto,
});

const bodySchema = z.object({
  orderId: z.string().min(1),
  status: z.literal('paid'),
  paidAt: z.string().optional(),
  purchase: purchaseSchema,
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

/* ────────────────────────────────────────────────────────────────────────────
 * Guard de rajada — idempotência barata, por instância
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Memória por instância serverless: NÃO é a garantia de idempotência (essa é
 * o `event_id` derivado do pedido, que vale entre instâncias e entre dias).
 * É só o para-choque do caso comum — a fila do backend reentregando o mesmo
 * webhook 3 vezes em 10 segundos, provavelmente na mesma instância quente.
 */
const JANELA_GUARD_MS = 10 * 60_000;
const MAX_GUARD = 1_000;

const globalRef = globalThis as unknown as { __lurdsPurchaseGuard?: Map<string, number> };
const jaProcessados = globalRef.__lurdsPurchaseGuard ?? new Map<string, number>();
globalRef.__lurdsPurchaseGuard = jaProcessados;

function repetido(orderId: string): boolean {
  const agora = Date.now();
  const visto = jaProcessados.get(orderId);
  if (visto && agora - visto < JANELA_GUARD_MS) return true;

  jaProcessados.set(orderId, agora);
  if (jaProcessados.size > MAX_GUARD) {
    // Map preserva ordem de inserção: descarta a metade mais antiga de uma vez
    // (melhor que varrer por timestamp a cada chamada).
    let i = 0;
    for (const key of jaProcessados.keys()) {
      if (i++ >= MAX_GUARD / 2) break;
      jaProcessados.delete(key);
    }
  }
  return false;
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
    // Loga o CAMPO que falhou (sem valor, que pode ser PII): payload recusado
    // em silêncio é venda que não conta e ninguém descobre por quê.
    logWebhook({
      outcome: 'payload_invalido',
      campos: parsed.error.issues.slice(0, 5).map((i) => i.path.join('.')),
    });
    return NextResponse.json({ ok: false, error: 'payload inválido' }, { status: 400 });
  }

  const { orderId, paidAt, purchase } = parsed.data;

  if (repetido(orderId)) {
    logWebhook({ outcome: 'repetido', order_id: orderId, number: purchase.number });
    // 200 de propósito: repetição não é erro, é o contrato de qualquer fila de
    // retry. Devolver erro faria o backend reenfileirar pra sempre.
    return NextResponse.json({ ok: true, already: true });
  }

  const result = await emitirPurchaseConfirmado(orderId, paidAt ?? new Date().toISOString(), purchase);

  logWebhook({
    outcome: result.ok ? 'purchase_emitido' : 'purchase_falhou',
    order_id: orderId,
    number: purchase.number,
    total: purchase.total,
    method: purchase.payment_method,
    reason: result.reason,
  });

  // Sempre 200 quando o segredo e o payload conferem: o pedido JÁ está pago no
  // Postgres do Flow, e o purchase é efeito colateral de marketing. Devolver
  // erro só faria o backend reprocessar um pagamento que já está resolvido —
  // e a falha de despacho já está no log pra quem for investigar ROAS.
  return NextResponse.json({ ok: true, tracked: result.ok });
}
