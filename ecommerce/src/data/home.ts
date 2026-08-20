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

/**
 * Teto de peças por vitrine da home: 9 linhas de 2 no celular; no desktop a
 * grade é 4 colunas (dono, 20/08 — "pelo menos 12 produtos em 4 colunas"),
 * então 18 sai como 4+4+4+4+2.
 *
 * ⚠️ MORA AQUI, e não junto do `VitrineGrid` que a usa, por um motivo que
 * nenhuma verificação automática pega: `VitrineGrid` é `'use client'`, e
 * constante exportada de módulo client NÃO é valor quando lida do servidor —
 * vira uma referência de cliente. A home é Server Component e passa esta
 * constante como `limite` do fetch; importando-a de lá, o `perPage` da URL
 * virava o texto de um `throw` ("Attempted to call VITRINE_GRID_MAX() from the
 * server...") e as quatro vitrines de categoria chegavam VAZIAS.
 *
 * E chegavam caladas: `tsc`, ESLint e `next build` passaram os três, porque
 * pro TypeScript o tipo continua sendo `number`. Só apareceu olhando a URL que
 * saiu na rede.
 */
export const VITRINE_GRID_MAX = 18;
