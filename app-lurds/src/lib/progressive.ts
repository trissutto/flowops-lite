/**
 * Cálculo local do Desconto Progressivo Lurd's.
 *
 * Espelha a lógica do backend (progressive-discount.service.ts) pra dar
 * feedback INSTANTÂNEO no carrinho enquanto cliente adiciona/remove peças.
 * Backend revalida no checkout (fonte de verdade).
 *
 * Regras Lurd's:
 *   - Conta SKUs únicos (peças variadas), não unidades
 *   - Exclui produtos em promoção
 *   - Quando ativo, BLOQUEIA desconto PIX (regra do user)
 *   - Aplica % sobre o subtotal dos itens elegíveis
 */
import type {
  ProgressivePublicConfig,
  ProgressiveCartItem,
  ProgressiveDiscountResult,
  ProgressiveTier,
} from './api';

export function calcProgressiveLocal(
  cfg: ProgressivePublicConfig,
  items: ProgressiveCartItem[],
): ProgressiveDiscountResult {
  const totalCart = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
  const empty: ProgressiveDiscountResult = {
    applied: false,
    tierPct: 0,
    tierLabel: '',
    eligiblePieces: 0,
    eligibleSubtotal: 0,
    discountValue: 0,
    finalTotal: totalCart,
    blocksPixDiscount: false,
    nextTier: null,
  };

  if (!cfg.enabled || !cfg.tiers?.length) return empty;

  const isPromo = (i: ProgressiveCartItem) =>
    i.onSale === true ||
    (typeof i.regularPrice === 'number' && i.regularPrice > i.unitPrice);

  const eligible = cfg.excludePromoItems !== false ? items.filter((i) => !isPromo(i)) : items;
  if (!eligible.length) return empty;

  let pieces = 0;
  if ((cfg.countMode || 'unique_sku') === 'unique_sku') {
    const seen = new Set<string>();
    for (const it of eligible) {
      const k = `${it.productId}:${it.variationId || 0}`;
      if (!seen.has(k)) {
        seen.add(k);
        pieces++;
      }
    }
  } else {
    pieces = eligible.reduce((s, i) => s + i.qty, 0);
  }

  const eligibleSubtotal = eligible.reduce((s, i) => s + i.unitPrice * i.qty, 0);

  const sortedTiers = [...cfg.tiers].sort((a, b) => a.minPieces - b.minPieces);
  let tier: ProgressiveTier | null = null;
  for (const t of sortedTiers) if (pieces >= t.minPieces) tier = t;

  if (!tier) {
    const next = sortedTiers[0];
    if (next) {
      return {
        ...empty,
        nextTier: {
          piecesToGo: next.minPieces - pieces,
          nextPct: next.discountPct,
          extraPct: next.discountPct,
        },
      };
    }
    return empty;
  }

  const discountValue = round2(eligibleSubtotal * (tier.discountPct / 100));
  const nextTier = sortedTiers.find((t) => t.minPieces > pieces);

  return {
    applied: true,
    tierPct: tier.discountPct,
    tierLabel: `${pieces} peças = ${tier.discountPct}% OFF`,
    eligiblePieces: pieces,
    eligibleSubtotal,
    discountValue,
    finalTotal: round2(totalCart - discountValue),
    blocksPixDiscount: cfg.blocksPixDiscount !== false,
    nextTier: nextTier
      ? {
          piecesToGo: nextTier.minPieces - pieces,
          nextPct: nextTier.discountPct,
          extraPct: nextTier.discountPct - tier.discountPct,
        }
      : null,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

const fmtBrl = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Mensagem UX dinâmica pra mostrar no carrinho */
export function progressiveMessage(r: ProgressiveDiscountResult): string {
  if (r.applied) {
    if (r.nextTier) {
      return `✨ Você economizou ${fmtBrl(r.discountValue)}! +${r.nextTier.piecesToGo} peça(s) e ganha mais ${r.nextTier.extraPct}% OFF`;
    }
    return `✨ Desconto máximo! Você economizou ${fmtBrl(r.discountValue)}`;
  }
  if (r.nextTier) {
    return `💡 Adicione +${r.nextTier.piecesToGo} peça(s) e ganhe ${r.nextTier.nextPct}% OFF`;
  }
  return '';
}
