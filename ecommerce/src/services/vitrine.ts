import 'server-only';
import { api } from '@/lib/api';
import { mapPeca, type PecaApi } from '@/services/products';
import type { Product } from '@/types';

/**
 * VITRINE DA HOME — peças REAIS do catálogo.
 *
 * 🔴 Existe por causa de um achado de 06/08: os dois carrosséis da home
 * (`newArrivals` e `bestSellers`) vinham de `data/content.ts` — um catálogo de
 * mentira, com foto de banco de imagem. **A vitrine principal do site não
 * estava ligada ao estoque.** A cliente clicava numa "mais vendida" e ia parar
 * numa peça que a loja nunca teve.
 *
 * Roda no SERVIDOR (`lib/api` é server-only) e cai em lista vazia sem quebrar:
 * a home some a seção em vez de mostrar produto inventado. Home com uma seção
 * a menos é chata; home com produto que não existe é reclamação.
 */

/**
 * `novidades` = o que mudou por último no catálogo.
 * `relevancia` = a ordem da curadoria (destaque > lançamento > estoque
 * saudável) — é o mais perto de "as que a loja quer empurrar" que existe hoje.
 *
 * ⚠️ NÃO existe "mais vendidas" de verdade ainda: ninguém liga a home no
 * histórico de vendas. Enquanto não ligar, a seção não pode se chamar assim.
 */
export type OrdemVitrine = 'novidades' | 'relevancia' | 'preco-asc' | 'preco-desc';

/**
 * A PRIMEIRA LEVA DA LISTAGEM, PRONTA NO SERVIDOR (perf, 07/08).
 *
 * 🔴 Medido em produção: `/categoria/blusas` chegava com **ZERO produto no
 * HTML**. A página pintava a moldura e só então o navegador baixava o JS,
 * pedia as facetas e pedia os produtos — duas viagens de ~550ms cada, DEPOIS
 * do JS. A cliente ficava olhando esqueleto. (A home, que renderiza no
 * servidor, chegava com 110 links de produto.)
 *
 * Isto devolve a página 1 já resolvida pra listagem usar como `initialData`:
 * a peça vem no HTML, aparece na hora, e o react-query segue cuidando de
 * filtro, ordenação e scroll infinito a partir dali.
 *
 * Nunca lança: catálogo fora do ar volta `null` e a listagem busca no cliente
 * como antes — mais lenta, mas viva.
 */
export async function fetchPrimeiraPagina(opcoes: {
  categoria?: string;
  ordenar?: OrdemVitrine;
  perPage?: number;
  precoMax?: number;
  soPromocao?: boolean;
  revalidate?: number;
}): Promise<{ itens: Product[]; total: number; totalPages: number } | null> {
  const { categoria, ordenar = 'relevancia', perPage = 24, precoMax, soPromocao, revalidate = 600 } = opcoes;
  const params = new URLSearchParams({ page: '1', perPage: String(perPage), ordenar });
  if (categoria) params.set('categoria', categoria);
  if (precoMax) params.set('precoMax', String(precoMax));
  if (soPromocao) params.set('soPromocao', '1');

  try {
    const r = await api<{ itens: PecaApi[]; total?: number; totalPages?: number }>(
      `/public/loja/produtos?${params.toString()}`,
      { revalidate, tags: ['catalogo', categoria ? `categoria:${categoria}` : 'vitrine'], timeoutMs: 12000 },
    );
    const itens = (r?.itens ?? []).map(mapPeca);
    return { itens, total: r?.total ?? itens.length, totalPages: r?.totalPages ?? 1 };
  } catch {
    return null;
  }
}

export async function fetchVitrine(
  opcoes: { ordenar?: OrdemVitrine; limite?: number; revalidate?: number } = {},
): Promise<Product[]> {
  const { ordenar = 'relevancia', limite = 12, revalidate = 600 } = opcoes;

  const params = new URLSearchParams({
    perPage: String(limite),
    ordenar,
    // A home NUNCA mostra esgotado: ali a peça é isca, e isca sem estoque
    // gasta o clique. Na listagem o esgotado aparece riscado (item 37) porque
    // lá a cliente já está procurando aquilo especificamente.
    disponivel: '1',
  });

  try {
    const r = await api<{ itens: PecaApi[] }>(`/public/loja/produtos?${params.toString()}`, {
      revalidate,
      tags: ['catalogo', 'vitrine'],
      timeoutMs: 12000,
    });
    return (r?.itens ?? []).map(mapPeca);
  } catch {
    // Catálogo fora do ar não derruba a home — a seção simplesmente não sai.
    return [];
  }
}
