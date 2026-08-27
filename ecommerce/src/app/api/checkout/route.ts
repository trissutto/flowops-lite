/**
 * POST /api/checkout — cria o pedido NO BACKEND FLOWOPS.
 *
 * Sprint 011: esta rota deixou de ser dona do pedido. Ela continua sendo a
 * PRIMEIRA BARREIRA (zod, rate-limit, recálculo de cupom/frete/total) e passou
 * a ser um BFF: monta o payload e chama `POST /public/loja/pedido`. Quem cria
 * o pedido no Postgres, cobra na Pagar.me e confirma o pagamento é o backend —
 * ver `src/lib/orders/store.ts` pro porquê.
 *
 * Por que manter o recálculo se o backend reconfere: barreira dupla é barata e
 * pega coisa diferente. Aqui o cupom é o da vitrine (mesma função da sacola, o
 * que garante que a conta mostrada é a conta cobrada) e o frete sai da tabela
 * do site. Se um dos dois divergir do backend, o do BACKEND vence no total
 * final — ele é o dono do pedido — e a divergência sai no log pra alguém olhar.
 *
 * NADA que veio do cliente é confiável: subtotal, desconto, frete e total são
 * RECALCULADOS aqui com as mesmas funções que a UI usa (`applyCoupon`,
 * `findQuote`). O client manda os fatos (itens, CEP, cupom, escolha de frete).
 *
 * PREÇO UNITÁRIO: aqui vale só o teto de sanidade (> R$ 0 e < R$ 10.000 por
 * peça). Quem reconfere peça por peça contra o catálogo é o BACKEND, no
 * `CarrinhoGuard` — ele tem o espelho do ERP na mão e é quem cobra. Desde
 * 06/08 (bloco A da lista de lançamento) preço, estoque e publicação de cada
 * item são relidos lá antes de qualquer cobrança, e o total daqui serve de
 * TETO: se a conta do backend der mais, o pedido é recusado em vez de cobrar
 * acima do que a cliente leu na tela.
 */

import { NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { z } from 'zod';
import { applyCoupon } from '@/lib/commerce/cupom';
import { pixDiscount } from '@/lib/commerce/pix';
import { resolverFrete, type FreteResolvido } from '@/lib/commerce/frete-server';
import { campoDoZod } from '@/lib/orders/campo-reprovado';
import { getPublicPromotion } from '@/services/promotion';
import { previewBuyFourPayThree } from '@/lib/commerce/buy-four-pay-three';
import { getOrderStore, OrderStoreError, type NewOrderPayload } from '@/lib/orders/store';
import { formatPrice } from '@/lib/utils';
import type { CreateOrderResult, Order } from '@/types/checkout';

/**
 * Resposta do "o frete que você viu mudou" (17/08) — o pré-check DESTE BFF.
 * `CheckoutErrorCode` já tem `'shipping_changed'` e `CreateOrderResult` já
 * tem `quote` (o backend também devolve esse code quando só o frete subiu na
 * recotação dele); aqui a `quote` é a `FreteResolvido` inteira, que carrega
 * mais campo (kind, estimado…) e é o que a tela de Entrega consome de volta.
 */
type ShippingChangedResult = Omit<CreateOrderResult, 'code' | 'ok' | 'quote'> & {
  ok: false;
  code: 'shipping_changed';
  /** A opção recotada agora, com o preço que VALE — a tela volta pra Entrega com ela. */
  quote: FreteResolvido;
  /** O que a cliente tinha lido — pro aviso "R$ X → R$ Y". */
  shippingPriceSeen: number;
};

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ────────────────────────────────────────────────────────────────────────────
 * Validação — espelho zod do contrato CreateOrderInput (types/checkout.ts)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * FOTO NÃO BARRA VENDA (17/08).
 *
 * `src: min(1)` + `alt` obrigatório + `aspect` numa lista fechada — pra
 * RECUSAR O PEDIDO INTEIRO. E a sacola põe `{ src: '', alt }` quando a peça
 * (ou a cor escolhida) não tem foto — caso comum aqui. Resultado: cliente
 * com a sacola cheia, CPF e PIX escolhido, e o checkout devolvendo "alguns
 * dados não conferem" 14 vezes seguidas (Kênia, 17/08 06:25 — foi pro
 * WhatsApp da loja dizer que não conseguiu). A imagem é enfeite do
 * resumo; o pedido vive de sku/nome/tamanho/cor. Tudo aqui é opcional e
 * tolerante — e o objeto inteiro pode faltar.
 */
