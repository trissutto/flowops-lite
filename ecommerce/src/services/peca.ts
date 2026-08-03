import 'server-only';
import { api } from '@/lib/api';
import { mapPeca, type CorApi, type PecaApi } from '@/services/products';
import type { Product } from '@/types';

/**
 * PEÇA COMPLETA — o caminho novo da página de produto.
 *
 * A página do site é UMA por REF: as cores são variação escolhível ali mesmo,
 * não páginas separadas. Este endpoint devolve, POR COR, as fotos, a grade com
 * estoque e o preço — que é o que a PDP precisa pra trocar galeria, tamanhos e
 * preço no clique da bolinha.
 *
 * Fica separado de `services/products.ts` porque aquele roda no NAVEGADOR
 * (fetch relativo pro BFF) e `lib/api` é server-only — juntar os dois quebra
 * o build do client.
 *
 * Devolve `null` sem explodir quando o backend está fora ou a peça não está
 * publicada: a PDP cai no caminho antigo enquanto a migração de conteúdo do
 * WooCommerce não termina.
 */

export interface PecaDoSite {
  product: Product;
  cores: CorApi[];
  descricao: string;
  descricaoCurta: string;
}

export async function fetchPeca(slug: string): Promise<PecaDoSite | null> {
  try {
    const p = await api<PecaApi>(`/public/loja/produto/${encodeURIComponent(slug)}`, {
      revalidate: 120,
      tags: ['catalogo', `produto:${slug}`],
      timeoutMs: 12000,
    });
    if (!p?.slug) return null;
    return {
      product: mapPeca(p),
      cores: p.cores ?? [],
      descricao: p.descricaoCompleta ?? '',
      descricaoCurta: p.descricaoCurta ?? '',
    };
  } catch {
    return null;
  }
}
