/**
 * PAYLOADS DA PAGAR.ME — módulo PURO, sem `server-only` de propósito: são só
 * funções de montagem (Order → JSON da API v5), e é exatamente o que os testes
 * precisam importar sem arrastar a cadeia de confirmação/tracking junto.
 *
 * Quem fala com a rede é `pagarme.ts` (esse sim, server-only).
 */

import type { Order } from '@/types/checkout';

export const PIX_EXPIRES_SECONDS = 30 * 60;
/** Máx 13 chars alfanuméricos — é o nome que aparece na fatura do cartão. */
export const STATEMENT_DESCRIPTOR = 'LURDSPLUS';

export function buildOrderPayload(order: Order): Record<string, unknown> {
  const phone = order.customer.phone; // já validado: 10-11 dígitos com DDD
  return {
    code: order.number,
    closed: true,
    customer: {
      name: order.customer.name,
      email: order.customer.email,
      // CPF só dígitos — a rota já validou; reforça aqui porque a Pagar.me
      // recusa o lote inteiro com pontuação.
      document: order.customer.cpf.replace(/\D/g, ''),
      document_type: 'CPF',
      type: 'individual',
      phones: {
        mobile_phone: {
          country_code: '55',
          area_code: phone.slice(0, 2),
          number: phone.slice(2),
        },
      },
    },
    items: [
      {
        // Valor em CENTAVOS, inteiro — a unidade da API v5. Errar isso cobra
        // 100× a mais ou a menos (a lição do vendaUn está na memória da casa).
        // Item ÚNICO = total exato: distribuir cupom/frete linha a linha
        // criaria diferença de arredondamento entre o cobrado e o exibido.
        amount: Math.round(order.total * 100),
        description: `Pedido ${order.number} — Lurd's Plus Size`,
        quantity: 1,
        code: order.number,
      },
    ],
    metadata: {
      ecommerce_order_id: order.id,
      order_number: order.number,
      // Resumo das peças pra conciliação — o valor fiscal/contábil vive no
      // nosso pedido, não aqui.
      itens: order.items.map((l) => `${l.quantity}x ${l.name} (${l.size})`).join(' · ').slice(0, 255),
    },
  };
}

export function buildPixPayment(): Record<string, unknown> {
  return { payment_method: 'pix', pix: { expires_in: PIX_EXPIRES_SECONDS } };
}

export function buildCardPayment(order: Order, cardToken: string, installments: number): Record<string, unknown> {
  const credit_card: Record<string, unknown> = {
    installments,
    statement_descriptor: STATEMENT_DESCRIPTOR,
    card_token: cardToken,
  };
  // Endereço de cobrança = o de entrega (é o comportamento do Woo atual — a
  // cliente não digita nada duas vezes). Retirada em loja não tem endereço e
  // a API aceita a ausência quando há token.
  if (order.shippingAddress) {
    credit_card.card = {
      billing_address: {
        line_1: `${order.shippingAddress.number}, ${order.shippingAddress.street}, ${order.shippingAddress.neighborhood}`,
        zip_code: order.shippingAddress.cep,
        city: order.shippingAddress.city,
        state: order.shippingAddress.uf,
        country: 'BR',
      },
    };
  }
  return { payment_method: 'credit_card', credit_card };
}
