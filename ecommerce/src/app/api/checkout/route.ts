/**
 * POST /api/checkout — cria o pedido.
 *
 * NADA que veio do cliente é confiável: subtotal, desconto, frete e total são
 * RECALCULADOS aqui com as mesmas funções que a UI usa (`applyCoupon`,
 * `findQuote`). O client manda os fatos (itens, CEP, cupom, escolha de frete);
 * o server refaz a conta e é a conta dele que vale.
 *
 * ⚠️ PENDÊNCIA HONESTA — preço unitário dos itens: no MVP o `unitPrice` do
 * client NÃO é reconferido contra o catálogo. Validar exigiria buscar cada
 * SKU no backend (`/public/loja/produtos?busca=` acha por sku, mas é uma
 * chamada por item — sem endpoint batch fica caro e frágil no meio do
 * checkout). Enquanto o endpoint de preço em lote não existe, aplicamos teto
 * de sanidade (> R$ 0 e < R$ 10.000 por peça) e o pedido nasce como
 * `awaiting_payment` — nenhum estoque baixa e nenhum real se move antes de
 * gente ver o dinheiro. Quando o endpoint existir, a validação entra AQUI.
 */

import { NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { z } from 'zod';
import { applyCoupon } from '@/lib/commerce/cupom';
import { findQuote } from '@/lib/commerce/frete';
import { confirmPayment } from '@/lib/orders/confirm';
import { nextOrderNumber } from '@/lib/orders/number';
import { getOrderStore } from '@/lib/orders/store';
import { getPaymentProvider } from '@/lib/payments/provider';
import type { CreateOrderResult, Order } from '@/types/checkout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ────────────────────────────────────────────────────────────────────────────
 * Validação — espelho zod do contrato CreateOrderInput (types/checkout.ts)
 * ──────────────────────────────────────────────────────────────────────────── */

const imageSchema = z.object({
  src: z.string().min(1),
  alt: z.string(),
  aspect: z.enum(['1/1', '3/4', '4/5', '4/3', '16/9', '21/9']).optional(),
});

const cartLineSchema = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1).max(200),
  image: imageSchema,
  size: z.string().min(1).max(10),
  color: z.string().max(60).optional(),
  quantity: z.number().int().min(1).max(20),
  // Teto de sanidade enquanto o preço não é reconferido no catálogo (ver
  // cabeçalho): nenhuma peça da Lurd's custa R$ 0 nem R$ 10.000.
  unitPrice: z.number().gt(0).lt(10_000),
});

const addressSchema = z.object({
  cep: z.string().regex(/^\d{8}$/, 'CEP com 8 dígitos'),
  street: z.string().min(1).max(160),
  number: z.string().min(1).max(20),
  complement: z.string().max(80).optional(),
  neighborhood: z.string().min(1).max(80),
  city: z.string().min(1).max(80),
  uf: z.string().length(2),
});

const customerSchema = z.object({
  name: z.string().min(3).max(120),
  email: z.string().email(),
  cpf: z.string().regex(/^\d{11}$/, 'CPF só dígitos'),
  phone: z.string().regex(/^\d{10,11}$/, 'telefone com DDD, só dígitos'),
});

const trackingSchema = z
  .object({
    anonymous_id: z.string().max(100).optional(),
    session_id: z.string().max(100).optional(),
    fbp: z.string().max(100).optional(),
    fbc: z.string().max(200).optional(),
    attribution: z.record(z.string(), z.string().optional()).optional(),
  })
  .optional();

const bodySchema = z.object({
  customer: customerSchema,
  shippingAddress: addressSchema.optional(),
  shippingQuoteId: z.string().min(1),
  cep: z.string().min(8).max(9), // com ou sem hífen — findQuote normaliza
  items: z.array(cartLineSchema).min(1).max(50),
  couponCode: z.string().max(30).optional(),
  paymentMethod: z.enum(['pix', 'card', 'boleto']),
  // 12 acompanha o CardForm (MAX_PARCELAS) — os dois limites andam JUNTOS.
  installments: z.number().int().min(1).max(12).optional(),
  // Token de uso único da Pagar.me, gerado no navegador — nunca é o cartão.
  cardToken: z.string().min(8).max(120).optional(),
  tracking: trackingSchema,
});

/* ────────────────────────────────────────────────────────────────────────────
 * Rate limit — mesmo padrão do /api/events, janela própria e mais apertada:
 * criar pedido é ação rara; 10/min por IP segura script sem atrapalhar gente.
 * ──────────────────────────────────────────────────────────────────────────── */

const JANELA_MS = 60_000;
const MAX_REQ_POR_JANELA = 10;

const globalRef = globalThis as unknown as { __lurdsCheckoutRate?: Map<string, { count: number; reset: number }> };
const buckets = globalRef.__lurdsCheckoutRate ?? new Map<string, { count: number; reset: number }>();
globalRef.__lurdsCheckoutRate = buckets;

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

const round2 = (v: number) => Math.round(v * 100) / 100;

