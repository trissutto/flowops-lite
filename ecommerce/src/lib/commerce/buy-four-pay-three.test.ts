import { describe, expect, it } from 'vitest';
import { previewBuyFourPayThree } from './buy-four-pay-three';

describe('previewBuyFourPayThree', () => {
  it('mostra progresso contando produtos, não unidades', () => {
    const result = previewBuyFourPayThree([
      { productId: 'A', quantity: 3, unitPrice: 100 },
      { productId: 'B', quantity: 1, unitPrice: 80 },
    ]);
    expect(result).toMatchObject({ applied: false, distinctProducts: 2, productsToGo: 2 });
  });

  it('desconta uma unidade do produto mais barato', () => {
    const result = previewBuyFourPayThree([
      { productId: 'A', quantity: 1, unitPrice: 100 },
      { productId: 'B', quantity: 1, unitPrice: 70 },
      { productId: 'C', quantity: 1, unitPrice: 80 },
      { productId: 'D', quantity: 1, unitPrice: 90 },
    ]);
    expect(result.discountValue).toBe(70);
    expect(result.finalSubtotal).toBe(270);
    expect(result.freeItem?.productId).toBe('B');
  });
});
