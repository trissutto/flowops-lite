import type { BuyFourPayThreePreview, PromotionCartLine } from '@/types/promotion';

const money = (value: number) => Math.round(value * 100) / 100;

/** Prévia visual; o backend sempre recalcula antes de cobrar. */
export function previewBuyFourPayThree(lines: PromotionCartLine[]): BuyFourPayThreePreview {
  const subtotal = money(
    lines.reduce((sum, line) => sum + line.unitPrice * Math.max(0, line.quantity), 0),
  );
  const candidates = new Map<string, PromotionCartLine>();

  for (const line of lines) {
    if (line.quantity <= 0 || !Number.isFinite(line.unitPrice) || line.unitPrice < 0) continue;
    const current = candidates.get(line.productId);
    if (
      !current ||
      line.unitPrice < current.unitPrice ||
      (line.unitPrice === current.unitPrice &&
        (line.variationId ?? 0) < (current.variationId ?? 0))
    ) {
      candidates.set(line.productId, line);
    }
  }

  const distinctProducts = candidates.size;
  const freeItem =
    distinctProducts >= 4
      ? [...candidates.values()].sort(
          (a, b) =>
            a.unitPrice - b.unitPrice ||
            a.productId.localeCompare(b.productId) ||
            (a.variationId ?? 0) - (b.variationId ?? 0),
        )[0] ?? null
      : null;
  const discountValue = freeItem ? money(freeItem.unitPrice) : 0;

  return {
    applied: Boolean(freeItem),
    distinctProducts,
    productsToGo: Math.max(0, 4 - distinctProducts),
    discountValue,
    finalSubtotal: money(subtotal - discountValue),
    freeItem,
  };
}
