import { describe, expect, it } from 'vitest';
import { cartStockBlocksCheckout, currentCartStockNotice } from './cart-stock';

describe('estoque conhecido na sacola', () => {
  it('bloqueia peça esgotada', () => {
    expect(cartStockBlocksCheckout(1, { tone: 'danger', text: 'Esgotou', bloqueia: true, maxQuantity: 0 }))
      .toBe(true);
  });

  it('libera quando a quantidade cai para o estoque disponível', () => {
    const notice = { tone: 'danger' as const, text: 'Restam 2', bloqueia: true, maxQuantity: 2 };
    expect(cartStockBlocksCheckout(3, notice)).toBe(true);
    expect(cartStockBlocksCheckout(2, notice)).toBe(false);
    expect(currentCartStockNotice(2, notice)?.tone).toBe('gold');
  });

  it('não bloqueia quando a revalidação não retornou aviso', () => {
    expect(cartStockBlocksCheckout(10)).toBe(false);
  });
});
