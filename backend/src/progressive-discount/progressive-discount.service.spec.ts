import { ProgressiveDiscountService, ProgressiveDiscountConfig } from './progressive-discount.service';

const activeConfig: ProgressiveDiscountConfig = {
  enabled: true,
  mode: 'buy_4_pay_3',
  campaignCode: 'LEVE4PAGUE3',
  headline: 'Leve 4, Pague 3',
  tiers: [],
  excludePromoItems: false,
  countMode: 'unique_sku',
  minCartValue: null,
  startsAt: null,
  endsAt: null,
  bannerText: 'Leve 4, Pague 3',
  blocksPixDiscount: true,
  updatedAt: null,
  updatedBy: null,
};

describe('ProgressiveDiscountService - Leve 4, Pague 3', () => {
  const appConfig = { findUnique: jest.fn(), upsert: jest.fn() };
  const service = new ProgressiveDiscountService({ appConfig } as any);

  beforeEach(() => {
    jest.clearAllMocks();
    appConfig.findUnique.mockResolvedValue({ valueJson: JSON.stringify(activeConfig) });
  });

  it('mantém a campanha desligada quando a configuração falha', async () => {
    appConfig.findUnique.mockRejectedValue(new Error('database unavailable'));
    const result = await service.calculate([
      { productId: 1, qty: 1, unitPrice: 100 },
      { productId: 2, qty: 1, unitPrice: 90 },
      { productId: 3, qty: 1, unitPrice: 80 },
      { productId: 4, qty: 1, unitPrice: 70 },
    ]);
    expect(result.applied).toBe(false);
    expect(result.finalTotal).toBe(340);
  });

  it('informa o progresso antes de quatro produtos diferentes', async () => {
    const result = await service.calculate([
      { productId: 1, qty: 2, unitPrice: 100 },
      { productId: 2, qty: 1, unitPrice: 80 },
    ]);
    expect(result.applied).toBe(false);
    expect(result.distinctProducts).toBe(2);
    expect(result.productsToGo).toBe(2);
  });

  it('torna grátis a peça de menor preço atual', async () => {
    const result = await service.calculate([
      { productId: 1, qty: 1, unitPrice: 100 },
      { productId: 2, qty: 1, unitPrice: 75, regularPrice: 120, onSale: true },
      { productId: 3, qty: 1, unitPrice: 90 },
      { productId: 4, qty: 1, unitPrice: 110 },
    ]);
    expect(result.applied).toBe(true);
    expect(result.discountValue).toBe(75);
    expect(result.finalTotal).toBe(300);
    expect(result.freeItem).toEqual({ productId: 2, variationId: null, unitPrice: 75 });
    expect(result.blocksPixDiscount).toBe(true);
  });

  it('conta variações do mesmo produto apenas uma vez', async () => {
    const result = await service.calculate([
      { productId: 1, variationId: 10, qty: 1, unitPrice: 100 },
      { productId: 1, variationId: 11, qty: 1, unitPrice: 90 },
      { productId: 2, qty: 1, unitPrice: 80 },
      { productId: 3, qty: 1, unitPrice: 70 },
    ]);
    expect(result.applied).toBe(false);
    expect(result.distinctProducts).toBe(3);
  });

  it('concede somente uma gratuidade com cinco produtos', async () => {
    const result = await service.calculate([
      { productId: 1, qty: 1, unitPrice: 100 },
      { productId: 2, qty: 1, unitPrice: 90 },
      { productId: 3, qty: 1, unitPrice: 80 },
      { productId: 4, qty: 1, unitPrice: 70 },
      { productId: 5, qty: 1, unitPrice: 60 },
    ]);
    expect(result.discountValue).toBe(60);
    expect(result.finalTotal).toBe(340);
  });
});
