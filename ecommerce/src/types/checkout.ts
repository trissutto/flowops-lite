/**
 * CONTRATO DO CHECKOUT — Sprints 009/010, revisado na 011.
 *
 * Na 011 o pedido passou a nascer no backend FlowOps (Postgres). Estes tipos
 * continuam sendo o contrato ENTRE O NAVEGADOR E O BFF (`/api/checkout/*`); o
 * contrato do BFF com o backend mora em `src/lib/orders/store.ts`.
 *
 * Tipos compartilhados entre carrinho, checkout, APIs de pedido e pagamento.
 * Como em `types/index.ts`: preços SEMPRE em reais (number), nunca centavos.
 *
 * Este arquivo é a fronteira entre o client (páginas) e o server (routes):
 * os DTOs daqui são o que trafega — mudar um campo aqui é mudar a API.
 */

import type { CartLine } from './index';

/* ------------------------------------------------------------------ ENDEREÇO */

export interface Address {
  cep: string;
  street: string;
  number: string;
  complement?: string;
  neighborhood: string;
  city: string;
  uf: string;
}

/* ---------------------------------------------------------------- IDENTIDADE */

export interface CustomerIdentity {
  name: string;
  email: string;
  /** Só dígitos. */
  cpf: string;
  /** Só dígitos, com DDD. */
  phone: string;
}

/** Dados mínimos capturados antes do frete para permitir retomar a compra. */
export type CheckoutContact = Pick<CustomerIdentity, 'name' | 'phone'> & {
  /** Autorização específica para lembrete de checkout/PIX por WhatsApp. */
  recoveryConsent: boolean;
};

/* -------------------------------------------------------------------- FRETE */

export type ShippingKind = 'correios' | 'transportadora' | 'expressa' | 'retirada';

export interface ShippingQuote {
  id: string;
  kind: ShippingKind;
  label: string;
  /** 0 = grátis (exibir "Grátis", nunca "R$ 0,00"). */
  price: number;
  /** Prazo em dias úteis; retirada usa `readyInHours`. */
  etaDays?: { min: number; max: number };
  readyInHours?: number;
  /** Slug da loja quando kind = retirada. */
  storeSlug?: string;
  storeLabel?: string;
  /**
   * Preço de tabela promocional (SP SEDEX R$ 9,99, RJ/MG/PR/SC/RS PAC
   * R$ 19,99), não cotação dos Correios. Quem decide é o backend, que
   * conhece a campanha vigente — o site só carrega o carimbo pra ordenar.
   */
  promocional?: boolean;
  /** Distância da cliente até a loja, em km. Só em kind = retirada. */
  distanciaKm?: number;
}

/* -------------------------------------------------------------------- CUPOM */

export interface CouponResult {
  ok: boolean;
  code: string;
  /** Desconto em reais já calculado sobre o subtotal informado. */
  discount: number;
  /** Mensagem pra UI — elegante, nunca técnica. */
  message: string;
  kind?: 'percent' | 'fixed' | 'shipping';
}

/* ---------------------------------------------------------------- PAGAMENTO */

/**
 * A loja não trabalha com boleto (confirmado pelo dono em 10/08/2026). O tipo
 * existia com `'boleto'` e o checkout tinha uma aba inteira e convincente pra
 * ele — enquanto a rota `/api/checkout` recusava boleto no ÚLTIMO clique,
 * depois da cliente já ter preenchido identificação, entrega e revisão.
 * Tirar do TIPO (em vez de esconder a aba) é o que impede a aba de voltar por
 * engano: qualquer código que mencione boleto agora não compila.
 */
export type PaymentMethod = 'pix' | 'card';

export interface CardInput {
  /** NUNCA logar nem persistir — vai direto pro gateway tokenizar. */
  number: string;
  holder: string;
  expiry: string; // MM/AA
  cvv: string;
  installments: number;
}

/* ------------------------------------------------------------------- PEDIDO */

export type OrderStatus =
  | 'awaiting_payment' // criado, aguardando PIX/cartão
  | 'paid'             // pagamento confirmado — ÚNICO estado que dispara purchase
  | 'cancelled'
  | 'expired';

