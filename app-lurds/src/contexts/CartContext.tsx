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
};

const STORAGE_KEY = 'lurds_cart_v1';

const CartContext = createContext<CartContextType | null>(null);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Hidrata do localStorage 1x
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setItems(JSON.parse(raw));
    } catch {}
    setHydrated(true);

    // Sync entre abas
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try { setItems(JSON.parse(e.newValue)); } catch {}
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Persiste a cada mudança (só depois de hidratar)
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {}
  }, [items, hydrated]);

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
  }, []);

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
  }, []);

  const removeItem = useCallback((productId: number, variationId: number | null) => {
    setItems((prev) =>
      prev.filter((i) => !(i.productId === productId && i.variationId === variationId)),
    );
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const itemCount = items.reduce((s, i) => s + i.quantity, 0);
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);

  return (
    <CartContext.Provider value={{ items, itemCount, subtotal, addItem, updateQuantity, removeItem, clear }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart(): CartContextType {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart deve ser usado dentro de CartProvider');
  return ctx;
}
