import { describe, expect, it } from 'vitest';
import { clearCheckoutDraft, readCheckoutDraft, writeCheckoutDraft, type CheckoutDraft } from './checkout-draft';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    dump: () => Array.from(data.values()).join(''),
  };
}

const base: CheckoutDraft = {
  contact: { name: 'Maria', phone: '11999999999', recoveryConsent: false },
  customer: { name: 'Maria Silva', email: 'maria@example.com', cpf: '12345678901', phone: '11999999999' },
  shipping: null,
  payment: { method: 'pix' },
};

describe('rascunho do checkout', () => {
  it('restaura identificação e PIX na mesma aba', () => {
    const storage = memoryStorage();
    writeCheckoutDraft(storage, base);
    expect(readCheckoutDraft(storage)).toEqual(base);
  });

  it('nunca persiste token ou conclusão de cartão', () => {
    const storage = memoryStorage();
    const paymentWithToken = { method: 'card' as const, installments: 3, cardToken: 'token-secreto' };
    writeCheckoutDraft(storage, { ...base, payment: paymentWithToken });
    expect(storage.dump()).not.toContain('token-secreto');
    expect(readCheckoutDraft(storage)?.payment).toBeNull();
  });

  it('descarta conteúdo inválido e permite limpeza', () => {
    const storage = memoryStorage();
    storage.setItem('lurds-checkout-draft-v1', '{quebrado');
    expect(readCheckoutDraft(storage)).toBeNull();
    clearCheckoutDraft(storage);
    expect(storage.dump()).toBe('');
  });
});
