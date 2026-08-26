import type { Product } from '@/types';

export function storeLaunchHeroTitle(unit: string): string {
  return `Novidades Lurd's em ${unit}`;
}

export const STORE_LAUNCH_HERO_DESCRIPTION =
  'Looks plus size do 44 ao 60, com caimento que valoriza você e atendimento acolhedor para experimentar sem pressa.';

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
