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
