/**
 * MOTOR DE RECOMENDAÇÃO — client-side, contra o contrato de
 * `lib/search/types.ts` (RecommendationRequest → Product[]).
 *
 * Cada `kind` tem uma estratégia HONESTA sobre o dado que existe hoje:
 *
 *   voce-tambem-pode-gostar — relacionados do backend (BFF /api/loja/relacionados).
 *   complete-seu-look       — categorias COMPLEMENTARES à do seed (mapa abaixo).
 *   quem-viu-tambem-comprou — heurística: mesma categoria, preço ±30%, sem o
 *                             seed. NÃO é comportamento real de compra — vira
 *                             quando os pedidos do checkout alimentarem uma
 *                             matriz de co-ocorrência no backend. A UI não
 *                             muda quando isso acontecer: só este arquivo.
 *   ultimos-vistos          — memória local (recently-viewed.ts).
 *   favoritos               — wishlist store resolvida no catálogo vivo.
 *
 * Regras que valem pra TODOS os kinds:
 *   - seed(s) nunca aparecem no resultado;
 *   - dedup por id;
 *   - falha de rede/parse → [] (o rail some; a página NUNCA quebra).
 */

import { mapPeca } from '@/services/products';
import { normalize } from '@/lib/utils';
import { useWishlistStore } from '@/store/wishlist';
import { getRecentlyViewed, type RecentlyViewedItem } from './recently-viewed';
import { getPersonalizationContext } from './personalization';
import type { PersonalizationContext, RecommendationRequest } from '@/lib/search/types';
import type { Product } from '@/types';

const DEFAULT_LIMIT = 8;

/** Shape cru do backend — o mesmo que `mapPeca` traduz pro site. */
type PecaApi = Parameters<typeof mapPeca>[0];

/* ────────────────────────────────────────────────────────────────────────────
 * Mapa de complementos — DADO, não código
 * ────────────────────────────────────────────────────────────────────────────
 * Categorias REAIS do catálogo (ver CATEGORY_SLUGS em services/products):
 * vestidos · blusas · calcas · conjuntos · macacoes · jaquetas · saias ·
 * shorts · moda-praia · fitness.
 *
 * A lógica de "completa o look": peça de baixo pede peça de cima (e
 * vice-versa); peça única (vestido, macacão, conjunto) pede terceira peça
 * (jaqueta/casaqueto). A ordem importa — o primeiro complemento domina o
 * rail. Quando o catálogo ganhar acessórios/calçados, é SÓ editar este mapa.
 */
const COMPLEMENTOS: Record<string, string[]> = {
  vestidos: ['jaquetas'],
  macacoes: ['jaquetas'],
  conjuntos: ['jaquetas'],
  blusas: ['calcas', 'saias'],
  calcas: ['blusas', 'jaquetas'],
  saias: ['blusas'],
  shorts: ['blusas'],
  jaquetas: ['vestidos', 'calcas'],
  'moda-praia': ['shorts', 'vestidos'], // saída de praia
  fitness: ['fitness'], // top pede legging e vice-versa — o complemento é interno
};

/* ────────────────────────────────────────────────────────────────────────────
 * Acesso ao catálogo (sempre via BFF — nunca direto no backend)
 * ──────────────────────────────────────────────────────────────────────────── */

/** GET defensivo: qualquer falha (rede, status, JSON inválido) vira null. */
async function fetchJson(url: string): Promise<unknown> {
  try {
    const resposta = await fetch(url);
    if (!resposta.ok) return null;
    return await resposta.json();
  } catch {
    return null;
  }
}

/** Resposta do BFF → Product[]. Aceita `{ itens }` ou array cru. */
function pecasDe(dados: unknown): Product[] {
  if (!dados) return [];
  const itens = Array.isArray(dados)
    ? dados
    : ((dados as { itens?: unknown[] }).itens ?? []);
  try {
    return (itens as PecaApi[]).map(mapPeca);
  } catch {
    // Shape inesperado do backend não pode quebrar o rail.
    return [];
  }
}

