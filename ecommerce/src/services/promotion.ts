import 'server-only';
import type { PublicPromotionConfig } from '@/types/promotion';

const DISABLED: PublicPromotionConfig = {
  enabled: false,
  mode: 'buy_4_pay_3',
  campaignCode: 'LEVE4PAGUE3',
  headline: '',
  bannerText: '',
  blocksPixDiscount: true,
};

export async function getPublicPromotion(): Promise<PublicPromotionConfig> {
  const baseUrl = process.env.FLOWOPS_API_URL?.replace(/\/$/, '');
  if (!baseUrl) return DISABLED;

  try {
    const response = await fetch(`${baseUrl}/app/progressive-discount`, {
      next: { revalidate: 30 },
    });
    if (!response.ok) return DISABLED;
    const data = (await response.json()) as Partial<PublicPromotionConfig>;
    if (!data.enabled || data.mode !== 'buy_4_pay_3') return DISABLED;
    return { ...DISABLED, ...data, enabled: true };
  } catch {
    return DISABLED;
  }
}
