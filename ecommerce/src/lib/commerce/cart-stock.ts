export interface CartStockNotice {
  text: string;
  tone: 'danger' | 'gold';
  bloqueia?: boolean;
  maxQuantity?: number;
}

/** Atualiza o estado do aviso quando a cliente reduz a quantidade sem nova rede. */
export function currentCartStockNotice(
  quantity: number,
  notice?: CartStockNotice,
): CartStockNotice | undefined {
  if (!notice) return undefined;
  if (notice.bloqueia && notice.maxQuantity && quantity <= notice.maxQuantity) {
    return {
      tone: 'gold',
      maxQuantity: notice.maxQuantity,
      text: `Limite disponível neste tamanho: ${notice.maxQuantity}.`,
    };
  }
  return notice;
}

export function cartStockBlocksCheckout(quantity: number, notice?: CartStockNotice): boolean {
  return currentCartStockNotice(quantity, notice)?.bloqueia === true;
}