export interface Order {
  /** UUID do Order no Postgres do FlowOps — quem manda é o backend (sprint 011). */
  id: string;
  /** Número curto exibido pra cliente, gerado pelo backend. */
  number: string;
  status: OrderStatus;
  createdAt: string;
  paidAt?: string;
  customer: CustomerIdentity;
  shippingAddress?: Address;
  shipping: ShippingQuote;
  items: CartLine[];
  subtotal: number;
  discount: number;
  couponCode?: string;
  shippingPrice: number;
  total: number;
  payment: {
    method: PaymentMethod;
    /** Dados do PIX quando method = pix. */
    pix?: { qrCode: string; copyPaste: string; expiresAt: string };
    installments?: number;
  };
  /** Sinais de tracking capturados no checkout — ver docs/purchase.md. */
  tracking?: {
    anonymous_id?: string;
    session_id?: string;
    fbp?: string;
    fbc?: string;
    /**
     * Cookies do gtag — o `fbp`/`fbc` do Google. Viajam com o pedido porque o
     * `purchase` é emitido no servidor, quando o pagamento confirma: naquele
     * momento não há navegador nenhum pra ler cookie.
     */
    ga4_client_id?: string;
    ga4_session_id?: string;
    attribution?: Record<string, string | undefined>;
    recovery_consent?: boolean;
  };
  /**
   * AS CAIXAS DO PEDIDO, com o rastreio que o Flow já mantém em cache
   * (`rastreio_objetos`, atualizado de 30 em 30 min pelo `RastreioSyncCron`).
   *
   * Vazio/ausente = ainda não postado. Mais de um item = pedido dividido: as
   * peças saíram de lojas diferentes e chegam em caixas diferentes — o caso
   * que fazia a cliente receber dois avisos e achar que o pedido estava errado.
   */
  volumes?: VolumeDoPedido[];
}

export interface VolumeDoPedido {
  codigo: string;
  carrier: string | null;
  /** Loja que despachou esta caixa — só no pedido dividido. */
  loja: string | null;
  /** "Caixa 1 de 2". */
  posicao: number;
  total: number;
  /** Descrição do último evento ("Objeto saiu para entrega ao destinatário"). */
  status: string | null;
  /** "CAMPINAS/SP". */
  local: string | null;
  eventoEm: string | null;
  previsaoEm: string | null;
  entregue: boolean;
  entregueEm: string | null;
  /** Quando o cron conferiu pela última vez. */
  atualizadoEm: string | null;
  url: string;
}

/* --------------------------------------------------------------------- DTOs */

/** POST /api/checkout — corpo. */
export interface CreateOrderInput {
  customer: CustomerIdentity;
  shippingAddress?: Address;
  shippingQuoteId: string;
  cep: string;
  items: CartLine[];
  couponCode?: string;
  paymentMethod: PaymentMethod;
  installments?: number;
  /**
   * Token do cartão gerado NO NAVEGADOR pelo SDK do gateway. É o único dado de
   * cartão que existe fora do navegador: número, CVV e validade nunca chegam a
   * servidor nenhum — nem o nosso BFF, nem o backend FlowOps (PCI-DSS).
   */
  cardToken?: string;
  tracking?: Order['tracking'];
}

/** POST /api/checkout — resposta. */
export type CheckoutErrorCode =
  | 'card_declined'
  | 'catalog_unavailable'
  | 'coupon_invalid'
  | 'shipping_invalid'
  /** Só o frete subiu entre a tela e o pedido (BFF ou backend): resposta traz `quote` nova. */
  | 'shipping_changed'
  | 'validation_error'
  | 'rate_limited'
  | 'payment_unavailable'
  | 'internal_error'
  | 'api_rejected'
  | 'network_error'
  | 'invalid_response';

export interface CreateOrderResult {
  ok: boolean;
  order?: Order;
  /** Mensagem elegante pra UI quando ok=false. */
  error?: string;
  /** Causa fechada e sem PII, usada apenas no diagnóstico do funil. */
  code?: CheckoutErrorCode;
  /**
   * QUAL campo derrubou o pedido — só o NOME do campo, nunca o valor.
   *
   * Sem isto, `validation_error` chegava na retaguarda como "Dados do pedido
   * incompletos" e ninguém conseguia dizer o que a cliente precisava corrigir:
   * ela tentava 6 vezes, falhava 6 vezes pelo mesmo motivo e ia embora. Com o
   * nome do campo a tela aponta a seção certa e o painel do funil agrupa por
   * causa (a query de diagnóstico já lê `dados->>'field'`).
   */
  field?: string;
  /** Só em `catalog_unavailable` por preço: qual peça subiu e o preço atual (17/08). */
  item?: { productId: string; size: string; color?: string; precoAtual: number };
  /** Só em `shipping_changed`: a cotação que vale agora (17/08). */
  quote?: { id: string; label: string; price: number; etaDays: { min: number; max: number } | null };
  /**
   * A CAUSA EXATA da recusa e a REF (22/08) — diagnóstico do funil, não texto
   * de tela. `code: 'catalog_unavailable'` cobre sete recusas do guard, e a
   * tela de Alertas mostrava as sete como "Produto, estoque ou preço
   * alterado": ninguém conseguia dizer se era preço, cor, tamanho,
   * despublicação ou estoque preso em reserva velha.
   */
  motivo?: string;
  ref?: string;
}

/** GET /api/checkout/:id/status — resposta (poll do PIX). */
export interface OrderStatusResult {
  ok: boolean;
  status?: OrderStatus;
  paidAt?: string;
}