const imageSchema = z
  .object({
    src: z.string().max(2000).optional().catch(undefined),
    alt: z.string().max(300).optional().catch(undefined),
    aspect: z.string().max(10).optional().catch(undefined),
  })
  .optional()
  .catch(undefined);

const cartLineSchema = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1).max(200),
  image: imageSchema,
  size: z.string().min(1).max(20),
  color: z.string().max(80).optional(),
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

/**
 * RASTREIO NÃO BARRA VENDA (17/08).
 *
 * Cada campo aqui é telemetria: se vier torto, o certo é DESCARTAR O CAMPO,
 * nunca o pedido. `fbc: max(200)` era uma bomba armada — os pedidos que
 * passavam tinham 195 caracteres, e anúncio de catálogo do Meta gera
 * fbclid mais longo. Cinco caracteres a mais no cookie do clique e a
 * cliente não conseguia pagar. `.catch(undefined)` em cada um: o valor
 * inválido some, o pedido segue.
 */
const trackingSchema = z
  .object({
    anonymous_id: z.string().max(200).optional().catch(undefined),
    session_id: z.string().max(200).optional().catch(undefined),
    fbp: z.string().max(300).optional().catch(undefined),
    fbc: z.string().max(1000).optional().catch(undefined),
    /**
     * Cookies do gtag (`_ga` e `_ga_<sufixo>`). São o `fbp`/`fbc` do Google:
     * sem eles o `purchase`, que nasce no servidor, chega ao GA4 como visitante
     * novo e a importação pro Ads não acha clique nenhum pra creditar.
     */
    ga4_client_id: z.string().max(120).optional().catch(undefined),
    ga4_session_id: z.string().max(60).optional().catch(undefined),
    attribution: z.record(z.string(), z.string().optional()).optional().catch(undefined),
    /**
     * O "sim" do lembrete de WhatsApp. Faltava aqui, e zod PODA chave
     * desconhecida em silêncio: o consentimento saía do navegador, morria
     * neste schema e nunca chegava no `trackingInfo` do pedido — o cron de
     * resgate do PIX (`recovery_consent === true`) não achava ninguém.
     */
    recovery_consent: z.boolean().optional().catch(undefined),
  })
  .optional()
  .catch(undefined);

