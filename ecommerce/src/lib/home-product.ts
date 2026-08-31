import type { Product } from '@/types';

/**
 * Corta dados exclusivos da PDP antes de um produto da home atravessar a
 * fronteira servidor → navegador. O retorno continua compatível com o card.
 */
export function compactarProdutoDaHome(product: Product): Product {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    category: product.category,
    price: product.price,
    ...(product.compareAtPrice != null ? { compareAtPrice: product.compareAtPrice } : {}),
    ...(product.pixPrice != null ? { pixPrice: product.pixPrice } : {}),
    ...(product.installments ? { installments: product.installments } : {}),
    images: product.images.slice(0, 2),
    ...(product.colors ? { colors: product.colors } : {}),
    sizes: product.sizes,
    ...(product.vitrineCor ? { vitrineCor: product.vitrineCor } : {}),
    ...(product.badges ? { badges: product.badges } : {}),
    ...(product.fabric ? { fabric: product.fabric } : {}),
    ...(product.availability ? { availability: product.availability } : {}),
  };
}
