import { create } from 'zustand';

/**
 * Estado de UI global — o que só existe pra coordenar overlays.
 * Regra: só um overlay aberto por vez (abrir um fecha os outros), senão
 * o scroll-lock e o foco começam a brigar.
 */

type Overlay = 'search' | 'menu' | 'cart' | null;

interface UiState {
  overlay: Overlay;
  openOverlay: (overlay: Exclude<Overlay, null>) => void;
  closeOverlay: () => void;
  toggleOverlay: (overlay: Exclude<Overlay, null>) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  overlay: null,
  openOverlay: (overlay) => set({ overlay }),
  closeOverlay: () => set({ overlay: null }),
  toggleOverlay: (overlay) => set({ overlay: get().overlay === overlay ? null : overlay }),
}));

/** Seletores prontos — evita re-render de quem só quer saber de um overlay. */
export const useIsSearchOpen = () => useUiStore((s) => s.overlay === 'search');
export const useIsMenuOpen = () => useUiStore((s) => s.overlay === 'menu');
export const useIsCartOpen = () => useUiStore((s) => s.overlay === 'cart');
