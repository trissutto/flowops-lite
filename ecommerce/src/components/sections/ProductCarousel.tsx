'use client';

import { LuxuryCarousel } from '@/components/ui/LuxuryCarousel';
import { ProductCard } from '@/components/cards/ProductCard';
import type { Product } from '@/types';

/**
 * Vitrine de produtos em carrossel — usada em Novidades, Best Sellers e
 * "quem viu também levou". Nenhuma página monta grade de produto na mão.
 */
export function ProductCarousel({
  products,
  ariaLabel,
  onQuickView,
}: {
  products: Product[];
  ariaLabel: string;
  onQuickView?: (product: Product) => void;
}) {
  return (
    <LuxuryCarousel
      ariaLabel={ariaLabel}
      perView={{ base: 1.35, sm: 2, lg: 3, xl: 4 }}
      gap="md"
      arrows
    >
      {products.map((product, index) => (
        <ProductCard
          key={product.id}
          product={product}
          index={index}
          onQuickView={onQuickView}
        />
      ))}
    </LuxuryCarousel>
  );
}
