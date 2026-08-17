import type { HomeCategory } from '@/components/sections/HomeDiscovery';

export const HOME_CATEGORY_BASE: Array<Omit<HomeCategory, 'href'> & { path: string }> = [
  { name: 'Vestidos', image: '/images/home-categorias/vestidos.webp', path: '/categoria/vestidos', alt: 'Modelo plus size usando vestido preto elegante' },
  { name: 'Blusas', image: '/images/home-categorias/blusas.webp', path: '/categoria/blusas', alt: 'Modelo plus size usando blusa creme elegante' },
  { name: 'Conjuntos', image: '/images/home-categorias/conjuntos.webp', path: '/categoria/conjuntos', alt: 'Modelo plus size usando conjunto terracota' },
  { name: 'Calças', image: '/images/home-categorias/calcas.webp', path: '/categoria/calcas', alt: 'Modelo plus size usando calça de alfaiataria' },
  { name: 'Macacões', image: 'https://pub-84da472609374e0ab161fd54571b5f38.r2.dev/produtos/900751/VERDE/1786069677950-900751-VERDE-1.jpg', path: '/categoria/macacoes', alt: 'Modelo plus size usando macacão verde' },
  { name: 'Lingerie', image: 'https://pub-84da472609374e0ab161fd54571b5f38.r2.dev/produtos/350842/CHOCOLATE/1786065808991-350842-CHOCOLATE-1-jpg.jpg', path: '/categoria/lingerie', alt: 'Modelo plus size usando cinta modeladora chocolate' },
  { name: 'Moda praia', image: 'https://pub-84da472609374e0ab161fd54571b5f38.r2.dev/produtos/617581/PRETO/1786066584170-617581-PRETO-1.jpg', path: '/categoria/moda-praia', alt: 'Modelo plus size usando maiô preto' },
  { name: 'Outlet', image: '/images/home-categorias/outlet.webp', path: '/outlet', alt: 'Modelo plus size usando vestido vinho elegante' },
];

export const HOME_STORES_PATH = '/lojas';
export const HOME_NEWS_PATH = '/novidades';
