import type { CustomerIdentity } from '@/types/checkout';
import type { ShippingSelection } from '@/components/checkout/ShippingStep';
import type { PaymentSelection } from '@/components/checkout/PaymentStep';

const KEY = 'lurds-checkout-draft-v1';

export interface CheckoutDraft {
  customer: CustomerIdentity | null;
  shipping: ShippingSelection | null;
  /** Só PIX pode voltar concluído; token e dados de cartão nunca são persistidos. */
  payment: Pick<PaymentSelection, 'method' | 'installments'> | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function customerFrom(value: unknown): CustomerIdentity | null {
  if (!isObject(value)) return null;
  const fields = ['name', 'email', 'cpf', 'phone'] as const;
  if (!fields.every((field) => typeof value[field] === 'string')) return null;
  return value as unknown as CustomerIdentity;
}

function shippingFrom(value: unknown): ShippingSelection | null {
  if (!isObject(value) || typeof value.cep !== 'string' || !isObject(value.quote)) return null;
  if (typeof value.quote.id !== 'string' || typeof value.quote.kind !== 'string') return null;
  return value as unknown as ShippingSelection;
}

export function readCheckoutDraft(storage: Pick<Storage, 'getItem'>): CheckoutDraft | null {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return null;
    const customer = customerFrom(parsed.customer);
    const shipping = customer ? shippingFrom(parsed.shipping) : null;
    const rawPayment = isObject(parsed.payment) ? parsed.payment : null;
    const payment = rawPayment?.method === 'pix' ? { method: 'pix' as const } : null;
    return { customer, shipping, payment };
  } catch {
    return null;
  }
}

export function writeCheckoutDraft(
  storage: Pick<Storage, 'setItem'>,
  draft: CheckoutDraft,
): void {
  try {
    const payment = draft.payment?.method === 'pix' ? { method: 'pix' as const } : null;
    storage.setItem(KEY, JSON.stringify({ customer: draft.customer, shipping: draft.shipping, payment }));
  } catch {
    // Rascunho é conveniência: storage bloqueado nunca pode quebrar o checkout.
  }
}

export function clearCheckoutDraft(storage: Pick<Storage, 'removeItem'>): void {
  try {
    storage.removeItem(KEY);
  } catch {
    // Mesmo contrato fail-open da escrita.
  }
}
