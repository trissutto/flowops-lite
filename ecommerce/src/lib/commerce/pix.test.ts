import { describe, expect, it } from 'vitest';
import { PIX_DESCONTO_PCT, pixDiscount, pixTotal } from './pix';

describe('preço do PIX', () => {
  it('não aplica desconto apenas por não haver método escolhido', () => {
    expect(pixDiscount(200, null)).toBe(0);
  });

  it('calcula a prévia final antes da confirmação explícita', () => {
    const base = 200;
    const frete = 20;
    const esperado = base - (base * PIX_DESCONTO_PCT) / 100 + frete;

    expect(pixTotal(base, frete)).toBe(esperado);
  });

  it('não deixa base ou frete negativos reduzirem o total', () => {
    expect(pixTotal(-10, -5)).toBe(0);
  });
});
