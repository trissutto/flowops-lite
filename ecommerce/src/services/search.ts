import { navigation } from '@/data/navigation';
import { normalize } from '@/lib/utils';
import {
  createSearchIndex,
  FALLBACK_SUGGESTIONS,
  heuristicInterpreter,
  rankSearch,
  type SearchOutcome,
} from '@/lib/search';
import { mapPeca } from '@/services/products';
import type { Product, SearchResult, SearchResultKind } from '@/types';

/**
 * SERVIÇO DE BUSCA
 *
 * Duas camadas que CONVIVEM (uma não substitui a outra):
 *
 *   `search()`         — índice NAVEGACIONAL: categorias, ocasiões, coleções e
 *                        páginas do site. Resolve local, síncrono na prática,
 *                        e é o fallback permanente quando o catálogo falha.
 *   `searchProducts()` — busca de PRODUTO de verdade: interpreta a intenção
 *                        (sprint 008), pede um recorte generoso ao BFF e
 *                        ranqueia no client com o motor de `@/lib/search`.
 *
 * A assinatura de tudo aqui é assíncrona de propósito: trocar qualquer camada
 * por chamada de API (Algolia, Typesense, endpoint do FlowOps) não muda
 * nenhum componente. Ver docs/search.md.
 */

/** Sinônimos → destino. A cliente não busca pelo nome da categoria do ERP. */
const INTENT_MAP: { terms: string[]; result: SearchResult }[] = [
  {
    terms: ['vestido preto', 'preto', 'vestido escuro'],
    result: { kind: 'produto', label: 'Vestidos preto', href: '/categoria/vestidos?cor=preto', meta: 'Categoria · Vestidos' },
  },
  {
    terms: ['vestido casamento', 'casamento', 'madrinha', 'convidada'],
    result: { kind: 'ocasiao', label: 'Vestidos para casamento', href: '/ocasioes/casamento', meta: 'Ocasião' },
  },
  {
    terms: ['roupa igreja', 'igreja', 'culto', 'missa'],
    result: { kind: 'ocasiao', label: 'Looks para igreja', href: '/ocasioes/igreja', meta: 'Ocasião' },
  },
  {
    terms: ['roupa elegante', 'elegante', 'social', 'sofisticado'],
    result: { kind: 'colecao', label: 'Alfaiataria Lurds', href: '/colecoes/alfaiataria', meta: 'Coleção' },
  },
  {
    terms: ['look trabalho', 'trabalho', 'escritorio', 'executivo'],
    result: { kind: 'look', label: 'Look trabalho', href: '/looks/trabalho', meta: 'Look completo' },
  },
  {
    terms: ['look festa', 'festa', 'balada', 'formatura'],
    result: { kind: 'look', label: 'Look festa', href: '/looks/festa', meta: 'Look completo' },
  },
  {
    terms: ['viscolycra', 'visco', 'viscolycra premium'],
    result: { kind: 'categoria', label: 'Viscolycra premium', href: '/tecidos/viscolycra-premium', meta: 'Tecido' },
  },
  {
    terms: ['comprar e retirar', 'retirar na loja', 'retirada'],
    result: { kind: 'loja', label: 'Comprar e retirar na loja', href: '/lojas/comprar-e-retirar', meta: 'Lojas' },
  },
  {
    terms: ['tabela de medidas', 'meu tamanho', 'numeracao', 'medidas'],
    result: { kind: 'categoria', label: 'Guia de medidas', href: '/tamanhos/guia', meta: 'Ajuda' },
  },
];

/** Índice achatado da navegação — cada link vira um resultado buscável. */
function navigationIndex(): SearchResult[] {
  const kindByAxis: Record<string, SearchResultKind> = {
    '/looks': 'look',
    '/ocasioes': 'ocasiao',
    '/colecoes': 'colecao',
    '/lojas': 'loja',
    '/categoria': 'categoria',
    '/tecidos': 'categoria',
    '/tamanhos': 'categoria',
    '/novidades': 'categoria',
  };

  return navigation.flatMap((item) => {
    const kind = kindByAxis[item.href] ?? 'categoria';
    const own: SearchResult = { kind, label: item.label, href: item.href };
    const children = (item.menu?.columns ?? []).flatMap((column) =>
      column.links.map<SearchResult>((link) => ({
        kind,
        label: link.label,
        href: link.href,
        meta: column.title.trim() ? `${item.label} · ${column.title}` : item.label,
      })),
    );
    return [own, ...children];
  });
}

const INDEX = navigationIndex();

export interface SearchResponse {
  results: SearchResult[];
  /** Termo normalizado que gerou a resposta (para destacar no UI). */
  query: string;
}

/**
 * Busca por termo. Ordem de relevância:
 * 1. intenção (sinônimo exato/contido)
 * 2. label começa com o termo
 * 3. label contém o termo
 */
export async function search(rawQuery: string, limit = 8): Promise<SearchResponse> {
  const query = normalize(rawQuery);
  if (query.length < 2) return { results: [], query };

  const intents = INTENT_MAP.filter((entry) =>
    entry.terms.some((term) => normalize(term).includes(query) || query.includes(normalize(term))),
  ).map((entry) => entry.result);

  const startsWith: SearchResult[] = [];
  const contains: SearchResult[] = [];

  for (const item of INDEX) {
    const label = normalize(item.label);
    if (label.startsWith(query)) startsWith.push(item);
    else if (label.includes(query)) contains.push(item);
  }

  const seen = new Set<string>();
  const results = [...intents, ...startsWith, ...contains].filter((item) => {
    if (seen.has(item.href)) return false;
    seen.add(item.href);
    return true;
  });

  return { results: results.slice(0, limit), query };
}

