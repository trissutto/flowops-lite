import type { HomeCategory } from '@/components/sections/HomeDiscovery';

export const HOME_CATEGORY_BASE: Array<Omit<HomeCategory, 'href'> & { path: string }> = [
  { name: 'Vestidos', image: '/images/home-categorias/vestidos.webp', path: '/categoria/vestidos', alt: 'Modelo plus size usando vestido preto elegante' },
  { name: 'Blusas', image: '/images/home-categorias/blusas.webp', path: '/categoria/blusas', alt: 'Modelo plus size usando blusa creme elegante' },
  { name: 'Conjuntos', image: '/images/home-categorias/conjuntos.webp', path: '/categoria/conjuntos', alt: 'Modelo plus size usando conjunto terracota' },
  { name: 'Calças', image: '/images/home-categorias/calcas.webp', path: '/categoria/calcas', alt: 'Modelo plus size usando calça de alfaiataria' },
  { name: 'Macacões', image: '/categorias/macacoes.webp', path: '/categoria/macacoes', alt: 'Moda plus size em macacão' },
  { name: 'Lingerie', image: '/categorias/lingerie.webp', path: '/categoria/lingerie', alt: 'Lingerie plus size' },
  { name: 'Moda praia', image: '/categorias/moda-praia.webp', path: '/categoria/moda-praia', alt: 'Moda praia plus size' },
  { name: 'Outlet', image: '/images/home-categorias/outlet.webp', path: '/outlet', alt: 'Modelo plus size usando vestido vinho elegante' },
];

export const HOME_STORES_PATH = '/lojas';
export const HOME_NEWS_PATH = '/novidades';
