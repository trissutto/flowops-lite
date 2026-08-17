'use client';

import { LuxuryCarousel } from '@/components/ui/LuxuryCarousel';
import { CAROUSEL_PRODUCT_SIZES, ProductCard } from '@/components/cards/ProductCard';
import type { Product } from '@/types';
import { trackSelectItem } from '@/lib/tracking';

/**
 * Vitrine de produtos em carrossel — usada em Novidades, Best Sellers e
 * "quem viu também levou". Nenhuma página monta grade de produto na mão.
 */
export function ProductCarousel({
  products,
  ariaLabel,
  onQuickView,
  progressiveImages = false,
  compactMobile = false,
}: {
  products: Product[];
  ariaLabel: string;
  onQuickView?: (product: Product) => void;
  progressiveImages?: boolean;
  compactMobile?: boolean;
}) {
  return (
    <LuxuryCarousel
      ariaLabel={ariaLabel}
      perView={{ base: compactMobile ? 2.05 : 1.35, sm: 2, lg: 3, xl: 4 }}
      gap="md"
      arrows
    >
      {products.map((product, index) => (
        <ProductCard
          key={product.id}
          product={product}
          index={index}
          onQuickView={onQuickView}
          sizes={CAROUSEL_PRODUCT_SIZES}
          progressiveImage={progressiveImages}
          onProductClick={() => trackSelectItem(product, ariaLabel, index)}
        />
      ))}
    </LuxuryCarousel>
  );
}
