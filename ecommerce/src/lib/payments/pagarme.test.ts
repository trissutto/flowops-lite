/**
 * Testes do payload Pagar.me — os pontos que COBRAM ERRADO se quebrarem:
 * centavos (100× a lição do vendaUn), CPF com pontuação, metadata que liga a
 * cobrança de volta ao nosso pedido (sem ela o webhook não confirma nada).
 */

import { describe, expect, it } from 'vitest';
import { buildCardPayment, buildOrderPayload, buildPixPayment } from './pagarme-payload';
import type { Order } from '@/types/checkout';

const PEDIDO: Order = {
  id: 'uuid-pedido-1',
  number: 'LP-000042-K4',
  status: 'awaiting_payment',
  createdAt: '2026-07-31T12:00:00.000Z',
  customer: { name: 'Maria da Silva', email: 'maria@exemplo.com', cpf: '52998224725', phone: '13991234567' },
  shippingAddress: {
    cep: '11740000',
    street: 'Rua das Flores',
    number: '123',
    neighborhood: 'Centro',
    city: 'Itanhaém',
    uf: 'SP',
  },
  shipping: { id: 'correios-pac', kind: 'correios', label: 'Correios PAC', price: 14.9, etaDays: { min: 2, max: 4 } },
  items: [
    {
      id: 'l1',
      productId: '9876',
      slug: 'vestido-midi',
      name: 'Vestido Midi Linho',
      image: { src: '/x.jpg', alt: 'Vestido' },
      size: '48',
      quantity: 2,
      unitPrice: 189.9,
    },
  ],
  subtotal: 379.8,
  discount: 0,
  shippingPrice: 14.9,
  total: 394.7,
  payment: { method: 'pix' },
};

describe('buildOrderPayload', () => {
  it('converte o total pra CENTAVOS inteiros (item único = centavo exato)', () => {
    const payload = buildOrderPayload(PEDIDO);
    const items = payload.items as Array<{ amount: number; quantity: number }>;
    expect(items).toHaveLength(1);
    expect(items[0].amount).toBe(39470);
    expect(Number.isInteger(items[0].amount)).toBe(true);
    expect(items[0].quantity).toBe(1);
  });

  it('não perde centavo em total quebrado (o clássico 0.1+0.2)', () => {
    const payload = buildOrderPayload({ ...PEDIDO, total: 299.3 });
    expect((payload.items as Array<{ amount: number }>)[0].amount).toBe(29930);
  });

  it('manda CPF só dígitos mesmo se vier pontuado', () => {
    const payload = buildOrderPayload({
      ...PEDIDO,
      customer: { ...PEDIDO.customer, cpf: '529.982.247-25' },
    });
    expect((payload.customer as { document: string }).document).toBe('52998224725');
  });

  it('quebra o telefone em DDD + número', () => {
    const phones = (buildOrderPayload(PEDIDO).customer as { phones: { mobile_phone: { area_code: string; number: string; country_code: string } } }).phones;
    expect(phones.mobile_phone.country_code).toBe('55');
    expect(phones.mobile_phone.area_code).toBe('13');
    expect(phones.mobile_phone.number).toBe('991234567');
  });

  it('planta o id do NOSSO pedido no metadata — é o que o webhook usa', () => {
    const meta = buildOrderPayload(PEDIDO).metadata as { ecommerce_order_id: string; order_number: string };
    expect(meta.ecommerce_order_id).toBe('uuid-pedido-1');
    expect(meta.order_number).toBe('LP-000042-K4');
  });
});

describe('buildPixPayment', () => {
  it('PIX dinâmico com expiração', () => {
    const p = buildPixPayment() as { payment_method: string; pix: { expires_in: number } };
    expect(p.payment_method).toBe('pix');
    expect(p.pix.expires_in).toBe(1800);
  });
});

describe('buildCardPayment', () => {
  it('token + parcelas + descritor de fatura (nunca o número do cartão)', () => {
    const p = buildCardPayment(PEDIDO, 'token_abc123', 6) as {
      payment_method: string;
      credit_card: { card_token: string; installments: number; statement_descriptor: string };
    };
    expect(p.payment_method).toBe('credit_card');
    expect(p.credit_card.card_token).toBe('token_abc123');
    expect(p.credit_card.installments).toBe(6);
    // Máx 13 chars — é o que aparece na fatura da cliente.
    expect(p.credit_card.statement_descriptor.length).toBeLessThanOrEqual(13);
    expect(JSON.stringify(p)).not.toMatch(/\d{13,19}/); // nenhum número de cartão
  });

  it('endereço de cobrança = o de entrega (a cliente não digita duas vezes)', () => {
    const p = buildCardPayment(PEDIDO, 'token_abc123', 1) as {
      credit_card: { card?: { billing_address: { city: string; zip_code: string } } };
    };
    expect(p.credit_card.card?.billing_address.city).toBe('Itanhaém');
    expect(p.credit_card.card?.billing_address.zip_code).toBe('11740000');
  });

  it('retirada em loja (sem endereço) não inventa cobrança', () => {
    const semEndereco = { ...PEDIDO, shippingAddress: undefined };
    const p = buildCardPayment(semEndereco, 'token_abc123', 1) as { credit_card: { card?: unknown } };
    expect(p.credit_card.card).toBeUndefined();
  });
});