export async function POST(req: Request): Promise<NextResponse<CreateOrderResult>> {
  const ip = clientIp(req);
  if (excedeuLimite(ip)) {
    return NextResponse.json(
      { ok: false, error: 'Muitas tentativas seguidas. Respire fundo e tente de novo em instantes.' },
      { status: 429 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Não conseguimos ler seu pedido. Tente novamente.' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Alguns dados do pedido não conferem. Revise as informações e tente de novo.' },
      { status: 400 },
    );
  }
  const input = parsed.data;

  /* ── RECÁLCULO SERVER-SIDE — a conta que vale é esta ── */

  const subtotal = round2(input.items.reduce((soma, l) => soma + l.unitPrice * l.quantity, 0));

  // Cupom: mesma função da sacola, rodando AQUI (env CUPONS_JSON tem
  // precedência no server). Cupom inválido derruba o pedido com a mensagem
  // elegante da própria regra — nunca aplica em silêncio um desconto errado.
  let discount = 0;
  let couponKind: 'percent' | 'fixed' | 'shipping' | undefined;
  let couponCode: string | undefined;
  if (input.couponCode) {
    const cupom = applyCoupon(input.couponCode, subtotal);
    if (!cupom.ok) {
      return NextResponse.json({ ok: false, error: cupom.message }, { status: 400 });
    }
    discount = cupom.discount;
    couponKind = cupom.kind;
    couponCode = cupom.code;
  }

  // Frete: recotado pelo CEP + subtotal. O id escolhido no client precisa
  // existir na cotação do server — senão alguém inventou frete.
  const quote = findQuote(input.cep, subtotal, input.shippingQuoteId);
  if (!quote) {
    return NextResponse.json(
      { ok: false, error: 'Não conseguimos confirmar o frete para este CEP. Volte uma etapa e escolha a entrega de novo.' },
      { status: 400 },
    );
  }

  // Entrega em casa exige endereço; retirada dispensa.
  if (quote.kind !== 'retirada' && !input.shippingAddress) {
    return NextResponse.json(
      { ok: false, error: 'Falta o endereço de entrega. Volte uma etapa e confira os dados.' },
      { status: 400 },
    );
  }

  // Cupom de frete zera o econômico (PAC) — mesma regra da sacola: grátis é
  // o econômico, nunca o expresso.
  let shippingPrice = quote.price;
  if (couponKind === 'shipping' && quote.kind === 'correios') shippingPrice = 0;

  const total = round2(subtotal - discount + shippingPrice);
  if (total <= 0) {
    return NextResponse.json(
      { ok: false, error: 'Algo não fechou no total do pedido. Revise a sacola e tente novamente.' },
      { status: 400 },
    );
  }

  /* ── Meio de pagamento ── */

  const provider = getPaymentProvider();

  // Boleto ainda não tem provider; cartão exige provider com o método E token
  // (transparente: sem token não há o que cobrar — provavelmente a Public Key
  // não está configurada no client).
  const cartaoDisponivel = typeof provider.createCardCharge === 'function';
  if (
    input.paymentMethod === 'boleto' ||
    (input.paymentMethod === 'card' && (!cartaoDisponivel || !input.cardToken))
  ) {
    return NextResponse.json({
      ok: false,
      error: 'Estamos finalizando este meio de pagamento — por enquanto, o Pix garante seu pedido (e com desconto).',
    });
  }

  /* ── Cria o pedido + cobrança ── */

  const order: Order = {
    id: crypto.randomUUID(),
    number: nextOrderNumber(),
    status: 'awaiting_payment',
    createdAt: new Date().toISOString(),
    customer: input.customer,
    shippingAddress: input.shippingAddress,
    shipping: quote,
    items: input.items,
    subtotal,
    discount,
    couponCode,
    shippingPrice,
    total,
    payment: { method: input.paymentMethod, installments: input.installments },
    tracking: input.tracking,
  };

  if (input.paymentMethod === 'card') {
    /* CARTÃO — resposta síncrona: pago ou recusado, sem tela de espera. */
    try {
      const cobranca = await provider.createCardCharge!(order, input.cardToken!, input.installments ?? 1);
      if (cobranca.status === 'refused') {
        // Recusa NÃO cria pedido: a cliente ajusta o cartão e tenta de novo
        // sem deixar rastro de pedido morto (e sem furar o rate-limit à toa).
        return NextResponse.json({ ok: false, error: cobranca.reason ?? 'O cartão não foi autorizado. Tente outro cartão — ou o Pix, que aprova na hora.' });
      }
      order.payment.gatewayOrderId = cobranca.gatewayOrderId;
      await getOrderStore().create(order);
      // Dinheiro confirmado pelo gateway → o MESMO caminho do webhook marca
      // pago e dispara o purchase (uma vez, server-side).
      await confirmPayment(order.id);
      const pago = await getOrderStore().get(order.id);
      const { tracking: _t, ...semTracking } = pago ?? order;
      return NextResponse.json({ ok: true, order: semTracking as Order }, { status: 201 });
    } catch (err) {
      console.error('[checkout] falha na cobrança de cartão:', err);
      return NextResponse.json(
        { ok: false, error: 'Não conseguimos processar o cartão agora. Tente novamente — ou o Pix, que aprova na hora.' },
        { status: 502 },
      );
    }
  }

  /* PIX */
  try {
    const charge = await provider.createPixCharge(order);
    // QR e copia-e-cola nascem do MESMO payload — o que a câmera lê é o que
    // a cliente cola no app.
    const qrCode = await QRCode.toDataURL(charge.copyPaste, { margin: 1, width: 320 });
    order.payment.pix = { qrCode, copyPaste: charge.copyPaste, expiresAt: charge.expiresAt };
    order.payment.gatewayOrderId = charge.gatewayOrderId;
  } catch (err) {
    console.error('[checkout] falha ao criar cobrança PIX:', err);
    return NextResponse.json(
      { ok: false, error: 'Não conseguimos gerar seu Pix agora. Tente novamente em instantes.' },
      { status: 502 },
    );
  }

  await getOrderStore().create(order);

  // O tracking volta pra fora? Não — o client já tem os próprios sinais, e
  // devolver economiza um vazamento bobo em log de rede.
  const { tracking: _tracking, ...semTracking } = order;
  return NextResponse.json({ ok: true, order: semTracking as Order }, { status: 201 });
}
