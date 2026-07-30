'use client';

import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { SearchX, SlidersHorizontal } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ProductGridSkeleton } from '@/components/ui/Skeleton';
import { Pagination } from '@/components/navigation/Pagination';
import { FilterPanel } from './FilterPanel';
import { SmartBar } from './SmartBar';
import { EditorialProductGrid, type GridInterruption } from './EditorialProductGrid';
import { useProductFilters } from '@/hooks/useProductFilters';
import { useDebounced, useIntersection } from '@/hooks';
import { fetchProducts, filterGroups } from '@/services/products';
import type { Product } from '@/types';

const PER_PAGE = 12;

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
export function CategoryListing({
  category,
  categoryName,
  interruptions = [],
  mode = 'infinite',
}: {
  category: string;
  categoryName: string;
  interruptions?: GridInterruption[];
  mode?: 'infinite' | 'pages';
}) {
  const state = useProductFilters();
  const [view, setView] = useState<'editorial' | 'grid'>('editorial');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounced(state.search, 250);

  const groups = useMemo(() => filterGroups(category), [category]);

  // Filtro/ordenação novos → volta pra primeira página.
  useEffect(() => {
    setPage(1);
  }, [state.filters, state.sort, debouncedSearch]);

  const query = useInfiniteQuery({
    queryKey: ['products', category, state.filters, state.sort, debouncedSearch],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      fetchProducts({
        category,
        search: debouncedSearch,
        sort: state.sort,
        filters: state.filters,
        page: pageParam,
        perPage: PER_PAGE,
      }),
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  });

  const pagesLoaded = query.data?.pages ?? [];
  const total = pagesLoaded[0]?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const products: Product[] =
    mode === 'infinite'
      ? pagesLoaded.flatMap((p) => p.items)
      : (pagesLoaded.find((p) => p.page === page)?.items ?? []);

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
        onViewChange={setView}
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
          {query.isLoading ? (
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
