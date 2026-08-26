import 'server-only';
import { api } from '@/lib/api';
import { mapPecasDaVitrine, type PecaApi } from '@/services/products';
import type { Product } from '@/types';

/**
 * COLEÇÕES DO SITE — a vaga de coleção do menu deixou de ser fixa (dono,
 * 26/08/2026): "trocar a Mais Top da Semana por coleção mais pontual — ex.:
 * os produtos da JOIN que chegaram esta semana viram Coleção Resort".
 *
 * A retaguarda (`/retaguarda/colecoes`) cria a coleção, cura a lista e marca
 * quem ocupa o menu. Aqui o site só consome: o menu pergunta quais coleções
 * saem (`fetchColecoesMenu`) e a página `/colecao/<slug>` pede o conteúdo
 * (`fetchColecao`). A "Mais Top da Semana" continua sendo uma coleção — a
 * única com rota histórica própria (`/mais-top-da-semana`).
 */

/** 60 s — o mesmo TTL do resto da vitrine (ver `REVALIDATE_VITRINE`). */
const REVALIDATE = 60;

export interface ColecaoMenuItem {
  slug: string;
  nome: string;
  href: string;
}

/**
 * As coleções que ocupam a vaga do menu. O backend já filtra: só as marcadas
 * "no menu" E com peça no ar (item de menu pra vitrine vazia não sai).
 *
 * `null` ≠ lista vazia, e a diferença importa: `null` é "não consegui
 * perguntar" — o menu mantém o item estático de sempre (navegação nunca
 * depende do backend pra existir). Lista vazia é resposta: o dono tirou todas
 * do menu, e o item some de propósito.
 */
export async function fetchColecoesMenu(): Promise<ColecaoMenuItem[] | null> {
  try {
    const r = await api<Array<{ slug: string; nome: string; qtd: number }>>(
      '/public/loja/colecoes-menu',
      { revalidate: REVALIDATE, tags: ['colecoes-menu'], timeoutMs: 8000 },
    );
    if (!Array.isArray(r)) return null;
    return r
      .filter((c) => c?.slug && c?.nome)
      .map((c) => ({
        slug: c.slug,
        nome: c.nome,
        // A fixa mantém a rota histórica (16 dias de Google e links por aí);
        // as pontuais vivem na página genérica.
        href: c.slug === 'mais-top-da-semana' ? '/mais-top-da-semana' : `/colecao/${c.slug}`,
      }));
  } catch {
    return null;
  }
}

export interface ColecaoPagina {
  slug: string;
  nome: string;
  descricao: string | null;
  produtos: Product[];
}

/**
 * O conteúdo de UMA coleção, na ordem da curadoria — mesmo contrato da
 * "Mais Top da Semana": não reordena, não pagina. `null` = não existe (404).
 */
export async function fetchColecao(slug: string): Promise<ColecaoPagina | null> {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return null;
  try {
    const r = await api<{ slug: string; nome: string; descricao: string | null; itens: PecaApi[] }>(
      `/public/loja/colecao/${encodeURIComponent(s)}`,
      { revalidate: REVALIDATE, tags: ['catalogo', `curadoria:${s}`], timeoutMs: 12000 },
    );
    if (!r?.slug) return null;
    return {
      slug: r.slug,
      nome: r.nome || s,
      descricao: r.descricao ?? null,
      produtos: mapPecasDaVitrine(r.itens ?? []),
    };
  } catch {
    // 404 do backend (coleção apagada) e backend fora do ar caem juntos no
    // not-found — com revalidate de 60s, um soluço vira página de novo em 1min.
    return null;
  }
}
