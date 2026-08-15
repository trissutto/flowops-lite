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
  /** [{rotulo,valor}] — forro, transparência, decote, manga, comprimento. */
  fichaTecnica: Array<{ rotulo: string; valor: string }>;
  /** Peças da família já vendidas (loja + site + histórico do ERP antigo). */
  vendas: number;
  /** As peças que saem na mesma foto — ver `PecaApi['look']`. */
  look: PecaApi['look'];
  editorIdentity: { ref: string; marca: string; cor: string | null };
}

export async function fetchPeca(slug: string): Promise<PecaDoSite | null> {
  try {
    /*
     * SEM CACHE (`revalidate: 0`) de propósito — aqui vem a GRADE COM ESTOQUE.
     *
     * Com `revalidate: 120` o Next serve o STALE e revalida em segundo plano:
     * quem abre a página vê o estoque de quando foi a visita ANTERIOR — com o
     * tráfego de agora, horas atrás. Foi assim que o 48 esgotado da VOGUE
     * VINHO ficou comprável a tarde inteira (06/08) enquanto o master dizia 0.
     * O backend lê o Postgres local por REF; uma query por visita é barato.
     */
    const p = await api<PecaApi>(`/public/loja/produto/${encodeURIComponent(slug)}`, {
      revalidate: 0,
      tags: ['catalogo', `produto:${slug}`],
      timeoutMs: 12000,
    });
    if (!p?.slug) return null;
    return {
      product: mapPeca(p),
      cores: p.cores ?? [],
      descricao: p.descricaoCompleta ?? '',
      descricaoCurta: p.descricaoCurta ?? '',
      fichaTecnica: p.fichaTecnica ?? [],
      vendas: Number(p.vendas) || 0,
      look: p.look ?? null,
      editorIdentity: { ref: p.ref, marca: p.marca ?? '', cor: p.cores?.[0]?.nome ?? null },
    };
  } catch {
    return null;
  }
}
