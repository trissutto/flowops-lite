import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const CONFIG_KEY = 'progressive_discount';

export type DiscountTier = {
  minPieces: number;
  discountPct: number;
};

export type ProgressiveDiscountConfig = {
  enabled: boolean;
  mode: 'progressive_percentage' | 'buy_4_pay_3';
  campaignCode: string;
  headline: string;
  tiers: DiscountTier[];
  excludePromoItems: boolean;
  countMode: 'unique_sku' | 'unit';   // unique_sku = peças variadas (regra Lurd's)
  minCartValue: number | null;        // R$ mínimo pra valer (null = sem mínimo)
  startsAt: string | null;            // ISO date
  endsAt: string | null;              // ISO date
  bannerText: string;                 // texto banner home
  // PIX: se enabled e tier ativo, PIX NÃO dá desconto adicional
  blocksPixDiscount: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

const DEFAULT_CONFIG: ProgressiveDiscountConfig = {
  enabled: false,
  mode: 'progressive_percentage',
  campaignCode: 'LEVE4PAGUE3',
  headline: 'Leve 4, Pague 3',
  tiers: [
    { minPieces: 2, discountPct: 10 },
    { minPieces: 3, discountPct: 15 },
    { minPieces: 4, discountPct: 20 },
    { minPieces: 5, discountPct: 25 },
  ],
  excludePromoItems: true,
  countMode: 'unique_sku',
  minCartValue: null,
  startsAt: null,
  endsAt: null,
  bannerText: '🎉 LEVA MAIS, PAGA MENOS — até 25% OFF no app',
  blocksPixDiscount: true,
  updatedAt: null,
  updatedBy: null,
};

export type CartItem = {
  productId: number;
  variationId?: number | null;
  qty: number;
  unitPrice: number;       // preço unitário
  regularPrice?: number;   // preço original (pra detectar promo)
  onSale?: boolean;        // flag explícita de promo
};

export type DiscountResult = {
  applied: boolean;
  tierPct: number;
  tierLabel: string;
  eligiblePieces: number;
  eligibleSubtotal: number;
  discountValue: number;
  finalTotal: number;
  blocksPixDiscount: boolean;
  // Pra mostrar progress: "+1 peça e ganha 5% extra"
  nextTier: { piecesToGo: number; nextPct: number; extraPct: number } | null;
  mode: ProgressiveDiscountConfig['mode'] | null;
  campaignCode: string | null;
  distinctProducts: number;
  productsToGo: number;
  freeItem: {
    productId: number;
    variationId: number | null;
    unitPrice: number;
  } | null;
};

@Injectable()
export class ProgressiveDiscountService {
  private readonly logger = new Logger(ProgressiveDiscountService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Lê config do banco (cria default se não existe) */
  async getConfig(): Promise<ProgressiveDiscountConfig> {
    try {
      const row = await (this.prisma as any).appConfig.findUnique({
        where: { key: CONFIG_KEY },
      });
      if (!row) return { ...DEFAULT_CONFIG };
      return { ...DEFAULT_CONFIG, ...JSON.parse(row.valueJson) };
    } catch (error) {
      this.logger.error('[progressive] falha ao ler configuração; campanha desativada', error);
      return { ...DEFAULT_CONFIG, enabled: false };
    }
  }

  /** Salva config (admin) */
  async setConfig(input: Partial<ProgressiveDiscountConfig>): Promise<ProgressiveDiscountConfig> {
    const current = await this.getConfig();
    const merged: ProgressiveDiscountConfig = {
      ...current,
      ...input,
      updatedAt: new Date().toISOString(),
    };

    // Sanity: tiers ordenados por minPieces ASC e sem duplicatas
    const tiers = (merged.tiers || [])
      .filter((t) => t.minPieces >= 1 && t.discountPct > 0 && t.discountPct <= 100)
      .sort((a, b) => a.minPieces - b.minPieces);
    merged.tiers = tiers;

    await (this.prisma as any).appConfig.upsert({
      where: { key: CONFIG_KEY },
      update: { valueJson: JSON.stringify(merged) },
      create: { key: CONFIG_KEY, valueJson: JSON.stringify(merged) },
    });
    this.logger.log(`[progressive] config atualizada (enabled=${merged.enabled}, tiers=${tiers.length})`);
    return merged;
  }

  /** É hora ativa? (enabled + dentro da janela startsAt/endsAt) */
  private isActiveNow(cfg: ProgressiveDiscountConfig, now = new Date()): boolean {
    if (!cfg.enabled) return false;
    if (cfg.startsAt && now < new Date(cfg.startsAt)) return false;
    if (cfg.endsAt && now > new Date(cfg.endsAt)) return false;
    return true;
  }

  /**
   * Calcula desconto progressivo pra um carrinho.
   * - Conta peças (SKU único ou unidades, conforme countMode)
   * - Exclui produtos em promo se excludePromoItems=true
   * - Aplica % sobre o SUBTOTAL dos itens elegíveis
   */
  async calculate(items: CartItem[]): Promise<DiscountResult> {
    const cfg = await this.getConfig();
    const result: DiscountResult = {
      applied: false,
      tierPct: 0,
      tierLabel: '',
      eligiblePieces: 0,
      eligibleSubtotal: 0,
      discountValue: 0,
      finalTotal: items.reduce((s, i) => s + i.unitPrice * i.qty, 0),
      blocksPixDiscount: false,
      nextTier: null,
      mode: null,
      campaignCode: null,
      distinctProducts: 0,
      productsToGo: 0,
      freeItem: null,
    };

    if (!this.isActiveNow(cfg)) return result;
    if (cfg.mode === 'buy_4_pay_3') return this.calculateBuyFourPayThree(items, cfg, result);
    if (!cfg.tiers.length) return result;

    // Filtra itens elegíveis (não em promo se configurado)
    const isPromo = (i: CartItem) =>
      i.onSale === true ||
      (typeof i.regularPrice === 'number' && i.regularPrice > i.unitPrice);

    const eligible = cfg.excludePromoItems ? items.filter((i) => !isPromo(i)) : [...items];
    if (!eligible.length) return result;

    // Conta peças
    let pieces = 0;
    if (cfg.countMode === 'unique_sku') {
      // 1 SKU/variação = 1 peça (regra Lurd's: peças variadas)
      const seen = new Set<string>();
      for (const it of eligible) {
        const k = `${it.productId}:${it.variationId || 0}`;
        if (!seen.has(k)) {
          seen.add(k);
          pieces++;
        }
      }
    } else {
      // Conta unidades
      pieces = eligible.reduce((s, i) => s + i.qty, 0);
    }

    const eligibleSubtotal = eligible.reduce((s, i) => s + i.unitPrice * i.qty, 0);

    // Verifica minCartValue (sobre o subtotal TOTAL, não só elegível)
    const totalCart = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
    if (cfg.minCartValue && totalCart < cfg.minCartValue) return result;

    // Acha tier aplicável (maior minPieces <= pieces)
    let tier: DiscountTier | null = null;
    for (const t of cfg.tiers) {
      if (pieces >= t.minPieces) tier = t;
    }

    if (!tier) {
      // Sem desconto agora — mas calcula próximo pra dar hint UX
      const next = cfg.tiers[0];
      if (next) {
        result.nextTier = {
          piecesToGo: next.minPieces - pieces,
          nextPct: next.discountPct,
          extraPct: next.discountPct,
        };
      }
      return result;
    }

    // Tier ativo
    const discountValue = +(eligibleSubtotal * (tier.discountPct / 100)).toFixed(2);
    result.applied = true;
    result.tierPct = tier.discountPct;
    result.tierLabel = `${pieces} peças = ${tier.discountPct}% OFF`;
    result.eligiblePieces = pieces;
    result.eligibleSubtotal = eligibleSubtotal;
    result.discountValue = discountValue;
    result.finalTotal = +(totalCart - discountValue).toFixed(2);
    result.blocksPixDiscount = cfg.blocksPixDiscount;

    // Próximo tier (se existir)
    const nextTier = cfg.tiers.find((t) => t.minPieces > pieces);
    if (nextTier) {
      result.nextTier = {
        piecesToGo: nextTier.minPieces - pieces,
        nextPct: nextTier.discountPct,
        extraPct: nextTier.discountPct - tier.discountPct,
      };
    }

    return result;
  }

  private calculateBuyFourPayThree(
    items: CartItem[],
    cfg: ProgressiveDiscountConfig,
    result: DiscountResult,
  ): DiscountResult {
    const candidates = new Map<number, CartItem>();

    for (const item of items) {
      if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0 || item.qty <= 0) continue;
      const current = candidates.get(item.productId);
      if (
        !current ||
        item.unitPrice < current.unitPrice ||
        (item.unitPrice === current.unitPrice && (item.variationId || 0) < (current.variationId || 0))
      ) {
        candidates.set(item.productId, item);
      }
    }

    const distinctProducts = candidates.size;
    result.mode = cfg.mode;
    result.campaignCode = cfg.campaignCode;
    result.distinctProducts = distinctProducts;
    result.eligiblePieces = distinctProducts;
    result.productsToGo = Math.max(0, 4 - distinctProducts);
    result.blocksPixDiscount = distinctProducts >= 4 && cfg.blocksPixDiscount;

    if (distinctProducts < 4) return result;

    const freeItem = [...candidates.values()].sort(
      (a, b) => a.unitPrice - b.unitPrice || a.productId - b.productId || (a.variationId || 0) - (b.variationId || 0),
    )[0];
    if (!freeItem) return result;

    result.applied = true;
    result.tierLabel = cfg.headline;
    result.eligibleSubtotal = result.finalTotal;
    result.discountValue = +freeItem.unitPrice.toFixed(2);
    result.finalTotal = +(result.finalTotal - result.discountValue).toFixed(2);
    result.freeItem = {
      productId: freeItem.productId,
      variationId: freeItem.variationId || null,
      unitPrice: +freeItem.unitPrice.toFixed(2),
    };
    return result;
  }

  /** Versão pública pra o app — só campos visíveis ao cliente */
  async getPublicConfig() {
    const cfg = await this.getConfig();
    if (!this.isActiveNow(cfg)) {
      return { enabled: false, mode: cfg.mode, campaignCode: cfg.campaignCode, headline: '', tiers: [], bannerText: '' };
    }
    return {
      enabled: true,
      mode: cfg.mode,
      campaignCode: cfg.campaignCode,
      headline: cfg.headline,
      tiers: cfg.tiers,
      bannerText: cfg.bannerText,
      excludePromoItems: cfg.excludePromoItems,
      countMode: cfg.countMode,
      blocksPixDiscount: cfg.blocksPixDiscount,
    };
  }
}
