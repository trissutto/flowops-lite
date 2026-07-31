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

export type PaymentMethod = 'pix' | 'card' | 'boleto';

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
  | 'awaiting_payment' // criado, aguardando PIX/boleto/cartão
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
    attribution?: Record<string, string | undefined>;
  };
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
export interface CreateOrderResult {
  ok: boolean;
  order?: Order;
  /** Mensagem elegante pra UI quando ok=false. */
  error?: string;
}

/** GET /api/checkout/:id/status — resposta (poll do PIX). */
export interface OrderStatusResult {
  ok: boolean;
  status?: OrderStatus;
  paidAt?: string;
}
