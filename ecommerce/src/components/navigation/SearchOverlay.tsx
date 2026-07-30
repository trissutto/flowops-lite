'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  ArrowUpRight,
  Clock,
  LayoutGrid,
  MapPin,
  Search,
  Shirt,
  Sparkles,
  Tag,
  X,
} from 'lucide-react';
import { Container } from '@/components/layout/Container';
import { cn } from '@/lib/utils';
import { transition } from '@/lib/motion';
import { useDebounced, useEscapeKey, useLockScroll } from '@/hooks';
import { popularSearches } from '@/data/navigation';
import {
  clearRecentSearches,
  getRecentSearches,
  pushRecentSearch,
  search,
  type SearchResponse,
} from '@/services/search';
import type { SearchResultKind } from '@/types';

/**
 * SearchOverlay — painel de busca full-width no desktop, tela cheia no mobile.
 *
 * Enquanto não há termo: pesquisas recentes + buscas populares (nunca uma
 * caixa vazia). Com termo: resultados agrupados por tipo, navegáveis por
 * teclado (↑ ↓ Enter Esc).
 *
 * A resolução vem de services/search.ts — trocar por API não afeta este arquivo.
 */

const KIND_ICON: Record<SearchResultKind, React.ElementType> = {
  produto: Tag,
  categoria: LayoutGrid,
  look: Shirt,
  colecao: Sparkles,
  ocasiao: Sparkles,
  loja: MapPin,
};

const KIND_LABEL: Record<SearchResultKind, string> = {
  produto: 'Produtos',
  categoria: 'Categorias',
  look: 'Looks',
  colecao: 'Coleções',
  ocasiao: 'Ocasiões',
  loja: 'Lojas',
};

