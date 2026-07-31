import type { Metadata } from 'next';
import { SearchResults } from '@/components/commerce/SearchResults';

/**
 * PÁGINA DE BUSCA — /busca?q=termo
 *
 * Casca server mínima: metadata + repasse do termo. Toda a inteligência
 * (intenção, ranking, zero-results premium, tracking) vive no client em
 * `SearchResults` — busca é interativa por natureza, e o termo chega como
 * PROP do server (nada de useSearchParams/Suspense no meio do caminho).
 *
 * `noindex`: página de resultado interno indexada vira thin content e
 * canibaliza as categorias no Google. Follow mantido — os links pros
 * produtos continuam passando sinal.
 */

interface BuscaPageProps {
  searchParams: Promise<{ q?: string }>;
}

export async function generateMetadata({ searchParams }: BuscaPageProps): Promise<Metadata> {
  const { q } = await searchParams;
  const termo = (q ?? '').trim();
  return {
    title: termo ? `Busca: ${termo}` : 'Busca',
    description: termo
      ? `Resultados para "${termo}" na Lurds Plus Size — moda plus size do 46 ao 60.`
      : 'Busque por peça, ocasião, tecido ou tamanho na Lurds Plus Size.',
    robots: { index: false, follow: true },
  };
}

export default async function BuscaPage({ searchParams }: BuscaPageProps) {
  const { q } = await searchParams;
  return <SearchResults term={(q ?? '').trim()} />;
}
