'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';

/**
 * CartContext — estado global do carrinho persistido em localStorage.
 *
 * Cada item:
 *   - productId: ID do produto WC
 *   - variationId: ID da variação (se variable) ou null (simple)
 *   - quantity, name, image, price, attributes (cor/tamanho selecionados)
 *
 * Persistência: localStorage. Sincroniza entre abas via storage event.
 */

export type CartItem = {
  productId: number;
  variationId: number | null;
  slug: string;
  name: string;
  image: string | null;
  price: number;
  regularPrice: number;
  quantity: number;
  attributes: Record<string, string>; // { Cor: "Vermelho", Tamanho: "G" }
};

type CartContextType = {
  items: CartItem[];
  itemCount: number;
  subtotal: number;
  addItem: (item: Omit<CartItem, 'quantity'> & { quantity?: number }) => void;
  updateQuantity: (productId: number, variationId: number | null, qty: number) => void;
  removeItem: (productId: number, variationId: number | null) => void;
  clear: () => void;
  /** Timestamp da última atividade no carrinho (add/remove/update). null = nunca */
  lastActivityAt: number | null;
  /** Cliente abandonou? (carrinho cheio + última atividade > 60min) */
  isAbandoned: boolean;
  /** Cupom relâmpago gerado por carrinho abandonado (10% off, 30min). */
  relampagoCoupon: RelampagoCoupon | null;
  /** Marca o cupom como visto (não dispara modal de novo na mesma sessão) */
  dismissRelampago: () => void;
};

/** Cupom relâmpago gerado quando cliente volta com carrinho abandonado. */
export type RelampagoCoupon = {
  code: string;
  percent: number; // 0.10 = 10%
  generatedAt: number;
  expiresAt: number;
  dismissed: boolean;
};

const STORAGE_KEY = 'lurds_cart_v1';
const ACTIVITY_KEY = 'lurds_cart_activity';
const RELAMPAGO_KEY = 'lurds_relampago_coupon';
const ABANDON_THRESHOLD_MS = 60 * 60 * 1000; // 1h
const RELAMPAGO_VALIDITY_MS = 30 * 60 * 1000; // 30min

const CartContext = createContext<CartContextType | null>(null);

