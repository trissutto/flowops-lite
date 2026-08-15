import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { campoDoZod } from './campo-reprovado';

/** Mesmo formato do corpo de `POST /api/checkout`, no mínimo necessário. */
const schema = z.object({
  customer: z.object({ cpf: z.string().regex(/^\d{11}$/), name: z.string().min(3) }),
  shippingAddress: z
    .object({ number: z.string().min(1).max(20), street: z.string().max(160) })
    .optional(),
  shippingQuoteId: z.string().min(1),
  items: z.array(z.object({ image: z.object({ src: z.string().min(1) }), size: z.string().max(10) })),
});

function campoDe(body: unknown): string {
  const r = schema.safeParse(body);
  if (r.success) throw new Error('esperava reprovação');
  return campoDoZod(r.error);
}

const base = {
  customer: { cpf: '12345678901', name: 'Maria Silva' },
  shippingAddress: { number: '123', street: 'Rua das Flores' },
  shippingQuoteId: 'pac',
  items: [{ image: { src: 'https://x/y.jpg' }, size: '48' }],
};

describe('campoDoZod', () => {
  it('tira o container do caminho — o painel rotula `cpf`, não `customer.cpf`', () => {
    expect(campoDe({ ...base, customer: { ...base.customer, cpf: '123.456.789-01' } })).toBe('cpf');
  });

  it('aponta o campo do endereço que estourou o limite do servidor', () => {
    const endereco = { ...base.shippingAddress, number: '123 - fundos, perto do mercado central' };
    expect(campoDe({ ...base, shippingAddress: endereco })).toBe('number');
  });

  it('some com o índice do item: a 4ª peça e a 1ª caem na MESMA linha do painel', () => {
    const semFoto = { image: { src: '' }, size: '48' };
    const ok = { image: { src: 'https://x/y.jpg' }, size: '48' };
    expect(campoDe({ ...base, items: [semFoto] })).toBe('item_image_src');
    expect(campoDe({ ...base, items: [ok, ok, ok, semFoto] })).toBe('item_image_src');
  });

  it('mantém o nome inteiro quando o campo é de primeiro nível', () => {
    expect(campoDe({ ...base, shippingQuoteId: '' })).toBe('shippingQuoteId');
  });

  it('não quebra quando o erro não tem caminho (corpo do tipo errado)', () => {
    expect(campoDe('isto não é um objeto')).toBe('payload');
  });
});
