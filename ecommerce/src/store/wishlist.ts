import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Favoritos — persistidos em localStorage por enquanto.
 * Quando houver conta logada, este store sincroniza com a API (o shape
 * de fora não muda: os componentes só conhecem toggle/has/count).
 */

interface WishlistState {
  ids: string[];
  toggle: (productId: string) => void;
  has: (productId: string) => boolean;
  clear: () => void;
}

export const useWishlistStore = create<WishlistState>()(
  persist(
    (set, get) => ({
      ids: [],
      toggle: (productId) =>
        set((state) => ({
          ids: state.ids.includes(productId)
            ? state.ids.filter((id) => id !== productId)
            : [...state.ids, productId],
        })),
      has: (productId) => get().ids.includes(productId),
      clear: () => set({ ids: [] }),
    }),
    { name: 'lurds-wishlist' },
  ),
);

export const useWishlistCount = () => useWishlistStore((s) => s.ids.length);
