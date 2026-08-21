'use client';

import { chaveDoCard } from '@/services/products';
import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { AppLink as Link } from '@/components/ui/AppLink';
import { useRouter } from 'next/navigation';
import {
  ArrowUpRight,
  Clock,
  LayoutGrid,
  MapPin,
  Search,
  Shirt,
  Sparkles,
  X,
} from 'lucide-react';
import { Container } from '@/components/layout/Container';
import { Skeleton } from '@/components/ui/Skeleton';
import { BLUR_DATA_URL, cn, formatPrice } from '@/lib/utils';
import { useDebounced, useEscapeKey, useLockScroll } from '@/hooks';
import { trackSearch, trackSelectItem } from '@/lib/tracking';
import {
  clearRecentSearches,
  fetchPopularProducts,
  getRecentSearches,
  pushRecentSearch,
  reportSearchClicked,
  search,
  searchProducts,
} from '@/services/search';
import type { SearchOutcome } from '@/lib/search';
import type { Product, SearchResult, SearchResultKind } from '@/types';

/**
 * SEARCH OVERLAY — autocomplete premium multi-seção (sprint 008).
 *
 * Enquanto a cliente digita (debounce 250ms), duas fontes respondem JUNTAS:
 *   PRODUTOS   — `searchProducts()` (BFF + motor de intenção/ranking);
 *   NAVEGAÇÃO  — `search()` (categorias/ocasiões/coleções, resolve local).
 * E acima de tudo, a linha de intenção: "Buscando: vestidos para casamento" —
 * a cliente VÊ que o site entendeu a frase dela, não só as palavras.
 *
 * Estado vazio nunca é caixa vazia: recentes + mais buscados + populares.
 * Enter (sem opção ativa) ou "ver todos" → /busca?q=termo.
 *
 * Acessibilidade: combobox com aria-activedescendant — o foco REAL nunca sai
 * do input; as setas movem só a opção ativa (padrão APG). Painel sempre
 * montado com `inert` quando fechado — regra dura do repo, sem AnimatePresence.
 */

const KIND_LABEL: Record<SearchResultKind, string> = {
  produto: 'Produtos',
  categoria: 'Categorias',
  look: 'Looks',
  colecao: 'Coleções',
  ocasiao: 'Ocasiões',
  loja: 'Lojas',
};

const KIND_ICON: Record<SearchResultKind, React.ElementType> = {
  produto: Sparkles,
  categoria: LayoutGrid,
  look: Shirt,
  colecao: Sparkles,
  ocasiao: Sparkles,
  loja: MapPin,
};

/** Ordem fixa das seções navegacionais — também é a ordem do teclado. */
const NAV_ORDER: SearchResultKind[] = ['categoria', 'ocasiao', 'colecao', 'look', 'loja'];

/** Curadoria do estado vazio — termos que mais convertem, revisados à mão. */
const MAIS_BUSCADOS = ['vestido festa', 'look trabalho', 'viscolycra', 'moda evangélica', 'vestido longo'];

/** Quantos produtos aparecem no autocomplete (o resto vai pra /busca). */
const MAX_PRODUTOS = 4;

const optionId = (index: number) => `busca-opt-${index}`;