function genRelampagoCode(): string {
  // Código curto e legível: 4 chars (sem 0/O/1/I/L confusos)
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = 'LUR-';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [lastActivityAt, setLastActivityAt] = useState<number | null>(null);
  const [relampagoCoupon, setRelampagoCoupon] = useState<RelampagoCoupon | null>(null);

  // Hidrata do localStorage 1x
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setItems(JSON.parse(raw));
    } catch {}
    try {
      const act = window.localStorage.getItem(ACTIVITY_KEY);
      if (act) setLastActivityAt(parseInt(act, 10));
    } catch {}
    try {
      const rel = window.localStorage.getItem(RELAMPAGO_KEY);
      if (rel) {
        const parsed: RelampagoCoupon = JSON.parse(rel);
        // Expirou? Limpa
        if (parsed.expiresAt < Date.now()) {
          window.localStorage.removeItem(RELAMPAGO_KEY);
        } else {
          setRelampagoCoupon(parsed);
        }
      }
    } catch {}
    setHydrated(true);

    // Sync entre abas
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try { setItems(JSON.parse(e.newValue)); } catch {}
      }
      if (e.key === RELAMPAGO_KEY) {
        try {
          setRelampagoCoupon(e.newValue ? JSON.parse(e.newValue) : null);
        } catch {}
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Persiste itens a cada mudança (só depois de hidratar)
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {}
  }, [items, hydrated]);

  /**
   * Detecção de abandono na hidratação:
   * Se carrinho tem itens E última atividade > 60min atrás E
   * ainda não gerou cupom relâmpago nas últimas 24h → gera.
   */
  useEffect(() => {
    if (!hydrated || items.length === 0 || relampagoCoupon) return;
    if (!lastActivityAt) return;
    const idleMs = Date.now() - lastActivityAt;
    if (idleMs < ABANDON_THRESHOLD_MS) return;
    // Verifica se já gerou cupom nas últimas 24h (anti-spam)
    try {
      const lastGen = window.localStorage.getItem('lurds_relampago_last_gen');
      if (lastGen && Date.now() - parseInt(lastGen, 10) < 24 * 60 * 60 * 1000) {
        return;
      }
    } catch {}
    // Gera cupom
    const now = Date.now();
    const coupon: RelampagoCoupon = {
      code: genRelampagoCode(),
      percent: 0.10,
      generatedAt: now,
      expiresAt: now + RELAMPAGO_VALIDITY_MS,
      dismissed: false,
    };
    try {
      window.localStorage.setItem(RELAMPAGO_KEY, JSON.stringify(coupon));
      window.localStorage.setItem('lurds_relampago_last_gen', String(now));
    } catch {}
    setRelampagoCoupon(coupon);
  }, [hydrated, items.length, lastActivityAt, relampagoCoupon]);

  /** Atualiza timestamp de atividade. Chamado em add/update/remove. */
  const touchActivity = useCallback(() => {
    const now = Date.now();
    setLastActivityAt(now);
    try { window.localStorage.setItem(ACTIVITY_KEY, String(now)); } catch {}
  }, []);

  const dismissRelampago = useCallback(() => {
    if (!relampagoCoupon) return;
    const updated = { ...relampagoCoupon, dismissed: true };
    setRelampagoCoupon(updated);
    try {
      window.localStorage.setItem(RELAMPAGO_KEY, JSON.stringify(updated));
    } catch {}
  }, [relampagoCoupon]);

  const addItem = useCallback((item: Omit<CartItem, 'quantity'> & { quantity?: number }) => {
    setItems((prev) => {
      const existing = prev.findIndex(
        (i) => i.productId === item.productId && i.variationId === item.variationId,
      );
      if (existing >= 0) {
        const copy = [...prev];
        copy[existing] = { ...copy[existing], quantity: copy[existing].quantity + (item.quantity || 1) };
        return copy;
      }
      return [...prev, { ...item, quantity: item.quantity || 1 }];
    });
    touchActivity();
  }, [touchActivity]);

  const updateQuantity = useCallback((productId: number, variationId: number | null, qty: number) => {
    setItems((prev) =>
      prev
        .map((i) =>
          i.productId === productId && i.variationId === variationId
            ? { ...i, quantity: Math.max(0, qty) }
            : i,
        )
        .filter((i) => i.quantity > 0),
    );
    touchActivity();
  }, [touchActivity]);

  const removeItem = useCallback((productId: number, variationId: number | null) => {
    setItems((prev) =>
      prev.filter((i) => !(i.productId === productId && i.variationId === variationId)),
    );
    touchActivity();
  }, [touchActivity]);

  const clear = useCallback(() => {
    setItems([]);
    // Limpa também cupom relâmpago (compra finalizada)
    try {
      window.localStorage.removeItem(RELAMPAGO_KEY);
      window.localStorage.removeItem(ACTIVITY_KEY);
    } catch {}
    setRelampagoCoupon(null);
    setLastActivityAt(null);
  }, []);

  const itemCount = items.reduce((s, i) => s + i.quantity, 0);
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);

  // Abandono = carrinho cheio + última atividade > 60min
  const isAbandoned =
    items.length > 0 &&
    lastActivityAt !== null &&
    Date.now() - lastActivityAt > ABANDON_THRESHOLD_MS;

  return (
    <CartContext.Provider
      value={{
        items, itemCount, subtotal,
        addItem, updateQuantity, removeItem, clear,
        lastActivityAt, isAbandoned,
        relampagoCoupon, dismissRelampago,
      }}
    >
      {children}
    </CartContext.Provider>
  );
}

export function useCart(): CartContextType {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart deve ser usado dentro de CartProvider');
  return ctx;
}
