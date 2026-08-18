export type PromotionMode = 'progressive_percentage' | 'buy_4_pay_3';

export interface PublicPromotionConfig {
  enabled: boolean;
  mode: PromotionMode;
  campaignCode: string;
  headline: string;
  bannerText: string;
  blocksPixDiscount: boolean;
}

export interface PromotionCartLine {
  productId: string;
  variationId?: number | null;
  quantity: number;
  unitPrice: number;
}

export interface BuyFourPayThreePreview {
  applied: boolean;
  distinctProducts: number;
  productsToGo: number;
  discountValue: number;
  finalSubtotal: number;
  freeItem: PromotionCartLine | null;
}
