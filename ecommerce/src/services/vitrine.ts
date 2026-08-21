import 'server-only';
import { api } from '@/lib/api';
import { mapPecasDaVitrine, type PecaApi } from '@/services/products';
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
 * 60 s, não 10 min (dono, 13/08: "o estoque tem q ser em tempo real").
 *
 * Card de vitrine carrega estoque: é ele que decide o risco "esgotado" e se a
 * peça sequer aparece na home (`disponivel: '1'`). Com 600 s, uma peça vendida
 * na loja física continuava sendo isca por dez minutos.
 *
 * 60 s é o número certo por um motivo, não por gosto: é o MESMO TTL do cache
 * de catálogo do backend (`TTL_CATALOGO` em `loja-catalog.service.ts`). Pedir
 * mais rápido que isso não traria dado mais novo — só bateria no mesmo cache.
 * As duas pontas têm que andar juntas: mexeu numa, mexa na outra.
 */
const REVALIDATE_VITRINE = 60;

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
  /** Segundo nível da árvore: 'manga-curta' dentro de 'blusas'. */
  subcategoria?: string;
  /** Numeração (`/tamanhos/58`) — o backend casa a grade, então "46/48" entra nos dois. */
  tamanho?: string;
  ordenar?: OrdemVitrine;
  perPage?: number;
  precoMax?: number;
  soPromocao?: boolean;
  revalidate?: number;
}): Promise<{ itens: Product[]; total: number; totalPages: number } | null> {
  const { categoria, subcategoria, tamanho, ordenar = 'relevancia', perPage = 24, precoMax, soPromocao, revalidate = REVALIDATE_VITRINE } = opcoes;
  const params = new URLSearchParams({ page: '1', perPage: String(perPage), ordenar });
  if (categoria) params.set('categoria', categoria);
  if (subcategoria) params.set('subcategoria', subcategoria);
  if (tamanho) params.set('tamanho', tamanho);
  if (precoMax) params.set('precoMax', String(precoMax));
  // O controller (loja-catalog.controller.ts) lê a chave "promocao", não
  // "soPromocao" — bug real, 07/08: o Outlet mandava o parâmetro errado e o
  // filtro nunca aplicava (a página listava o catálogo inteiro).
  if (soPromocao) params.set('promocao', '1');

  try {
    const r = await api<{ itens: PecaApi[]; total?: number; totalPages?: number }>(
      `/public/loja/produtos?${params.toString()}`,
      { revalidate, tags: ['catalogo', categoria ? `categoria:${categoria}` : 'vitrine'], timeoutMs: 12000 },
    );
    const itens = mapPecasDaVitrine(r?.itens ?? []);
    return { itens, total: r?.total ?? itens.length, totalPages: r?.totalPages ?? 1 };
  } catch {
    return null;
  }
}

/**
 * MAIS TOP DA SEMANA — a vitrine CURADA da semana.
 *
 * Diferente de `fetchVitrine`, aqui a ORDEM é a curadoria: o backend já devolve
 * os `itens` na sequência escolhida na retaguarda (o MESMO dado que marca o selo
 * `topSemana` no feed). A página só renderiza na ordem recebida — não reordena,
 * não pagina, não faz scroll infinito.
 *
 * Cai em lista vazia sem quebrar, igual às outras vitrines: sem curadoria
 * publicada a página mostra o estado vazio em vez de erro. O card é o mesmo da
 * vitrine — os `itens` vêm na forma de `PecaApi` e passam pelo `mapPeca`.
 */
export async function fetchMaisTopDaSemana(
  opcoes: { revalidate?: number } = {},
): Promise<Product[]> {
  const { revalidate = REVALIDATE_VITRINE } = opcoes;

  try {
    const r = await api<{ itens: PecaApi[]; total?: number }>(
      '/public/loja/curadoria/mais-top-da-semana',
      { revalidate, tags: ['catalogo', 'curadoria:mais-top-da-semana'], timeoutMs: 12000 },
    );
    // A ordem é a da curadoria — só traduz, não mexe na sequência.
    return mapPecasDaVitrine(r?.itens ?? []);
  } catch {
    // Curadoria fora do ar não derruba a página — vira estado vazio.
    return [];
  }
}

/**
 * OS MAIS VENDIDOS NAS LOJAS — coleção AUTOMÁTICA (dono, 19/08).
 *
 * Irmã da "Mais Top da Semana", mas sem curadoria: o backend ranqueia pelo
 * caixa das lojas físicas e só deixa entrar peça que aguenta a demanda que o
 * selo cria (estoque ≥ 30 e nenhum tamanho zerado). A ordem já vem pronta —
 * 1º lugar primeiro — e muda sozinha conforme venda e reposição.
 */
export async function fetchMaisVendidosNasLojas(
  opcoes: { revalidate?: number } = {},
): Promise<Product[]> {
  const { revalidate = REVALIDATE_VITRINE } = opcoes;

  try {
    const r = await api<{ itens: PecaApi[]; total?: number }>(
      '/public/loja/mais-vendidos-lojas',
      { revalidate, tags: ['catalogo', 'mais-vendidos-lojas'], timeoutMs: 12000 },
    );
    return mapPecasDaVitrine(r?.itens ?? []);
  } catch {
    // Ranking fora do ar não derruba a página — vira estado vazio.
    return [];
  }
}

export async function fetchVitrine(
  opcoes: {
    ordenar?: OrdemVitrine;
    limite?: number;
    revalidate?: number;
    /** Slug da categoria — vitrine de "Blusas", "Vestidos" etc. na home. */
    categoria?: string;
    /** Só peça NOVA de verdade (≤30d da 1ª venda) — o carrossel "Novidades" da home usa. */
    soNovidade?: boolean;
  } = {},
): Promise<Product[]> {
  const { ordenar = 'relevancia', limite = 12, revalidate = REVALIDATE_VITRINE, categoria, soNovidade } = opcoes;

  const params = new URLSearchParams({
    perPage: String(limite),
    ordenar,
    // A home NUNCA mostra esgotado: ali a peça é isca, e isca sem estoque
    // gasta o clique. Na listagem o esgotado aparece riscado (item 37) porque
    // lá a cliente já está procurando aquilo especificamente.
    disponivel: '1',
  });
  if (categoria) params.set('categoria', categoria);
  if (soNovidade) params.set('novidade', '1');

  try {
    const r = await api<{ itens: PecaApi[] }>(`/public/loja/produtos?${params.toString()}`, {
      revalidate,
      tags: ['catalogo', categoria ? `categoria:${categoria}` : 'vitrine'],
      timeoutMs: 12000,
    });
    return mapPecasDaVitrine(r?.itens ?? []);
  } catch {
    // Catálogo fora do ar não derruba a home — a seção simplesmente não sai.
    return [];
  }
}
