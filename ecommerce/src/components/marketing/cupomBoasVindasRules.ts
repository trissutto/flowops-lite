const STORAGE_KEY = 'lurds:cupom-boas-vindas';
const DAY = 24 * 60 * 60 * 1000;
const CLOSED_WAIT = 60 * DAY;
const REGISTERED_WAIT = 365 * DAY;

/**
 * 40 SEGUNDOS (dono, 17/08 — era 15).
 *
 * Aos 15s o popup pegava a cliente ainda decidindo se ficava: ela nem tinha
 * visto uma peça direito e já tinha um formulário na frente. Aos 40s quem
 * ainda está no site já demonstrou interesse — o cupom vira presente, não
 * pedágio.
 *
 * FONTE ÚNICA. Havia uma cópia deste valor dentro de CupomBoasVindas.tsx
 * (SEGUNDOS_ATE_APARECER), então mudar aqui não mudava lá. Agora os dois
 * componentes leem daqui.
 */
export const COUPON_DELAY_MS = 40_000;
export const BLOCKED_COUPON_ROUTES = ['/carrinho', '/checkout', '/conta', '/pedido', '/trocas'];

type CouponState = { estado: 'fechado' | 'cadastrado'; em: number };

export function minimumCouponScroll(viewportHeight: number): number {
  return Math.max(400, viewportHeight * 0.5);
}

export function hasResolvedCoupon(storage: Pick<Storage, 'getItem'>, now = Date.now()): boolean {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const { estado, em } = JSON.parse(raw) as CouponState;
    const wait = estado === 'cadastrado' ? REGISTERED_WAIT : CLOSED_WAIT;
    return now - em < wait;
  } catch {
    return true;
  }
}

export function rememberCoupon(
  storage: Pick<Storage, 'setItem'>,
  estado: CouponState['estado'],
  now = Date.now(),
) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ estado, em: now } satisfies CouponState));
  } catch {
    // A visita atual segue funcional mesmo quando o navegador bloqueia storage.
  }
}