export function SearchOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [term, setTerm] = useState('');
  const [response, setResponse] = useState<SearchResponse>({ results: [], query: '' });
  const [recent, setRecent] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();
  const debounced = useDebounced(term, 200);

  useLockScroll(open);
  useEscapeKey(open, onClose);

  // Foco no campo ao abrir; limpa o termo ao fechar.
  useEffect(() => {
    if (open) {
      setRecent(getRecentSearches());
      const timer = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(timer);
    }
    setTerm('');
    setResponse({ results: [], query: '' });
    setCursor(0);
  }, [open]);

  // Painel fechado sai da ordem de tab.
  useEffect(() => {
    if (panelRef.current) panelRef.current.inert = !open;
  }, [open]);

  useEffect(() => {
    let cancelled = false;
    if (debounced.trim().length < 2) {
      setResponse({ results: [], query: '' });
      return;
    }
    search(debounced).then((res) => {
      if (!cancelled) {
        setResponse(res);
        setCursor(0);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const results = response.results;
  const grouped = useMemo(() => {
    const map = new Map<SearchResultKind, typeof results>();
    for (const result of results) {
      const list = map.get(result.kind) ?? [];
      list.push(result);
      map.set(result.kind, list);
    }
    return Array.from(map.entries());
  }, [results]);

  function go(href: string, label: string) {
    pushRecentSearch(label);
    onClose();
    router.push(href);
  }

  function submit() {
    if (response.results[cursor]) {
      const target = response.results[cursor];
      go(target.href, target.label);
    } else if (term.trim().length >= 2) {
      pushRecentSearch(term.trim());
      onClose();
      router.push(`/busca?q=${encodeURIComponent(term.trim())}`);
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (response.results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((c) => (c + 1) % response.results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((c) => (c - 1 + response.results.length) % response.results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  }

  const hasQuery = response.results.length > 0;
  const emptyQuery = term.trim().length < 2;
  let flatIndex = -1;

  return (
    <>
      <motion.div
        aria-hidden
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: open ? 1 : 0 }}
        transition={transition.base}
        style={{ pointerEvents: open ? 'auto' : 'none' }}
        className="fixed inset-0 z-[var(--z-overlay)] bg-ink/40 backdrop-blur-sm"
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Buscar no site"
        aria-hidden={!open}
        initial={{ y: '-100%' }}
        animate={{ y: open ? '0%' : '-100%' }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        style={{ pointerEvents: open ? 'auto' : 'none' }}
        className="fixed inset-x-0 top-0 z-[var(--z-modal)] max-h-[92vh] overflow-y-auto bg-background shadow-xl"
      >
        <Container width="page" className="py-8 lg:py-12">
          {/* Campo */}
          <div className="flex items-center gap-4 border-b border-border pb-5">
            <Search className="size-5 shrink-0 text-primary-strong" strokeWidth={1.5} />
            <input
              ref={inputRef}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Busque por peça, ocasião, tecido ou tamanho…"
              aria-label="Termo de busca"
              autoComplete="off"
              className="flex-1 bg-transparent font-display text-h3 text-ink placeholder:font-sans placeholder:text-body placeholder:text-ink-muted/70 focus:outline-none"
            />
            <button
              type="button"
              onClick={onClose}
              aria-label="Fechar busca"
              className="flex size-10 shrink-0 items-center justify-center rounded-pill text-ink-soft transition-colors hover:bg-surface-alt hover:text-ink"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Resultados */}
          {hasQuery && (
            <div className="mt-8 grid gap-x-12 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
              {grouped.map(([kind, items]) => {
                const Icon = KIND_ICON[kind];
                return (
                  <div key={kind}>
                    <p className="eyebrow flex items-center gap-2 text-ink-muted">
                      <Icon className="size-3.5" strokeWidth={1.75} />
                      {KIND_LABEL[kind]}
                    </p>
                    <ul className="mt-4 flex flex-col gap-1">
                      {items.map((item) => {
                        flatIndex += 1;
                        const active = flatIndex === cursor;
                        return (
                          <li key={item.href}>
                            <button
                              type="button"
                              onClick={() => go(item.href, item.label)}
                              onMouseEnter={() => setCursor(response.results.indexOf(item))}
                              className={cn(
                                'flex w-full items-center justify-between gap-3 rounded-sm px-3 py-2.5 text-left transition-colors',
                                active ? 'bg-surface-alt' : 'hover:bg-surface-alt/60',
                              )}
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-body text-ink">
                                  {item.label}
                                </span>
                                {item.meta && (
                                  <span className="block truncate text-small text-ink-muted">
                                    {item.meta}
                                  </span>
                                )}
                              </span>
                              <ArrowUpRight
                                className={cn(
                                  'size-3.5 shrink-0 transition-opacity',
                                  active ? 'opacity-100 text-primary-strong' : 'opacity-0',
                                )}
                              />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}

          {/* Nada encontrado */}
          {!emptyQuery && !hasQuery && (
            <div className="py-14 text-center">
              <p className="font-display text-h4">Nada encontrado para “{term}”.</p>
              <p className="mt-2 text-body font-light text-ink-soft">
                Tente por ocasião (“casamento”), tecido (“viscolycra”) ou fale com uma consultora.
              </p>
            </div>
          )}

          {/* Estado inicial: recentes + populares */}
          {emptyQuery && (
            <div className="mt-9 grid gap-10 sm:grid-cols-2">
              {recent.length > 0 && (
                <div>
                  <div className="flex items-center justify-between">
                    <p className="eyebrow flex items-center gap-2 text-ink-muted">
                      <Clock className="size-3.5" strokeWidth={1.75} />
                      Pesquisas recentes
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        clearRecentSearches();
                        setRecent([]);
                      }}
                      className="text-small text-ink-muted underline decoration-border underline-offset-4 transition-colors hover:text-ink"
                    >
                      Limpar
                    </button>
                  </div>
                  <ul className="mt-4 flex flex-wrap gap-2">
                    {recent.map((item) => (
                      <li key={item}>
                        <button
                          type="button"
                          onClick={() => setTerm(item)}
                          className="rounded-pill border border-border bg-surface px-4 py-2 text-small text-ink-soft transition-colors hover:border-primary hover:text-ink"
                        >
                          {item}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <p className="eyebrow flex items-center gap-2 text-ink-muted">
                  <Sparkles className="size-3.5" strokeWidth={1.75} />
                  Mais buscados
                </p>
                <ul className="mt-4 flex flex-wrap gap-2">
                  {popularSearches.map((item) => (
                    <li key={item}>
                      <button
                        type="button"
                        onClick={() => setTerm(item)}
                        className="rounded-pill border border-border bg-surface px-4 py-2 text-small text-ink-soft transition-colors hover:border-primary hover:text-ink"
                      >
                        {item}
                      </button>
                    </li>
                  ))}
                </ul>

                <Link
                  href="/lojas"
                  onClick={onClose}
                  className="mt-8 inline-flex items-center gap-2 text-[0.6875rem] font-medium tracking-[0.16em] text-ink uppercase"
                >
                  <MapPin className="size-3.5 text-primary-strong" />
                  Prefere ver de perto? Encontre uma loja
                </Link>
              </div>
            </div>
          )}
        </Container>
      </motion.div>
    </>
  );
}
