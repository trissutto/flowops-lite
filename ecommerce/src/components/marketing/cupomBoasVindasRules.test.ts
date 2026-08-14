import { describe, expect, it, vi } from 'vitest';
import {
  BLOCKED_COUPON_ROUTES,
  hasResolvedCoupon,
  minimumCouponScroll,
  rememberCoupon,
} from './cupomBoasVindasRules';

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
  };
}

describe('cupomBoasVindasRules', () => {
  it('exige pelo menos 400 px de rolagem em viewports pequenas', () => {
    expect(minimumCouponScroll(0)).toBe(400);
    expect(minimumCouponScroll(600)).toBe(400);
    expect(minimumCouponScroll(1000)).toBe(500);
  });

  it('bloqueia as rotas críticas da compra e da conta', () => {
    expect(BLOCKED_COUPON_ROUTES).toEqual(
      expect.arrayContaining(['/carrinho', '/checkout', '/conta', '/pedido', '/trocas']),
    );
  });

  it('mantém recusa por 60 dias e libera depois do prazo', () => {
    const storage = memoryStorage();
    const now = Date.UTC(2026, 7, 14);
    rememberCoupon(storage, 'fechado', now);

    expect(hasResolvedCoupon(storage, now + 59 * 24 * 60 * 60 * 1000)).toBe(true);
    expect(hasResolvedCoupon(storage, now + 61 * 24 * 60 * 60 * 1000)).toBe(false);
  });

  it('mantém cadastro por um ano', () => {
    const storage = memoryStorage();
    const now = Date.UTC(2026, 7, 14);
    rememberCoupon(storage, 'cadastrado', now);

    expect(hasResolvedCoupon(storage, now + 364 * 24 * 60 * 60 * 1000)).toBe(true);
    expect(hasResolvedCoupon(storage, now + 366 * 24 * 60 * 60 * 1000)).toBe(false);
  });

  it('falha fechado quando o storage está bloqueado ou corrompido', () => {
    expect(hasResolvedCoupon({ getItem: () => '{inválido' })).toBe(true);
    expect(hasResolvedCoupon({ getItem: () => { throw new Error('bloqueado'); } })).toBe(true);
  });
});