async function buscarProdutos(params: Record<string, string>): Promise<Product[]> {
  const query = new URLSearchParams(params);
  return pecasDe(await fetchJson(`/api/loja/produtos?${query.toString()}`));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Estratégias por kind
 * ──────────────────────────────────────────────────────────────────────────── */

async function relacionados(seed: Product, limit: number): Promise<Product[]> {
  return pecasDe(
    await fetchJson(
      `/api/loja/relacionados?slug=${encodeURIComponent(seed.slug)}&limite=${limit}`,
    ),
  );
}

async function completeSeuLook(
  seeds: Product[],
  limit: number,
  ctx: PersonalizationContext,
): Promise<Product[]> {
  // Complementos de todos os seeds (carrinho inteiro), sem repetir e sem
  // recomendar a categoria que a cliente já tem na mão.
  const categoriasSeeds = new Set(seeds.map((s) => normalize(s.category)));
  const complementos: string[] = [];
  for (const seed of seeds) {
    for (const cat of COMPLEMENTOS[normalize(seed.category)] ?? []) {
      if (!complementos.includes(cat) && (!categoriasSeeds.has(cat) || cat === normalize(seed.category))) {
        complementos.push(cat);
      }
    }
  }
  if (complementos.length === 0) return []; // categoria sem mapa → rail some (honesto)

  // Personalização: complemento que a visitante já demonstrou gostar vem
  // primeiro — mesmo dado, ordem melhor.
  complementos.sort((a, b) => {
    const ia = ctx.topCategories.indexOf(a);
    const ib = ctx.topCategories.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const listas = await Promise.all(
    complementos.map((categoria) =>
      buscarProdutos({ categoria, ordenar: 'relevancia', perPage: String(limit), page: '1' }),
    ),
  );

  // Intercala as categorias (round-robin) pro rail não virar um bloco só de
  // jaquetas seguido de um bloco só de calças.
  const resultado: Product[] = [];
  const maior = Math.max(...listas.map((l) => l.length), 0);
  for (let i = 0; i < maior; i++) {
    for (const lista of listas) {
      if (lista[i]) resultado.push(lista[i]);
    }
  }
  return resultado;
}

/**
 * HEURÍSTICA HONESTA: ainda não existe dado de pedidos ligado ao catálogo do
 * site, então "quem viu também comprou" aproxima por mesma categoria + faixa
 * de preço ±30% (quem compra vestido de R$ 200 não está olhando o de R$ 600).
 * Quando o checkout acumular pedidos, o backend ganha a matriz de
 * co-ocorrência real e esta função troca a query — assinatura intacta.
 */
async function quemViuTambemComprou(seed: Product, limit: number): Promise<Product[]> {
  const precoMin = Math.max(0, Math.floor(seed.price * 0.7));
  const precoMax = Math.ceil(seed.price * 1.3);
  return buscarProdutos({
    categoria: seed.category,
    precoMin: String(precoMin),
    precoMax: String(precoMax),
    ordenar: 'relevancia',
    // Folga de 4: o próprio seed e vizinhos repetidos ainda vão ser cortados.
    perPage: String(limit + 4),
    page: '1',
  });
}

/**
 * Últimos vistos viram `Product` "stub": o rail só precisa de foto, nome e
 * preço — não vale uma rajada de requests pra rehidratar peça por peça.
 * O clique leva pra página do produto, onde tudo é fresco.
 */
function stubDeVisto(item: RecentlyViewedItem): Product {
  return {
    id: item.id,
    slug: item.slug,
    name: item.name,
    category: '',
    price: item.price,
    images: [{ src: item.image, alt: item.name }],
    sizes: [],
  };
}

/**
 * Favoritos: ids do wishlist store resolvidos no catálogo vivo (preço e
 * estoque atuais — favorito esgotado não deve parecer disponível).
 * LIMITAÇÃO CONHECIDA: `/api/loja/produtos` ainda não filtra por ids, então
 * varremos a primeira página grande e filtramos aqui. Quando o backend
 * ganhar `?refs=`, esta função vira uma query exata — assinatura intacta.
 */
async function favoritos(): Promise<Product[]> {
  const ids = useWishlistStore.getState().ids;
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  const catalogo = await buscarProdutos({ perPage: '100', page: '1', ordenar: 'relevancia' });
  const achados = catalogo.filter((p) => idSet.has(p.id));
  // Mantém a ordem em que a cliente favoritou, não a ordem do catálogo.
  return [...achados].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Entrada única
 * ──────────────────────────────────────────────────────────────────────────── */

export async function getRecommendations(req: RecommendationRequest): Promise<Product[]> {
  const limit = req.limit ?? DEFAULT_LIMIT;
  const seeds = [...(req.seeds ?? []), ...(req.seed ? [req.seed] : [])];
  const idsExcluidos = new Set(seeds.map((s) => s.id));

  try {
    let candidatos: Product[] = [];

    switch (req.kind) {
      case 'voce-tambem-pode-gostar':
        if (!seeds[0]) return [];
        candidatos = await relacionados(seeds[0], limit);
        break;

      case 'complete-seu-look':
        if (seeds.length === 0) return [];
        candidatos = await completeSeuLook(
          seeds,
          limit,
          req.personalization ?? getPersonalizationContext(),
        );
        break;

      case 'quem-viu-tambem-comprou':
        if (!seeds[0]) return [];
        candidatos = await quemViuTambemComprou(seeds[0], limit);
        break;

      case 'ultimos-vistos':
        candidatos = getRecentlyViewed().map(stubDeVisto);
        break;

      case 'favoritos':
        candidatos = await favoritos();
        break;
    }

    // Regra universal: nunca recomendar o que a cliente já está vendo, nunca
    // repetir peça no mesmo rail.
    const vistos = new Set<string>();
    const resultado: Product[] = [];
    for (const produto of candidatos) {
      if (idsExcluidos.has(produto.id) || vistos.has(produto.id)) continue;
      vistos.add(produto.id);
      resultado.push(produto);
      if (resultado.length >= limit) break;
    }
    return resultado;
  } catch {
    // Qualquer coisa que escapou das defesas internas: rail some, página fica.
    return [];
  }
}
