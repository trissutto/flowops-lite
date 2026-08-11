'use client';

import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { SearchX, SlidersHorizontal } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ProductGridSkeleton } from '@/components/ui/Skeleton';
import { Pagination } from '@/components/navigation/Pagination';
import { CatalogQueryProvider } from './CatalogQueryProvider';
import { FilterPanel } from './FilterPanel';
import { SmartBar } from './SmartBar';
import { EditorialProductGrid, type GridInterruption } from './EditorialProductGrid';
import { useProductFilters } from '@/hooks/useProductFilters';
import { useDebounced, useIntersection } from '@/hooks';
import { fetchFacetas, fetchProducts, filterGroups } from '@/services/products';
import type { FilterState, Product, SortOption } from '@/types';

const PER_PAGE = 12;

/**
 * Os filtros da tela ainda são exatamente os que a rota nasceu tendo?
 *
 * Serve pra decidir se a página 1 que veio pronta do servidor ainda responde
 * ao que está na tela. Comparação rasa por chave: os valores aqui são array de
 * string, número ou boolean — nada aninhado.
 */
function mesmoFiltro(atual: FilterState | undefined, inicial: FilterState | undefined): boolean {
  const a = atual ?? {};
  const b = inicial ?? {};
  const chaves = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of chaves) {
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) return false;
  }
  return true;
}

/**
 * LISTAGEM DE CATEGORIA — orquestra barra + filtros + grid + paginação.
 *
 * Paginação: infinite scroll por padrão (sentinela com margem de 400px, então
 * a próxima página já chegou quando a cliente alcança o fim) COM botão
 * "carregar mais" como alternativa acessível — scroll infinito puro deixa
 * quem usa teclado sem saída. A paginação numerada tradicional aparece
 * quando `mode="pages"`; a arquitetura suporta as duas sem reescrever nada.
 *
 * Ver docs/category-page.md.
 */
interface CategoryListingProps {
  /** Vazio = catálogo inteiro (é assim que /novidades reusa esta listagem). */
  category: string;
  /**
   * Subcategoria vinda da URL (`?sub=manga-curta`). Entra na `queryKey` pra
   * a troca de chip refazer a busca — sem isso o react-query devolveria o
   * resultado da subcategoria anterior, em cache.
   */
  subcategoria?: string;
  categoryName: string;
  interruptions?: GridInterruption[];
  mode?: 'infinite' | 'pages';
  /**
   * Ordenação inicial. A cliente continua podendo trocar — isto só decide o
   * que ela vê ao chegar. Sem passar nada, o PADRÃO é 'novidades' (decisão do
   * dono, 07/08: "sempre deixe o primeiro filtro como novidades em todas as
   * telas") — `/categoria/[slug]` caía em 'relevância' por só não ter
   * declarado a prop, e devolvia a mesma ordem crua do banco toda vez.
   */
  ordemPadrao?: SortOption;
  /**
   * Teto de peças da seleção. `/novidades` usa 50 (decisão do dono, 06/08):
   * "novidade" é uma vitrine curada, não o catálogo inteiro reordenado — com
   * 525 peças a 500ª tinha meses de loja e a palavra perdia o sentido.
   *
   * O corte é do lado de cá porque a ORDEM já vem do backend: as 50 primeiras
   * de uma lista ordenada por data SÃO as 50 mais novas.
   */
  limiteTotal?: number;
  /**
   * Teto de preço da vitrine (as faixas "Até R$ 59,90" / "Até R$ 99,90").
   * Vai pra consulta como propriedade da ROTA, não como filtro — ver
   * `ProductQuery.tetoDePreco`.
   */
  tetoDePreco?: number;
  /**
   * PÁGINA 1 JÁ RESOLVIDA NO SERVIDOR (perf, 07/08). Com isto a peça vem no
   * HTML e aparece na hora; sem, a listagem busca no cliente como antes.
   * Só vale enquanto a cliente não mexeu em filtro/ordem/busca — daí em
   * diante é o react-query que manda.
   */
  primeiraPagina?: { itens: Product[]; total: number; totalPages: number } | null;
  /** Só promoção — a rota /outlet usa pra listar tudo que tem desconto. */
  soPromocao?: boolean;
  /**
   * Filtro já aplicado ao abrir — a vitrine por tamanho (/tamanhos/52) chega
   * com o número dela marcado. A cliente continua podendo mexer na barra.
   */
  filtrosIniciais?: FilterState;
}

/**
 * O provider do react-query vive AQUI, colado em quem usa, e não no layout
 * raiz — senão a biblioteca inteira entra no bundle compartilhado de todas as
 * páginas. Ver `CatalogQueryProvider`.
 */
