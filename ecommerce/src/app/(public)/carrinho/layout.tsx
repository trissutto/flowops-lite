import { buildMetadata } from '@/lib/seo';

/**
 * Existe só pelo TÍTULO DA ABA.
 *
 * `page.tsx` da sacola é `'use client'` (estado do carrinho, revalidação de
 * estoque, cupom) e Client Component não exporta `metadata` — então a sacola
 * herdava o título da home. Quem deixa a compra numa aba e volta depois via
 * "Lurd's Plus Size — Moda plus size elegante do 44 ao 60" em todas elas e não
 * achava a certa. O checkout já resolvia isso pelo layout do grupo; a sacola
 * não tinha layout nenhum.
 */
export const metadata = buildMetadata({
  title: 'Minha sacola',
  path: '/carrinho',
  // Página de estado da cliente: nada a indexar.
  noIndex: true,
});

export default function CarrinhoLayout({ children }: { children: React.ReactNode }) {
  return children;
}
