import type { CheckoutContact, CustomerIdentity } from '@/types/checkout';
import type { ShippingSelection } from '@/components/checkout/ShippingStep';
import type { PaymentSelection } from '@/components/checkout/PaymentStep';

const KEY = 'lurds-checkout-draft-v1';

export interface CheckoutDraft {
  contact: CheckoutContact | null;
  customer: CustomerIdentity | null;
  shipping: ShippingSelection | null;
  /** Só PIX pode voltar concluído; token e dados de cartão nunca são persistidos. */
  payment: Pick<PaymentSelection, 'method' | 'installments'> | null;
}

function contactFrom(value: unknown): CheckoutContact | null {
  if (!isObject(value) || typeof value.name !== 'string' || typeof value.phone !== 'string') return null;
  return { name: value.name, phone: value.phone, recoveryConsent: value.recoveryConsent === true };
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
    // Migra silenciosamente rascunhos v1, que guardavam a identidade completa.
    const contact = contactFrom(parsed.contact) ?? (customer ? { name: customer.name, phone: customer.phone, recoveryConsent: false } : null);
    const shipping = contact ? shippingFrom(parsed.shipping) : null;
    const rawPayment = isObject(parsed.payment) ? parsed.payment : null;
    const payment = rawPayment?.method === 'pix' ? { method: 'pix' as const } : null;
    return { contact, customer, shipping, payment };
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
    storage.setItem(KEY, JSON.stringify({ contact: draft.contact, customer: draft.customer, shipping: draft.shipping, payment }));
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