export function CategoryListing(props: CategoryListingProps) {
  return (
    <CatalogQueryProvider>
      <CategoryListingInner {...props} />
    </CatalogQueryProvider>
  );
}

function CategoryListingInner({
  category,
  categoryName,
  interruptions = [],
  mode = 'infinite',
  ordemPadrao = 'novidades',
  limiteTotal,
  tetoDePreco,
  primeiraPagina,
  soPromocao,
  filtrosIniciais,
  subcategoria,
}: CategoryListingProps) {
  const state = useProductFilters(filtrosIniciais ?? {}, ordemPadrao);
  const [view, setView] = useState<'editorial' | 'grid'>('editorial');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounced(state.search, 250);

  useEffect(() => {
    const saved = window.localStorage.getItem('lurds:catalog-view');
    if (saved === 'editorial' || saved === 'grid') setView(saved);
  }, []);

  const changeView = (next: 'editorial' | 'grid') => {
    setView(next);
    window.localStorage.setItem('lurds:catalog-view', next);
  };

  // Facetas do catálogo REAL (cor, tamanho, marca com contagem). Enquanto
  // não chegam, a sidebar usa o esqueleto — nunca fica vazia.
  const { data: facetas } = useQuery({
    queryKey: ['facetas'],
    queryFn: fetchFacetas,
    staleTime: 5 * 60_000,
  });
  const groups = useMemo(() => {
    const base = filterGroups(category, facetas);
    if (!tetoDePreco) return base;
    // Numa vitrine "Até R$ 59,90" o slider não pode ir até R$ 490: oferecer
    // uma faixa que a rota vai ignorar faz a cliente arrastar e achar que o
    // site travou.
    return base.map((g) =>
      g.id === 'preco' && g.range
        ? { ...g, range: { min: g.range.min, max: Math.min(g.range.max, tetoDePreco) } }
        : g,
    );
  }, [category, facetas, tetoDePreco]);

  // Filtro/ordenação novos → volta pra primeira página.
  useEffect(() => {
    setPage(1);
  }, [state.filters, state.sort, debouncedSearch]);

  /**
   * A página 1 do servidor só serve enquanto a cliente não pediu outra coisa.
   * Assim que ela filtra, ordena ou busca, o resultado pronto não corresponde
   * mais ao pedido — e entregar produto errado "rápido" é pior que esperar.
   */
  const semInterferencia =
    // `filtrosIniciais` NÃO conta como interferência: a página do servidor já
    // foi buscada com ele (é o caso de /tamanhos/58, que nasce filtrado). Só
    // desqualifica o que a CLIENTE mexeu depois.
    mesmoFiltro(state.filters, filtrosIniciais) &&
    !debouncedSearch &&
    state.sort === ordemPadrao;

  /**
   * O servidor traz 24 peças de uma vez (uma tela cheia), mas o scroll infinito
   * pagina de 12 em 12. Entregar as 24 como "página 1" fazia o react-query
   * pedir a página 2 de 12 — que são as peças 13 a 24, JÁ NA TELA: a cliente
   * rolava e via a mesma vitrine repetida. Por isso o bloco do servidor é
   * fatiado em páginas de `PER_PAGE` antes de virar `initialData`.
   */
  const paginasIniciais = useMemo(() => {
    if (!primeiraPagina) return null;
    const { itens, total } = primeiraPagina;
    const pages = [];
    for (let i = 0; i < itens.length; i += PER_PAGE) {
      pages.push({
        items: itens.slice(i, i + PER_PAGE),
        total,
        page: i / PER_PAGE + 1,
        perPage: PER_PAGE,
        hasMore: total > i + PER_PAGE,
      });
    }
    if (!pages.length) return null;
    return { pages, pageParams: pages.map((p) => p.page) };
  }, [primeiraPagina]);

  const query = useInfiniteQuery({
    queryKey: ['products', category, subcategoria, state.filters, state.sort, debouncedSearch, tetoDePreco, soPromocao],
    initialPageParam: 1,
    ...(paginasIniciais && semInterferencia ? { initialData: paginasIniciais } : {}),
    queryFn: ({ pageParam }) =>
      fetchProducts({
        category,
        subcategoria,
        search: debouncedSearch,
        sort: state.sort,
        filters: state.filters,
        page: pageParam,
        perPage: PER_PAGE,
        tetoDePreco,
        soPromocao,
      }),
    getNextPageParam: (last, todas) => {
      if (!last.hasMore) return undefined;
      // Chegou no teto da seleção: para de pedir página.
      if (limiteTotal && todas.reduce((n, p) => n + p.items.length, 0) >= limiteTotal) {
        return undefined;
      }
      return last.page + 1;
    },
  });

  const pagesLoaded = query.data?.pages ?? [];
  const totalBruto = pagesLoaded[0]?.total ?? 0;
  // O contador da barra tem que dizer o que a cliente PODE ver: anunciar 525
  // e entregar 50 é a mesma promessa quebrada de um filtro que some com peça.
  const total = limiteTotal ? Math.min(totalBruto, limiteTotal) : totalBruto;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const carregados: Product[] =
    mode === 'infinite'
      ? pagesLoaded.flatMap((p) => p.items)
      : (pagesLoaded.find((p) => p.page === page)?.items ?? []);
  const products = limiteTotal ? carregados.slice(0, limiteTotal) : carregados;

  const sentinelRef = useIntersection(
    () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    mode === 'infinite' && !query.isLoading,
  );

  const isEmpty = !query.isLoading && products.length === 0;

  return (
    <>
      <SmartBar
        total={total}
        state={state}
        view={view}
        onViewChange={changeView}
        onOpenFilters={() => setDrawerOpen(true)}
        categoryName={categoryName}
      />

      <div className="grid gap-10 py-12 lg:grid-cols-[264px_minmax(0,1fr)] lg:gap-14">
        {/* Sidebar (desktop) */}
        <aside className="hidden lg:block" aria-label="Filtros">
          <div className="sticky top-[164px]">
            <div className="flex items-center justify-between pb-2">
              <p className="eyebrow flex items-center gap-2 text-ink">
                <SlidersHorizontal className="size-3.5 text-primary-strong" strokeWidth={1.75} />
                Filtrar
              </p>
              {state.activeCount > 0 && (
                <button
                  type="button"
                  onClick={state.clearAll}
                  className="text-small text-ink-muted underline decoration-border underline-offset-4 transition-colors hover:text-ink"
                >
                  Limpar
                </button>
              )}
            </div>
            <FilterPanel groups={groups} state={state} />
          </div>
        </aside>

        {/* Grid */}
        <div>
          {query.isError ? (
            <EmptyState
              icon={<SearchX strokeWidth={1.5} />}
              title="Não conseguimos carregar as peças."
              description="Sua seleção continua salva. Confira a conexão e tente novamente."
              action={{ label: 'Tentar novamente', onClick: () => void query.refetch() }}
            />
          ) : query.isLoading ? (
            <ProductGridSkeleton count={PER_PAGE} />
          ) : isEmpty ? (
            <EmptyState
              icon={<SearchX strokeWidth={1.5} />}
              title="Nenhuma peça com esses filtros."
              description="Tente soltar um filtro — ou fale com uma consultora: a gente procura no estoque das 14 lojas."
              action={{ label: 'Limpar filtros', onClick: state.clearAll }}
              secondaryAction={{
                label: 'Falar no WhatsApp',
                href: 'https://api.whatsapp.com/send?phone=5513996050174',
              }}
            />
          ) : (
            <>
              <EditorialProductGrid
                products={products}
                interruptions={interruptions}
                view={view}
              />

              {mode === 'infinite' ? (
                <>
                  {query.isFetchingNextPage && (
                    <div className="mt-14">
                      <ProductGridSkeleton count={4} />
                    </div>
                  )}
                  <div ref={sentinelRef} aria-hidden className="h-px" />
                  {query.hasNextPage && (
                    <div className="mt-14 flex justify-center">
                      <Button
                        variant="secondary"
                        size="lg"
                        onClick={() => void query.fetchNextPage()}
                        disabled={query.isFetchingNextPage}
                      >
                        {query.isFetchingNextPage ? 'Carregando…' : 'Carregar mais peças'}
                      </Button>
                    </div>
                  )}
                  {!query.hasNextPage && products.length > PER_PAGE && (
                    <p className="mt-14 text-center text-small text-ink-muted">
                      Você viu todas as {total} peças desta seleção.
                    </p>
                  )}
                </>
              ) : (
                <Pagination
                  page={page}
                  totalPages={totalPages}
                  onChange={(next) => {
                    setPage(next);
                    // Garante que a página pedida já esteja carregada.
                    const loaded = pagesLoaded.some((p) => p.page === next);
                    if (!loaded && query.hasNextPage) void query.fetchNextPage();
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="mt-16"
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Filtros (mobile) */}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        label="Filtros"
        side="left"
        size="sm"
        header={<p className="font-display text-h3">Filtrar</p>}
        footer={
          <div className="flex gap-2.5">
            <Button variant="secondary" block onClick={state.clearAll}>
              Limpar
            </Button>
            <Button block onClick={() => setDrawerOpen(false)}>
              Ver {total} peças
            </Button>
          </div>
        }
      >
        <FilterPanel groups={groups} state={state} />
      </Drawer>
    </>
  );
}