const bodySchema = z.object({
  customer: customerSchema,
  shippingAddress: addressSchema.optional(),
  shippingQuoteId: z.string().min(1),
  cep: z.string().min(8).max(9), // com ou sem hífen — findQuote normaliza
  items: z.array(cartLineSchema).min(1).max(50),
  couponCode: z.string().max(30).optional(),
  paymentMethod: z.enum(['pix', 'card']),
  installments: z.number().int().min(1).max(12).optional(),
  // Token da Pagar.me gerado NO NAVEGADOR (PCI: o número do cartão não passa
  // por este servidor nem pelo backend). Só o token trafega.
  cardToken: z.string().min(5).max(200).optional(),
  tracking: trackingSchema,
  /**
   * O QUE A CLIENTE LEU NA TELA (17/08): frete já com o cupom de frete
   * aplicado e total do resumo pro meio de pagamento escolhido.
   *
   * Até aqui só o `shippingQuoteId` viajava; o BFF recotava e cobrava o dele,
   * e o TETO do backend comparava com o total DO BFF — nunca com o da tela.
   * Se a tela tinha caído na tabela local (PAC SP 14,90) e na hora do PIX o
   * cache do backend já estava quente (PAC real 21,xx), o QR nascia R$ 6-7
   * acima do resumo que ela acabou de ler. No cartão é pior: cobra no ato.
   *
   * `.optional().catch(undefined)`: aba aberta antes do deploy não manda os
   * campos e continua fechando pedido do jeito antigo (informado = total do
   * BFF). Valor torto vira ausente, nunca derruba o pedido.
   */
  shippingPriceSeen: z.number().min(0).optional().catch(undefined),
  totalSeen: z.number().min(0).optional().catch(undefined),
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

export async function POST(req: Request): Promise<NextResponse<CreateOrderResult | ShippingChangedResult>> {
  const ip = clientIp(req);
  if (excedeuLimite(ip)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Muitas tentativas seguidas. Respire fundo e tente de novo em instantes.',
        code: 'rate_limited',
      },
      { status: 429 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: 'Não conseguimos ler seu pedido. Tente novamente.',
        code: 'validation_error',
        field: 'corpo_ilegivel',
      },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const campo = campoDoZod(parsed.error);
    // Log com o NOME do campo (sem valor): é o que transforma "não conferem"
    // numa causa investigável quando a mesma cliente falha cinco vezes.
    console.warn(`[checkout] payload reprovado no zod — campo=${campo}`);
    return NextResponse.json(
      {
        ok: false,
        error: 'Alguns dados do pedido não conferem. Revise as informações e tente de novo.',
        code: 'validation_error',
        field: campo,
      },
      { status: 400 },
    );
  }
  const input = parsed.data;

  /* ── RECÁLCULO SERVER-SIDE — a primeira barreira ── */

  const subtotal = round2(input.items.reduce((soma, l) => soma + l.unitPrice * l.quantity, 0));
  const promotionConfig = await getPublicPromotion();
  const promotionPreview = previewBuyFourPayThree(
    input.items.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
    })),
  );
  const promotionApplied =
    promotionConfig.enabled &&
    promotionConfig.mode === 'buy_4_pay_3' &&
    promotionPreview.applied;
  const promotionDiscount = promotionApplied ? promotionPreview.discountValue : 0;

  // Cupom: mesma função da sacola, rodando AQUI (env CUPONS_JSON tem
  // precedência no server). Cupom inválido derruba o pedido com a mensagem
  // elegante da própria regra — nunca aplica em silêncio um desconto errado.
  let discount = 0;
  let couponKind: 'percent' | 'fixed' | 'shipping' | undefined;
  let couponCode: string | undefined;
  if (input.couponCode) {
    if (promotionApplied) {
      return NextResponse.json(
        {
          ok: false,
          error: 'A promoção Leve 4, Pague 3 não acumula com cupom. Remova o cupom e tente novamente.',
          code: 'coupon_invalid',
        },
        { status: 400 },
      );
    }
    const cupom = applyCoupon(input.couponCode, subtotal);
    if (!cupom.ok) {
      return NextResponse.json({ ok: false, error: cupom.message, code: 'coupon_invalid' }, { status: 400 });
    }
    discount = cupom.discount;
    couponKind = cupom.kind;
    couponCode = cupom.code;
  }

  // Frete: recotado pelo CEP + subtotal + nº de peças, na MESMA fonte que a
  // tela usou (tabela promocional cadastrada + cotação do contrato). O id
  // escolhido no client precisa existir lá — senão alguém inventou frete.
  //
  // O IP vai junto (`x-cliente-ip`) pra esta cotação E pro POST /pedido logo
  // abaixo gastarem o balde do rate-limit do backend DESTA cliente — sem o
  // header, o backend via o IP de saída da Vercel e a loja inteira dividia
  // 20 hits/min (a 21ª cotação do minuto caía na tabela local, e o pedido
  // seguinte tomava 429 na hora de pagar). O backend já lê o header desde
  // 10/08; faltava alguém mandar. '0.0.0.0' é "não sei" — aí não vai, e o
  // backend cai no fallback dele.
  const ipCliente = ip !== '0.0.0.0' ? ip : undefined;
  const pecas = input.items.reduce((soma, l) => soma + l.quantity, 0);
  const quote = await resolverFrete({
    cep: input.cep,
    subtotal,
    pecas,
    quoteId: input.shippingQuoteId,
    clientIp: ipCliente,
  });
  if (!quote) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Não conseguimos confirmar o frete para este CEP. Volte uma etapa e escolha a entrega de novo.',
        code: 'shipping_invalid',
      },
      { status: 400 },
    );
  }

  // Entrega em casa exige endereço; retirada dispensa.
  if (quote.kind !== 'retirada' && !input.shippingAddress) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Falta o endereço de entrega. Volte uma etapa e confira os dados.',
        code: 'validation_error',
        field: 'endereco_ausente',
      },
      { status: 400 },
    );
  }

  // Cupom de frete zera o econômico (PAC) — mesma regra da sacola: grátis é
  // o econômico, nunca o expresso.
  let shippingPrice = quote.price;
  if (couponKind === 'shipping' && quote.kind === 'correios') shippingPrice = 0;

  /**
   * NUNCA CRIAR PEDIDO COM FRETE ACIMA DO QUE ELA LEU (17/08).
   *
   * Roda ANTES do backend: sem pedido, sem cobrança, sem PIX órfão — é o
   * ponto mais barato pra recusar. Se o frete recotado agora passou do que a
   * tela mostrou (mais de 1 centavo), devolve `shipping_changed` com a
   * cotação nova e o valor que ela tinha visto; a página volta pra Entrega
   * com a opção pré-selecionada e pede um clique de confirmação. Se ficou
   * MENOR, segue — cobrar menos que o prometido nunca foi problema.
   *
   * O flip é real e não é raro: a tela cai na tabela local quando o BFF
   * estoura 9s (tabela: PAC SP capital 14,90, sem promoção), enquanto o
   * backend termina a cotação depois do abort e aquece o cache; no clique
   * do PIX esta rota já acha o PAC real (17,90+). Antes, o QR nascia acima
   * do resumo e ninguém avisava. Sem `shippingPriceSeen` (aba antiga) não
   * há o que comparar — segue como sempre.
   */
  if (input.shippingPriceSeen != null && shippingPrice > input.shippingPriceSeen + 0.01) {
    console.warn(
      `[checkout] frete subiu entre a tela e o pedido: viu=${input.shippingPriceSeen.toFixed(2)} agora=${shippingPrice.toFixed(2)} ` +
        `(${quote.id}${quote.estimado ? ', estimado' : ''}) — pedido NÃO criado, cliente volta pra entrega`,
    );
    return NextResponse.json(
      {
        ok: false,
        code: 'shipping_changed',
        error: `O frete pro seu CEP foi atualizado: de ${formatPrice(input.shippingPriceSeen)} pra ${formatPrice(shippingPrice)}. Confira a entrega antes de pagar — nada foi cobrado.`,
        // Neste ramo o cupom de frete não zerou nada (senão shippingPrice
        // seria 0 e não passaria do que ela viu), então `quote.price` é o
        // preço que vale — vai a cotação inteira, com o carimbo `estimado`.
        quote,
        shippingPriceSeen: input.shippingPriceSeen,
      },
      { status: 400 },
    );
  }

  /**
   * Pix desconta de verdade (06/08). Aqui é a segunda barreira, igual ao
   * cupom: o backend recalcula com a MESMA regra e o total dele é o que vale.
   * A base é o subtotal já sem o cupom — dois descontos não se somam sobre o
   * valor cheio.
   */
  const descontoPix = promotionApplied
    ? 0
    : pixDiscount(subtotal - discount, input.paymentMethod);

  const total = round2(subtotal - discount - descontoPix - promotionDiscount + shippingPrice);
  if (total <= 0) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Algo não fechou no total do pedido. Revise a sacola e tente novamente.',
        code: 'validation_error',
        field: 'total',
      },
      { status: 400 },
    );
  }

  /* ── Meio de pagamento ── */

  // Boleto saiu daqui em 10/08/2026: a loja não trabalha com ele, e o schema
  // acima já rejeita o valor antes de chegar nesta altura. Antes existia uma
  // aba de Boleto no checkout que só era recusada AQUI — depois da cliente ter
  // preenchido o pedido inteiro.

  if (input.paymentMethod === 'card' && !input.cardToken) {
    // Cartão sem token = a tokenização no navegador não rodou (chave pública
    // ausente ou falha na Pagar.me). Não adianta mandar pro backend: ele não
    // tem como cobrar, e o número do cartão nunca vai trafegar por aqui.
    return NextResponse.json({
      ok: false,
      error: 'Não conseguimos validar seu cartão agora. Tente de novo ou finalize com Pix (com 5% off).',
      code: 'payment_unavailable',
    });
  }

  /* ── O pedido nasce NO BACKEND ── */

  /**
   * O TETO DO BACKEND PASSA A PROTEGER O QUE A CLIENTE LEU (17/08).
   *
   * O backend usa `input.total` só como teto ("nunca cobrar acima do
   * informado", loja-orders.service.ts) e sobrescreve com a conta dele antes
   * de cobrar — então mandar o MENOR entre o total da tela e o daqui nunca
   * muda a cobrança pra baixo do que vale, só recusa quando a conta da casa
   * passar do que ela viu. Antes o teto comparava com o total DESTE BFF, que
   * recota na mesma fonte que o backend: nunca enxergava a divergência
   * tela→cobrança. `totalSeen` forjado pra menos só desliga a compra da
   * própria pessoa; pra mais, cai no `Math.min` e vira o daqui. Só entra
   * se > 0 — zero reprovaria no `validar()` do backend.
   */
  const totalInformado =
    input.totalSeen != null && input.totalSeen > 0 ? Math.min(round2(input.totalSeen), total) : total;
  if (totalInformado < total) {
    console.warn(`[checkout] total da tela (${totalInformado}) abaixo do recalculado (${total}) — vai como teto pro backend`);
  }

  const payload: NewOrderPayload = {
    customer: input.customer,
    shippingAddress: input.shippingAddress,
    // Leva o carimbo `estimado` quando a cotação veio da tabela local ou da
    // estimativa do backend (ver frete-server.ts) — backend antigo ignora.
    shipping: quote,
    // `sku` é o que a separação usa na loja; enquanto o carrinho não carrega
    // SKU próprio, o productId é a identidade da peça (mesma escolha do
    // tracking em `itemsTracked`).
    items: input.items.map((l) => ({
      productId: l.productId,
      sku: l.productId,
      slug: l.slug,
      name: l.name,
      size: l.size,
      color: l.color,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
    })),
    couponCode,
    subtotal,
    discount: round2(discount + descontoPix + promotionDiscount),
    shippingPrice,
    total: totalInformado,
    payment: {
      method: input.paymentMethod,
      installments: input.paymentMethod === 'card' ? (input.installments ?? 1) : undefined,
      cardToken: input.cardToken,
    },
    tracking: input.tracking,
  };

  let ack;
  try {
    // Mesmo `x-cliente-ip` da cotação acima: balde do backend por cliente.
    ack = await getOrderStore().create(payload, { clientIp: ipCliente });
  } catch (err) {
    if (err instanceof OrderStoreError) {
      console.error('[checkout] backend recusou/falhou ao criar pedido:', err.message);
      return NextResponse.json(
        {
          ok: false,
          error: err.publico,
          code: err.code,
          // Marca de ONDE veio a recusa: o mesmo `validation_error` pode nascer
          // do zod daqui ou do `validar()` do backend, e a correção é em lugar
          // diferente. Sem isto o painel mostra as duas na mesma linha.
          ...(err.code === 'validation_error' ? { field: 'backend_validacao' } : {}),
          // RECUSA POR PREÇO (17/08): o backend manda qual peça e o preço
          // atual (`item`), o store parseia em `OrderStoreError.item`, e a
          // página usa pra atualizar a linha da sacola e deixar a compra a um
          // clique — em vez de "atualize a página", que não atualizava o
          // preço congelado no localStorage. Sem repassar aqui a cadeia
          // quebrava no meio: o navegador nunca recebia o `item`.
          ...(err.item ? { item: err.item } : {}),
          // SÓ O FRETE SUBIU (17/08): backend recotou maior que a tabela local
          // que a tela mostrou → `shipping_changed` + cotação nova. A página
          // já trata (atualiza a entrega, pede confirmação). Mesma resposta
          // que este BFF dá no pré-check acima — a cliente não distingue.
          ...(err.quote ? { quote: err.quote } : {}),
          // A CAUSA EXATA (22/08): `catalog_unavailable` cobre sete recusas
          // do guard (preço zerado, preço que subiu, cor/tamanho que sumiu,
          // despublicada, esgotou, estoque insuficiente) e a tela de Alertas
          // mostrava as sete na mesma linha. Vai pro `checkout_error`, não
          // pra tela — a frase da cliente continua sendo `error`.
          ...(err.motivo ? { motivo: err.motivo } : {}),
          ...(err.ref ? { ref: err.ref } : {}),
        },
        { status: err.status },
      );
    }
    console.error('[checkout] falha inesperada ao criar pedido:', err);
    return NextResponse.json(
      {
        ok: false,
        error: 'Não conseguimos concluir seu pedido agora. Fica tranquila: nada foi cobrado — tente de novo em instantes.',
        code: 'internal_error',
      },
      { status: 502 },
    );
  }

  /* ── PIX: QR Code ── */

  let pix: Order['payment']['pix'];
  if (ack.payment.pix) {
    // Dois caminhos, os dois válidos: se o backend mandou o QR, usamos o
    // dele; se mandou só o copia-e-cola, renderizamos aqui em data URI. O QR
    // e o copia-e-cola nascem do MESMO payload — o que a câmera lê é o que a
    // cliente cola no app.
    //
    // ⚠️ Hoje o backend manda a URL da imagem hospedada pela Pagar.me, não um
    // data URI. Funciona (o PixPanel usa `<img>` puro), mas faz o QR depender
    // do CDN deles carregar no navegador da cliente. Se isso virar problema, a
    // correção é uma linha: ignorar o que não começar com `data:` e gerar
    // local — o copia-e-cola, que é o caminho crítico, já vem sempre do
    // backend e não depende de rede nenhuma pra aparecer.
    let qrCode = ack.payment.pix.qrCode ?? '';
    if (!qrCode) {
      try {
        qrCode = await QRCode.toDataURL(ack.payment.pix.copyPaste, { margin: 1, width: 320 });
      } catch (err) {
        // Sem QR a tela ainda funciona pelo copia-e-cola — degradar é melhor
        // que derrubar um pedido que JÁ EXISTE e já tem cobrança criada.
        console.error('[checkout] falha ao gerar QR do PIX (segue com copia-e-cola):', err);
      }
    }
    pix = { qrCode, copyPaste: ack.payment.pix.copyPaste, expiresAt: ack.payment.pix.expiresAt };
  } else if (ack.payment.method === 'pix') {
    // Pedido PIX sem cobrança é pedido que a cliente não tem como pagar.
    console.error(`[checkout] backend criou pedido PIX ${ack.id} sem dados de cobrança`);
    return NextResponse.json(
      {
        ok: false,
        error: 'Não conseguimos gerar seu Pix agora. Tente novamente em instantes.',
        code: 'payment_unavailable',
      },
      { status: 502 },
    );
  }

  /**
   * O `Order` devolvido pra tela é a costura de duas fontes: o que o BACKEND
   * decidiu (id, número, status, total, cobrança) + o que este BFF já tem em
   * mãos (cliente, itens, endereço, frete). O backend não repete o que a
   * requisição acabou de mandar, e não faz sentido pedir de volta.
   */
  const totalBackend = ack.total > 0 ? ack.total : total;
  if (ack.total > 0 && Math.abs(ack.total - total) > 0.01) {
    // Divergência não derruba a venda (o dono do pedido é o backend), mas
    // precisa aparecer: é sintoma de tabela de cupom/frete fora de sincronia.
    console.warn(`[checkout] total divergente — BFF ${total} vs backend ${ack.total} no pedido ${ack.id}`);
  }

  /**
   * O RESUMO SEGUE O TOTAL. O backend reprecifica o carrinho contra o catálogo
   * (peça que mudou de preço, cupom recalculado, desconto do Pix); quando ele
   * manda a conta discriminada, é ELA que a tela mostra. Misturar o subtotal
   * daqui com o total de lá dava um resumo que não fecha — e resumo que não
   * fecha na hora de pagar é ligação no WhatsApp.
   */
  const descontoExibido = ack.discount ?? discount + descontoPix;

  const order: Order = {
    id: ack.id,
    number: ack.number,
    status: ack.status,
    createdAt: new Date().toISOString(),
    customer: input.customer,
    shippingAddress: input.shippingAddress,
    shipping: quote,
    // A imagem virou opcional/tolerante na validação; pro tipo da resposta
    // (que a tela de confirmação desenha) garante o mesmo shape de sempre.
    items: input.items.map((l) => ({
      ...l,
      image: { src: l.image?.src ?? '', alt: l.image?.alt ?? l.name, ...(l.image?.aspect ? { aspect: l.image.aspect as never } : {}) },
    })),
    subtotal: ack.subtotal ?? subtotal,
    discount: descontoExibido,
    couponCode: ack.couponCode ?? couponCode,
    shippingPrice: ack.shippingPrice ?? shippingPrice,
    total: totalBackend,
    payment: {
      method: ack.payment.method,
      installments: ack.payment.installments ?? payload.payment.installments,
      pix,
    },
    // `tracking` NÃO volta pra fora: o client já tem os próprios sinais, e
    // devolver economiza um vazamento bobo em log de rede.
  };

  return NextResponse.json({ ok: true, order }, { status: 201 });
}
