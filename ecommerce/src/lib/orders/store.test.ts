import { describe, expect, it } from 'vitest';
import { checkoutErrorCode } from './checkout-error-code';

describe('checkoutErrorCode', () => {
  it.each([
    'card_declined',
    'catalog_unavailable',
    'coupon_invalid',
    'shipping_invalid',
    'validation_error',
    'rate_limited',
    'payment_unavailable',
    'internal_error',
  ])('aceita o código seguro %s', (code) => {
    expect(checkoutErrorCode(code)).toBe(code);
  });

  it('transforma resposta antiga ou livre no código legado', () => {
    expect(checkoutErrorCode(undefined)).toBe('api_rejected');
    expect(checkoutErrorCode('do not honor: cartão 1234')).toBe('api_rejected');
  });
});
