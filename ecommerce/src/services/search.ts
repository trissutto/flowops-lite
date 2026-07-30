import { navigation } from '@/data/navigation';
import { normalize } from '@/lib/utils';
import type { SearchResult, SearchResultKind } from '@/types';

/**
 * SERVIÇO DE BUSCA
 *
 * Hoje resolve localmente sobre a árvore de navegação + sinônimos que a
 * cliente realmente digita ("roupa igreja", "vestido casamento"). A assinatura
 * já é assíncrona e paginável, então trocar por chamada de API (Algolia,
 * Typesense ou endpoint do FlowOps) não muda nenhum componente.
 *
 * Ver docs/search.md.
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