export function SearchOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [term, setTerm] = useState('');
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [navResults, setNavResults] = useState<SearchResult[]>([]);
  const [populares, setPopulares] = useState<Product[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [cursor, setCursor] = useState(-1); // -1 = nenhuma opção ativa (Enter → /busca)
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const requestSeq = useRef(0);
  const router = useRouter();
  const debounced = useDebounced(term, 250);

  useLockScroll(open);
  useEscapeKey(open, onClose);

  // Foco no campo ao abrir + carrega recentes e populares; limpa ao fechar.
  useEffect(() => {
    if (open) {
      setRecent(getRecentSearches());
      void fetchPopularProducts().then(setPopulares);
      const timer = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(timer);
    }
    setTerm('');
    setOutcome(null);
    setNavResults([]);
    setCursor(-1);
  }, [open]);

  // Painel fechado sai da ordem de tab e do leitor de tela.
  useEffect(() => {
    if (panelRef.current) panelRef.current.inert = !open;
  }, [open]);

  // As duas fontes disparam em paralelo. O contador de sequência descarta
  // resposta atrasada de um termo antigo (a rede não respeita a ordem).
  useEffect(() => {
    const query = debounced.trim();
    if (query.length < 2) {
      setOutcome(null);
      setNavResults([]);
      setBuscando(false);
      return;
    }
    const seq = ++requestSeq.current;
    setBuscando(true);
    void search(query, 6).then((res) => {
      if (requestSeq.current === seq) setNavResults(res.results.filter((r) => r.kind !== 'produto'));
    });
    void searchProducts(query, MAX_PRODUTOS * 2).then((res) => {
      if (requestSeq.current === seq) {
        setOutcome(res);
        setBuscando(false);
        setCursor(-1);
      }
    });
  }, [debounced]);

  const typing = term.trim().length >= 2;
  const produtos = useMemo(
    () => (outcome?.results ?? []).slice(0, MAX_PRODUTOS).map((r) => r.doc.product),
    [outcome],
  );

  // Grupos navegacionais em ordem fixa + índice ABSOLUTO de cada opção —
  // é esse índice único que o teclado e o aria-activedescendant percorrem.
  const navGroups = useMemo(() => {
    let acc = produtos.length;
    return NAV_ORDER.map((kind) => ({
      kind,
      items: navResults.filter((r) => r.kind === kind).map((item) => ({ item, index: acc++ })),
    })).filter((g) => g.items.length > 0);
  }, [navResults, produtos.length]);

  const navFlat = useMemo(() => navGroups.flatMap((g) => g.items), [navGroups]);
  // Última opção é sempre o "ver todos" — a saída garantida do teclado.
  const totalOptions = typing ? produtos.length + navFlat.length + 1 : 0;
  const verTodosIndex = totalOptions - 1;

  function fecharENavegar(href: string) {
    onClose();
    router.push(href);
  }

  function irParaBusca(query: string) {
    pushRecentSearch(query);
    trackSearch(query, outcome?.results.length ?? 0);
    fecharENavegar(`/busca?q=${encodeURIComponent(query)}`);
  }

  function escolherProduto(product: Product, index: number) {
    const query = term.trim();
    pushRecentSearch(query);
    trackSelectItem(product, 'busca-autocomplete', index);
    reportSearchClicked(query);
    fecharENavegar(`/produto/${product.slug}`);
  }

  function escolherNav(result: SearchResult) {
    pushRecentSearch(result.label);
    fecharENavegar(result.href);
  }

  /** Ativa a opção no índice absoluto (clique/Enter compartilham o caminho). */
  function ativar(index: number) {
    if (index >= 0 && index < produtos.length) {
      escolherProduto(produtos[index], index);
    } else if (index >= produtos.length && index < verTodosIndex) {
      const entry = navFlat.find((n) => n.index === index);
      if (entry) escolherNav(entry.item);
    } else if (index === verTodosIndex && term.trim().length >= 2) {
      irParaBusca(term.trim());
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (cursor >= 0) ativar(cursor);
      else if (term.trim().length >= 2) irParaBusca(term.trim());
      return;
    }
    if (totalOptions === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((c) => (c + 1) % totalOptions);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((c) => (c <= 0 ? totalOptions - 1 : c - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setCursor(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setCursor(totalOptions - 1);
    }
  }

  const intentLabel = outcome?.intent?.label;

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        style={{ pointerEvents: open ? 'auto' : 'none' }}
        className={cn(
          'fixed inset-0 z-[var(--z-overlay)] bg-ink/40 backdrop-blur-sm transition-opacity duration-[320ms]',
          open ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Buscar no site"
        aria-hidden={!open}
        style={{ pointerEvents: open ? 'auto' : 'none' }}
        className={cn(
          'fixed inset-x-0 top-0 z-[var(--z-modal)] max-h-[92vh] overflow-y-auto bg-background shadow-xl transition-transform duration-[450ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
          open ? 'translate-y-0' : '-translate-y-full',
        )}
      >
        <Container width="page" className="py-8 lg:py-12">
          {/* Campo (combobox) */}
          <div className="flex items-center gap-4 border-b border-border pb-5">
            <Search className="size-5 shrink-0 text-primary-strong" strokeWidth={1.5} />
            <input
              ref={inputRef}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Busque por peça, ocasião, tecido ou tamanho…"
              aria-label="Termo de busca"
              role="combobox"
              aria-expanded={typing}
              aria-controls="busca-listbox"
              aria-activedescendant={cursor >= 0 ? optionId(cursor) : undefined}
              aria-autocomplete="list"
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

          {/* Autocomplete multi-seção */}
          {typing && (
            <div className="mt-7">
              {/* O que a intenção entendeu — prova de que o site escuta. */}
              {intentLabel && (
                <p className="text-small font-light text-ink-soft" aria-live="polite">
                  Buscando: <span className="font-normal text-ink">{intentLabel}</span>
                  {outcome?.relaxed && (
                    <span className="text-ink-muted"> · mostrando o que mais combina</span>
                  )}
                </p>
              )}

              <div
                id="busca-listbox"
                role="listbox"
                aria-label="Sugestões de busca"
                className="mt-5 grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]"
              >
                {/* PRODUTOS */}
                <div>
                  <p className="eyebrow flex items-center gap-2 text-ink-muted">
                    <Sparkles className="size-3.5" strokeWidth={1.75} />
                    Peças
                  </p>
                  {buscando && produtos.length === 0 ? (
                    <div className="mt-4 flex flex-col gap-3" aria-hidden>
                      {Array.from({ length: 3 }, (_, i) => (
                        <div key={i} className="flex items-center gap-4">
                          <Skeleton className="h-16 w-12 shrink-0 rounded-xs" />
                          <div className="flex-1">
                            <Skeleton className="h-3.5 w-2/3" />
                            <Skeleton className="mt-2 h-3 w-1/4" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : produtos.length > 0 ? (
                    <ul className="mt-4 flex flex-col gap-1">
                      {produtos.map((product, index) => {
                        const active = cursor === index;
                        return (
                          <li key={chaveDoCard(product)}>
                            <button
                              type="button"
                              role="option"
                              id={optionId(index)}
                              aria-selected={active}
                              tabIndex={-1}
                              onClick={() => escolherProduto(product, index)}
                              onMouseEnter={() => setCursor(index)}
                              className={cn(
                                'flex w-full items-center gap-4 rounded-sm px-2 py-2 text-left transition-colors',
                                active ? 'bg-surface-alt' : 'hover:bg-surface-alt/60',
                              )}
                            >
                              <span className="relative block h-16 w-12 shrink-0 overflow-hidden rounded-xs bg-surface-alt">
                                {product.images[0] && (
                                  <Image
                                    src={product.images[0].src}
                                    alt=""
                                    fill
                                    sizes="48px"
                                    placeholder="blur"
                                    blurDataURL={BLUR_DATA_URL}
                                    className="object-cover"
                                  />
                                )}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-body text-ink">{product.name}</span>
                                <span className="tabular mt-0.5 block text-small font-medium text-ink">
                                  {formatPrice(product.price)}
                                  {product.pixPrice && (
                                    <span className="ml-2 font-light text-ink-muted">
                                      {formatPrice(product.pixPrice)} no Pix
                                    </span>
                                  )}
                                </span>
                              </span>
                              <ArrowUpRight
                                className={cn(
                                  'size-3.5 shrink-0 transition-opacity',
                                  active ? 'text-primary-strong opacity-100' : 'opacity-0',
                                )}
                              />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="mt-4 text-small font-light text-ink-soft">
                      Nenhuma peça direta — veja as sugestões ao lado ou todos os resultados.
                    </p>
                  )}
                </div>

                {/* CATEGORIAS / OCASIÕES / COLEÇÕES */}
                <div className="flex flex-col gap-6">
                  {navGroups.map(({ kind, items }) => {
                    const Icon = KIND_ICON[kind];
                    return (
                      <div key={kind}>
                        <p className="eyebrow flex items-center gap-2 text-ink-muted">
                          <Icon className="size-3.5" strokeWidth={1.75} />
                          {KIND_LABEL[kind]}
                        </p>
                        <ul className="mt-3 flex flex-col gap-0.5">
                          {items.map(({ item, index }) => {
                            const active = cursor === index;
                            return (
                              <li key={item.href}>
                                <button
                                  type="button"
                                  role="option"
                                  id={optionId(index)}
                                  aria-selected={active}
                                  tabIndex={-1}
                                  onClick={() => escolherNav(item)}
                                  onMouseEnter={() => setCursor(index)}
                                  className={cn(
                                    'flex w-full items-center justify-between gap-3 rounded-sm px-3 py-2 text-left transition-colors',
                                    active ? 'bg-surface-alt' : 'hover:bg-surface-alt/60',
                                  )}
                                >
                                  <span className="min-w-0">
                                    <span className="block truncate text-body text-ink">{item.label}</span>
                                    {item.meta && (
                                      <span className="block truncate text-small text-ink-muted">{item.meta}</span>
                                    )}
                                  </span>
                                  <ArrowUpRight
                                    className={cn(
                                      'size-3.5 shrink-0 transition-opacity',
                                      active ? 'text-primary-strong opacity-100' : 'opacity-0',
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

                {/* VER TODOS — sempre a última opção, nas duas colunas */}
                <div className="lg:col-span-2">
                  <button
                    type="button"
                    role="option"
                    id={optionId(verTodosIndex)}
                    aria-selected={cursor === verTodosIndex}
                    tabIndex={-1}
                    onClick={() => irParaBusca(term.trim())}
                    onMouseEnter={() => setCursor(verTodosIndex)}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-sm px-3 py-2.5 text-[0.6875rem] font-medium tracking-[0.16em] text-ink uppercase transition-colors',
                      cursor === verTodosIndex ? 'bg-surface-alt' : 'hover:bg-surface-alt/60',
                    )}
                  >
                    Ver todos os resultados para “{term.trim()}”
                    <ArrowUpRight className="size-3.5 text-primary-strong" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Estado inicial: recentes + mais buscados + populares */}
          {!typing && (
            <div className="mt-9">
              <div className="grid gap-10 sm:grid-cols-2">
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
                    {MAIS_BUSCADOS.map((item) => (
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

              {/* Populares — vitrine mínima pra abrir a busca já com desejo */}
              {populares.length > 0 && (
                <div className="mt-10">
                  <p className="eyebrow text-ink-muted">Em alta agora</p>
                  <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                    {populares.map((product, index) => (
                      <button
                        key={chaveDoCard(product)}
                        type="button"
                        onClick={() => {
                          trackSelectItem(product, 'busca-populares', index);
                          fecharENavegar(`/produto/${product.slug}`);
                        }}
                        className="group/pop text-left"
                      >
                        <span className="relative block aspect-3/4 overflow-hidden rounded-sm bg-surface-alt">
                          {product.images[0] && (
                            <Image
                              src={product.images[0].src}
                              alt={product.images[0].alt}
                              fill
                              sizes="(max-width: 640px) 50vw, 200px"
                              placeholder="blur"
                              blurDataURL={BLUR_DATA_URL}
                              className="object-cover transition-transform duration-[600ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/pop:scale-[1.04]"
                            />
                          )}
                        </span>
                        <span className="mt-2.5 block truncate text-small text-ink">{product.name}</span>
                        <span className="tabular block text-small font-medium text-ink">
                          {formatPrice(product.price)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Container>
      </div>
    </>
  );
}
