import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CartLine } from '@/types';

/**
 * Carrinho local — fonte da verdade do cliente até o checkout.
 * A linha é identificada por produto+tamanho+cor (a mesma peça em dois
 * tamanhos são duas linhas).
 *
 * Sprint 009 estendeu o store SEM mudar a API original (lines/add/remove/
 * setQuantity/clear seguem intocados — nenhuma tela precisou ser reescrita):
 *
 * - `couponCode`/`cep`/`shippingQuoteId` guardam só a ESCOLHA da cliente,
 *   nunca o valor calculado. Desconto e frete são recalculados a cada render
 *   por `applyCoupon`/`findQuote` — persistir preço em localStorage é convite
 *   pra cobrar frete de ontem com a regra de hoje.
 * - `savedForLater` fica FORA de `lines` de propósito: não conta no subtotal,
 *   não vai pro checkout e sobrevive ao `clear()` pós-compra.
 *
 * Tudo persiste no mesmo `lurds-cart` — estado antigo ({ lines }) migra
 * sozinho: o merge do persist preenche as chaves novas com os defaults.
 */

/**
 * Id da linha = produto+tamanho+cor. Exportado porque o checkout precisa
 * casar a peça que o backend recusou (`{ productId, size, color }`) com a
 * linha certa da sacola — ver `refreshPrice`.
 */
export function lineKey(productId: string, size: string, color?: string | null): string {
  return [productId, size, color ?? '-'].join('::');
}

interface CartState {
  lines: CartLine[];
  /** Peças guardadas pra depois — fora do subtotal e do checkout. */
  savedForLater: CartLine[];
  /** Código do cupom aplicado. A validação mora em lib/commerce/cupom. */
  couponCode: string | null;
  /** CEP da última cotação — pré-preenche sacola e checkout. */
  cep: string | null;
  /** Id da `ShippingQuote` escolhida — recotada a cada uso, nunca o preço. */
  shippingQuoteId: string | null;
  add: (line: Omit<CartLine, 'id'>) => void;
  remove: (id: string) => void;
  setQuantity: (id: string, quantity: number) => void;
  /**
   * Reescreve o preço unitário de UMA linha com o preço atual do catálogo.
   *
   * O `unitPrice` entra na sacola uma única vez (no add) e fica congelado no
   * localStorage sem prazo. Cliente que adicionou na promoção e voltou dois
   * dias depois mandava o preço velho; o guard do backend recusava com
   * "atualize a página" — e F5 não atualizava nada, porque ninguém reescrevia
   * o preço. Beco sem saída até remover e readicionar a peça. Agora, quando o
   * backend recusa por preço e diz qual peça e quanto custa (`item.precoAtual`),
   * o checkout chama isto e a compra volta a ficar a um clique.
   */
  refreshPrice: (id: string, unitPrice: number) => void;
  clear: () => void;
  setCoupon: (code: string | null) => void;
  setCep: (cep: string | null) => void;
  setShippingQuote: (quoteId: string | null) => void;
  saveForLater: (id: string) => void;
  moveToCart: (id: string) => void;
  removeSaved: (id: string) => void;
}

export const useCartStore = create<CartState>()(
  persist(
    (set) => ({
      lines: [],
      savedForLater: [],
      couponCode: null,
      cep: null,
      shippingQuoteId: null,
      add: (line) =>
        set((state) => {
          const id = lineKey(line.productId, line.size, line.color);
          const existing = state.lines.find((l) => l.id === id);
          if (existing) {
            // Readicionar a MESMA peça renova o preço com o da vitrine de agora
            // (antes só somava a quantidade e mantinha o preço do primeiro add).
            // Se o preço caiu, o backend já cobra o menor; se subiu, a linha
            // velha seria recusada de qualquer jeito — o preço novo é o único
            // que passa no guard.
            return {
              lines: state.lines.map((l) =>
                l.id === id
                  ? { ...l, quantity: l.quantity + line.quantity, unitPrice: line.unitPrice }
                  : l,
              ),
            };
          }
          return { lines: [...state.lines, { ...line, id }] };
        }),
      remove: (id) => set((state) => ({ lines: state.lines.filter((l) => l.id !== id) })),
      refreshPrice: (id, unitPrice) =>
        set((state) => {
          if (!Number.isFinite(unitPrice) || unitPrice <= 0) return state;
          return { lines: state.lines.map((l) => (l.id === id ? { ...l, unitPrice } : l)) };
        }),
      setQuantity: (id, quantity) =>
        set((state) => ({
          lines:
            quantity <= 0
              ? state.lines.filter((l) => l.id !== id)
              : state.lines.map((l) => (l.id === id ? { ...l, quantity } : l)),
        })),
      // clear() zera o PEDIDO (linhas, cupom, frete escolhido) mas preserva o
      // que pertence à CLIENTE: o CEP dela não muda porque ela comprou, e o
      // "guardado para depois" existe justamente pra sobreviver à compra.
      clear: () => set({ lines: [], couponCode: null, shippingQuoteId: null }),
      setCoupon: (code) => set({ couponCode: code ? code.trim().toUpperCase() : null }),
      setCep: (cep) => set({ cep }),
      setShippingQuote: (quoteId) => set({ shippingQuoteId: quoteId }),
      saveForLater: (id) =>
        set((state) => {
          const line = state.lines.find((l) => l.id === id);
          if (!line) return state;
          const saved = state.savedForLater.find((l) => l.id === id);
          return {
            lines: state.lines.filter((l) => l.id !== id),
            savedForLater: saved
              ? state.savedForLater.map((l) =>
                  l.id === id ? { ...l, quantity: l.quantity + line.quantity } : l,
                )
              : [...state.savedForLater, line],
          };
        }),
      moveToCart: (id) =>
        set((state) => {
          const line = state.savedForLater.find((l) => l.id === id);
          if (!line) return state;
          const existing = state.lines.find((l) => l.id === id);
          return {
            savedForLater: state.savedForLater.filter((l) => l.id !== id),
            lines: existing
              ? state.lines.map((l) =>
                  l.id === id ? { ...l, quantity: l.quantity + line.quantity } : l,
                )
              : [...state.lines, line],
          };
        }),
      removeSaved: (id) =>
        set((state) => ({ savedForLater: state.savedForLater.filter((l) => l.id !== id) })),
    }),
    { name: 'lurds-cart' },
  ),
);

export const useCartCount = () =>
  useCartStore((s) => s.lines.reduce((sum, l) => sum + l.quantity, 0));

export const useCartSubtotal = () =>
  useCartStore((s) => s.lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0));