/* --------------------------------------------------- Histórico de pesquisas */

const RECENT_KEY = 'lurds-recent-searches';
const RECENT_MAX = 6;

export function getRecentSearches(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function pushRecentSearch(term: string): void {
  if (typeof window === 'undefined' || term.trim().length < 2) return;
  try {
    const next = [term, ...getRecentSearches().filter((t) => t !== term)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* localStorage indisponível (modo privado) — histórico é opcional */
  }
}

export function clearRecentSearches(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(RECENT_KEY);
  } catch {
    /* idem */
  }
}

/* ------------------------------------------------------ Métricas de busca */

/**
 * Telemetria própria (além do GA/Meta): alimenta /debug/search com top
 * termos, zero-results e CTR. Fire-and-forget SEMPRE — sendBeacon quando
 * existe (sobrevive à navegação), fetch keepalive como plano B, e qualquer
 * falha morre em silêncio. Métrica JAMAIS bloqueia ou quebra a busca.
 */
const METRICS_URL = '/api/search-metrics';

function postMetric(body: { term: string; results?: number; clicked?: boolean }): void {
  if (typeof window === 'undefined') return;
  try {
    const json = JSON.stringify(body);
    if (navigator.sendBeacon?.(METRICS_URL, new Blob([json], { type: 'application/json' }))) return;
    void fetch(METRICS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* telemetria é opcional por definição */
  }
}

// Autocomplete dispara uma busca por pausa de digitação — reportar duas vezes
// o MESMO termo com o MESMO resultado só inflaria o volume no painel.
let lastReported = '';

function reportSearch(term: string, results: number): void {
  const key = `${normalize(term)}::${results}`;
  if (key === lastReported) return;
  lastReported = key;
  postMetric({ term, results });
}

/** Chamar no clique de um resultado — é o numerador do CTR do painel. */
export function reportSearchClicked(term: string): void {
  if (term.trim().length < 2) return;
  postMetric({ term, clicked: true });
}

/* ----------------------------------------------------- Busca de produtos */

/**
 * Busca de produto com intenção: "vestido preto pra festa até 200" vira
 * filtros que o BFF entende + residual textual, e o resultado volta ranqueado
 * pelo motor (relevância + merchandising + escada anti-vazio).
 *
 * Pedimos `limit * 2` ao BFF de propósito: o motor re-ranqueia e relaxa no
 * client, então um recorte maior dá material pra escada trabalhar sem uma
 * segunda viagem à rede.
 *
 * FALHA DO BFF NUNCA QUEBRA A BUSCA: devolve outcome vazio marcado como
 * `relaxed` com sugestões — a UI segue de pé com o índice navegacional
 * (`search()`), que resolve local e não depende de rede.
 */
export async function searchProducts(term: string, limit = 24): Promise<SearchOutcome> {
  const intent = heuristicInterpreter.interpret(term);

  const params = new URLSearchParams({
    ordenar: 'relevancia',
    page: '1',
    perPage: String(Math.min(limit * 2, 60)),
  });
  // Facetas que o BFF entende viram filtro no SERVIDOR (menos tráfego);
  // o que ele não entende (ocasião, tecido, atributos) o motor pontua aqui.
  const residual = intent.residual.trim();
  if (residual.length >= 2) params.set('busca', residual);
  if (intent.facets.category) params.set('categoria', intent.facets.category);
  if (intent.facets.color) params.set('cor', intent.facets.color);
  if (intent.facets.fit) params.set('modelagem', intent.facets.fit);
  if (intent.facets.priceMax !== undefined) params.set('precoMax', String(intent.facets.priceMax));

  try {
    const resposta = await fetch(`/api/loja/produtos?${params.toString()}`);
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    const dados = await resposta.json();
    const produtos: Product[] = (dados.itens ?? []).map(mapPeca);

    const outcome = rankSearch(createSearchIndex(produtos), { term, limit });
    reportSearch(term, outcome.results.length);
    return outcome;
  } catch (error) {
    console.error('[busca] catálogo indisponível, degradando pro índice navegacional', error);
    reportSearch(term, 0);
    return { results: [], intent, relaxed: true, suggestions: FALLBACK_SUGGESTIONS.slice(0, 4) };
  }
}

/* ----------------------------------------------------- Produtos populares */

/**
 * Vitrine do estado vazio (overlay) e do zero-results (página de busca).
 * UMA chamada por sessão de página: cache em memória de módulo, com a
 * promise guardada pra colapsar chamadas concorrentes (dois consumidores
 * abrindo ao mesmo tempo não duplicam a viagem).
 */
let popularCache: Product[] | null = null;
let popularInflight: Promise<Product[]> | null = null;

export async function fetchPopularProducts(): Promise<Product[]> {
  if (popularCache) return popularCache;
  popularInflight ??= (async () => {
    try {
      const resposta = await fetch('/api/loja/produtos?ordenar=relevancia&perPage=4&page=1');
      if (!resposta.ok) return [];
      const dados = await resposta.json();
      popularCache = ((dados.itens ?? []) as Parameters<typeof mapPeca>[0][]).map(mapPeca);
      return popularCache;
    } catch {
      // Sem populares não é erro de UX — a seção simplesmente não aparece.
      return [];
    } finally {
      popularInflight = null;
    }
  })();
  return popularInflight;
}
