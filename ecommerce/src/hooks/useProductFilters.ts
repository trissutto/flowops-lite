'use client';

import { useCallback, useMemo, useState } from 'react';
import type { FilterState, SortOption } from '@/types';

/**
 * Estado de filtros + ordenação + busca da listagem.
 *
 * Fica num hook (e não na página) por dois motivos: a sidebar do desktop e o
 * drawer do mobile compartilham o MESMO estado, e o formato é serializável —
 * quando a listagem virar SSR com query na URL, só o "de onde vem/para onde
 * vai" muda. Ver docs/filters.md.
 */

export interface UseProductFiltersResult {
  filters: FilterState;
  sort: SortOption;
  search: string;
  /** Total de filtros ativos (para o badge do botão "Filtrar"). */
  activeCount: number;
  /** Lista achatada pros chips de filtro ativo. */
  activeChips: { groupId: string; value: string; label: string }[];
  setSort: (sort: SortOption) => void;
  setSearch: (term: string) => void;
  toggleValue: (groupId: string, value: string) => void;
  setRange: (groupId: string, range: [number, number]) => void;
  toggleFlag: (groupId: string) => void;
  isChecked: (groupId: string, value: string) => boolean;
  isFlagOn: (groupId: string) => boolean;
  getRange: (groupId: string) => [number, number] | undefined;
  clearGroup: (groupId: string) => void;
  clearAll: () => void;
  removeChip: (groupId: string, value: string) => void;
}

export function useProductFilters(initial: FilterState = {}): UseProductFiltersResult {
  const [filters, setFilters] = useState<FilterState>(initial);
  const [sort, setSort] = useState<SortOption>('relevancia');
  const [search, setSearch] = useState('');

  const toggleValue = useCallback((groupId: string, value: string) => {
    setFilters((current) => {
      const existing = Array.isArray(current[groupId]) ? (current[groupId] as string[]) : [];
      const next = existing.includes(value)
        ? existing.filter((v) => v !== value)
        : [...existing, value];
      return { ...current, [groupId]: next.length > 0 ? next : undefined };
    });
  }, []);

  const setRange = useCallback((groupId: string, range: [number, number]) => {
    setFilters((current) => ({ ...current, [groupId]: range }));
  }, []);

  const toggleFlag = useCallback((groupId: string) => {
    setFilters((current) => ({ ...current, [groupId]: current[groupId] ? undefined : true }));
  }, []);

  const isChecked = useCallback(
    (groupId: string, value: string) => {
      const entry = filters[groupId];
      return Array.isArray(entry) ? (entry as string[]).includes(value) : false;
    },
    [filters],
  );

  const isFlagOn = useCallback((groupId: string) => filters[groupId] === true, [filters]);

  const getRange = useCallback(
    (groupId: string) => {
      const entry = filters[groupId];
      return Array.isArray(entry) && typeof entry[0] === 'number'
        ? (entry as [number, number])
        : undefined;
    },
    [filters],
  );

  const clearGroup = useCallback((groupId: string) => {
    setFilters((current) => ({ ...current, [groupId]: undefined }));
  }, []);

  const clearAll = useCallback(() => setFilters({}), []);

  const removeChip = useCallback(
    (groupId: string, value: string) => {
      const entry = filters[groupId];
      if (entry === true) {
        clearGroup(groupId);
      } else if (Array.isArray(entry) && typeof entry[0] === 'number') {
        clearGroup(groupId);
      } else {
        toggleValue(groupId, value);
      }
    },
    [filters, clearGroup, toggleValue],
  );

  const { activeCount, activeChips } = useMemo(() => {
    const chips: { groupId: string; value: string; label: string }[] = [];
    let count = 0;

    for (const [groupId, entry] of Object.entries(filters)) {
      if (entry === undefined) continue;
      if (entry === true) {
        count += 1;
        chips.push({ groupId, value: 'true', label: groupId.replace(/-/g, ' ') });
      } else if (Array.isArray(entry) && typeof entry[0] === 'number') {
        count += 1;
        chips.push({
          groupId,
          value: 'range',
          label: `R$ ${entry[0]} – R$ ${entry[1]}`,
        });
      } else if (Array.isArray(entry)) {
        for (const value of entry as string[]) {
          count += 1;
          chips.push({ groupId, value, label: value });
        }
      }
    }

    return { activeCount: count, activeChips: chips };
  }, [filters]);

  return {
    filters,
    sort,
    search,
    activeCount,
    activeChips,
    setSort,
    setSearch,
    toggleValue,
    setRange,
    toggleFlag,
    isChecked,
    isFlagOn,
    getRange,
    clearGroup,
    clearAll,
    removeChip,
  };
}
