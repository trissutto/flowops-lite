import type { Product } from '@/types';

/**
 * A vitrine da loja só promete o que consegue mostrar com honestidade:
 * produto online, com foto oficial e grade disponível.
 */
export function selectStoreLaunches(products: Product[], limit = 6): Product[] {
  return products
    .filter((product) => product.images.length > 0 && product.availability?.online !== false)
    .slice(0, limit);
}

/** Mesmo contrato de cor do ProductCard, exposto para o link rastreado. */
export function storeLaunchProductHref(product: Product): string {
  const color = product.vitrineCor
    ? `?cor=${encodeURIComponent(product.vitrineCor.nome)}`
    : '';
  return `/produto/${product.slug}${color}`;
}
