import type { CheckoutErrorCode } from '@/types/checkout';

const BACKEND_ERROR_CODES = new Set<CheckoutErrorCode>([
  'card_declined',
  'catalog_unavailable',
  'coupon_invalid',
  'shipping_invalid',
  'validation_error',
  'rate_limited',
  'payment_unavailable',
  'internal_error',
]);

/** Aceita somente a taxonomia fechada; backend antigo cai no código legado. */
export function checkoutErrorCode(value: unknown): CheckoutErrorCode {
  return typeof value === 'string' && BACKEND_ERROR_CODES.has(value as CheckoutErrorCode)
    ? (value as CheckoutErrorCode)
    : 'api_rejected';
}
