import { mapPeca, type PecaApi } from './products';
import type { Product } from '@/types';

/**
 * FEED DE DESCOBERTA DA PDP — "a página não acaba".
 *
 * A ordem NÃO é decidida aqui: quem monta a sequência (resto da subcategoria →
 * resto da categoria → as outras categorias, na ordem do menu) é o backend, em
 * cima do catálogo inteiro. Só ele consegue garantir que a página 7 não repita
 * o que a página 1 mostrou.
 *
 * Cada item vem com o TRECHO de onde saiu (`contexto`), e é isso que permite
 * ao feed escrever "Vestidos" no meio do rolo em vez de emendar as categorias
 * sem aviso.
 */

/** De que trecho da sequência a peça veio. */
export interface TrechoDoFeed {
  /** Chave estável do trecho ("sub:regatas", "cat:vestidos"). */
  grupo: string;
  /** O que a cliente lê ("Regatas", "Mais em Blusas", "Vestidos"). */
  rotulo: string;
  tipo: 'subcategoria' | 'categoria' | 'outra-categoria';
}

export interface ItemDoFeed {
  product: Product;
  trecho: TrechoDoFeed;
}

export interface PaginaDoFeed {
  items: ItemDoFeed[];
  total: number;
  page: number;
  hasMore: boolean;
}

const VAZIA = (page: number): PaginaDoFeed => ({ items: [], total: 0, page, hasMore: false });

export async function fetchDescobrir({
  slug,
  page = 1,
  perPage = 12,
}: {
  slug: string;
  page?: number;
  perPage?: number;
}): Promise<PaginaDoFeed> {
  const params = new URLSearchParams({ slug, page: String(page), perPage: String(perPage) });

  try {
    const resposta = await fetch(`/api/loja/descobrir?${params.toString()}`);
    if (!resposta.ok) {
      // Catálogo fora do ar não pode quebrar a PDP: o feed some, a peça fica.
      console.error('[descobrir] falha ao listar', resposta.status);
      return VAZIA(page);
    }
    const dados = await resposta.json();
    const itens: Array<PecaApi & { contexto?: TrechoDoFeed }> = dados.itens ?? [];

    return {
      items: itens.map((item) => ({
        product: mapPeca(item),
        trecho: item.contexto ?? { grupo: 'catalogo', rotulo: '', tipo: 'outra-categoria' },
      })),
      total: dados.total ?? itens.length,
      page: dados.page ?? page,
      hasMore: (dados.page ?? page) < (dados.totalPages ?? 1),
    };
  } catch (error) {
    console.error('[descobrir] feed indisponível:', error);
    return VAZIA(page);
  }
}
