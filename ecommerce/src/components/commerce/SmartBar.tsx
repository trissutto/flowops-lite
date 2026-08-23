'use client';

import { LayoutGrid, Rows3, Search, SlidersHorizontal, X } from 'lucide-react';
import { Chip } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import { SORT_OPTIONS } from '@/services/products';
import type { SortOption } from '@/types';
import type { UseProductFiltersResult } from '@/hooks/useProductFilters';

/**
 * BARRA INTELIGENTE — a linha de controle da listagem.
 *
 * Mostra: contagem de produtos, busca dentro da categoria, filtros ativos
 * (removíveis), ordenação, alternância de visualização e o botão de filtros
 * do mobile. Fica sticky abaixo do header pra continuar acessível na rolagem.
 */
export function SmartBar({
  total,
  state,
  view,
  onViewChange,
  onOpenFilters,
  categoryName,
}: {
  total: number;
  state: UseProductFiltersResult;
  view: 'editorial' | 'grid';
  onViewChange: (view: 'editorial' | 'grid') => void;
  onOpenFilters: () => void;
  categoryName: string;
}) {
  return (
    <div className="sticky top-14 z-[var(--z-sticky)] border-y border-border bg-background/92 backdrop-blur-md lg:top-[76px]">
      <div className="flex flex-col gap-3 py-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Contagem */}
          <p className="text-small text-ink-soft">
            <span className="tabular font-medium text-ink">{total}</span>{' '}
            {total === 1 ? 'peça' : 'peças'} em{' '}
            <span className="text-ink">{categoryName}</span>
          </p>

          <div className="ml-auto flex items-center gap-2">
            {/* Busca na categoria */}
            <label className="relative hidden sm:block">
              <span className="sr-only">Buscar em {categoryName}</span>
              <Search className="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-primary-strong" />
              <input
                value={state.search}
                onChange={(e) => state.setSearch(e.target.value)}
                placeholder={`Buscar em ${categoryName}…`}
                className="w-52 rounded-pill border border-border bg-surface py-2 pr-3 pl-9 text-small text-ink transition-shadow placeholder:text-ink-muted/70 focus:border-primary focus:shadow-[0_0_0_3px_rgba(184,145,43,0.12)] focus:outline-none lg:w-60"
              />
            </label>

            {/* Ordenação */}
            <Select
              label="Ordenar por"
              hideLabel
              value={state.sort}
              onChange={(e) => state.setSort(e.target.value as SortOption)}
              options={SORT_OPTIONS}
              className="w-44 [&_select]:py-2 [&_select]:text-small"
            />

            {/* Visualização */}
            <div className="hidden items-center gap-0.5 rounded-pill border border-border p-0.5 lg:flex">
              <button
                type="button"
                onClick={() => onViewChange('editorial')}
                aria-pressed={view === 'editorial'}
                aria-label="Visualização editorial"
                className={cn(
                  'rounded-pill p-2 transition-colors',
                  view === 'editorial' ? 'bg-ink text-light' : 'text-ink-soft hover:text-ink',
                )}
              >
                <Rows3 className="size-3.5" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                onClick={() => onViewChange('grid')}
                aria-pressed={view === 'grid'}
                aria-label="Visualização em grade"
                className={cn(
                  'rounded-pill p-2 transition-colors',
                  view === 'grid' ? 'bg-ink text-light' : 'text-ink-soft hover:text-ink',
                )}
              >
                <LayoutGrid className="size-3.5" strokeWidth={1.75} />
              </button>
            </div>

            {/* Filtros (mobile) */}
            <button
              type="button"
              onClick={onOpenFilters}
              className="inline-flex items-center gap-2 rounded-pill border border-border bg-surface px-4 py-2 text-small text-ink transition-colors hover:border-primary lg:hidden"
            >
              <SlidersHorizontal className="size-3.5" strokeWidth={1.75} />
              Filtrar
              {state.activeCount > 0 && (
                <span className="tabular flex size-4 items-center justify-center rounded-pill bg-primary text-[0.5625rem] font-semibold text-light">
                  {state.activeCount}
                </span>
              )}
            </button>
          </div>
        </div>

        <label className="relative block sm:hidden">
          <span className="sr-only">Buscar em {categoryName}</span>
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-primary-strong" />
          <input
            value={state.search}
            onChange={(e) => state.setSearch(e.target.value)}
            placeholder={`Buscar em ${categoryName}…`}
            className="min-h-11 w-full rounded-pill border border-border bg-surface py-2 pr-10 pl-10 text-small text-ink placeholder:text-ink-muted/70 focus:border-primary focus:outline-none"
          />
          {state.search && (
            <button
              type="button"
              onClick={() => state.setSearch('')}
              aria-label="Limpar busca"
              className="absolute top-1/2 right-3 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-ink-muted"
            >
              <X className="size-4" />
            </button>
          )}
        </label>

        {/* Chips de filtro ativo */}
        {state.activeCount > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {state.activeChips.map((chip) => (
              <Chip
                key={`${chip.groupId}-${chip.value}`}
                onRemove={() => state.removeChip(chip.groupId, chip.value)}
              >
                {chip.label}
              </Chip>
            ))}
            <button
              type="button"
              onClick={state.clearAll}
              className="inline-flex items-center gap-1.5 text-small text-ink-muted underline decoration-border underline-offset-4 transition-colors hover:text-ink"
            >
              <X className="size-3" />
              Limpar filtros
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
