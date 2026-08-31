'use client';

import { chaveDoCard } from '@/services/products';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppLink as Link } from '@/components/ui/AppLink';
import { Search, Sparkles } from 'lucide-react';
import { Section } from '@/components/layout/Section';
import { ProductCard } from '@/components/cards/ProductCard';
import { ProductGridSkeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { trackSearch, trackSelectItem } from '@/lib/tracking';
import {
  fetchPopularProducts,
  reportSearchClicked,
  search,
  searchProducts,
} from '@/services/search';
import type { SearchOutcome } from '@/lib/search';
import type { Product, SearchResult } from '@/types';
import { LINK_WHATSAPP_SITE } from '@/data/contato';
import {
  FILTRO_BUSCA_VAZIO,
  FiltroDaBusca,
  aplicarFiltroBusca,
  filtroBuscaAtivo,
  type FiltroBusca,
} from '@/components/commerce/FiltroDaBusca';

/**
 * RESULTADOS DE BUSCA — /busca?q=…
 *
 * Header editorial: o termo em serif + a leitura da intenção ("Entendemos:
 * vestidos para casamento") + contagem. A cliente confere de relance se o
 * site entendeu — e corrige o termo antes de rolar, não depois.
 *
 * ZERO RESULTS NUNCA É PÁGINA MORTA (spec da sprint proíbe "nenhum produto
 * encontrado"): o motor relaxa a busca sozinho, e quando isso acontece a
 * página assume — "não achamos exatamente isso, veja o que combina" + termos
 * pra tentar + categorias relacionadas + populares. Sempre há um caminho.
 *
 * Tracking: `search` com a contagem REAL (dedupe por termo no event manager)
 * e `select_item` no clique que navega (list 'busca-resultados').
 */

/** Curadoria de saída quando nem o termo dá pé — espelha o overlay. */
const TERMOS_GUIA = ['vestido festa', 'look trabalho', 'viscolycra', 'moda evangélica', 'vestido longo'];

export function SearchResults({ term }: { term: string }) {
  // null = buscando; preenchido = resposta do motor (nunca lança).
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [relacionados, setRelacionados] = useState<SearchResult[]>([]);
  const [populares, setPopulares] = useState<Product[]>([]);
  const [filtro, setFiltro] = useState<FiltroBusca>(FILTRO_BUSCA_VAZIO);
  const trackedFor = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    setOutcome(null);
    setRelacionados([]);
    // Termo novo, recorte zerado: manter o 58 marcado numa busca por "calça"
    // depois de outra por "vestido" esconderia resultado sem a cliente pedir.
    setFiltro(FILTRO_BUSCA_VAZIO);

    if (term.length < 2) {
      // Sem termo: a página vira convite, não erro — populares + termos-guia.
      setOutcome({ results: [], relaxed: false, suggestions: [] });
      void fetchPopularProducts().then((p) => alive && setPopulares(p));
      return () => {
        alive = false;
      };
    }

    void searchProducts(term, 48).then((res) => {
      if (!alive) return;
      setOutcome(res);
      // Populares só entram em cena quando a busca precisou relaxar.
      if (res.relaxed) void fetchPopularProducts().then((p) => alive && setPopulares(p));
    });
    // Categorias/ocasiões/coleções relacionadas — índice navegacional local.
    void search(term, 6).then((res) => {
      if (alive) setRelacionados(res.results.filter((r) => r.kind !== 'produto'));
    });

    return () => {
      alive = false;
    };
  }, [term]);

  // search com contagem REAL, uma vez por termo respondido.
  useEffect(() => {
    if (!outcome || term.length < 2 || trackedFor.current === term) return;
    trackedFor.current = term;
    trackSearch(term, outcome.results.length, outcome.relaxed);
  }, [outcome, term]);

  const carregando = outcome === null;
  /** Tudo que o motor devolveu — é daqui que saem as opções do filtro. */
  const todos = useMemo(() => outcome?.results.map((r) => r.doc.product) ?? [], [outcome]);
  /** O que vai pra grade, já com o recorte da cliente. */
  const produtos = useMemo(() => aplicarFiltroBusca(todos, filtro), [todos, filtro]);
  const total = produtos.length;
  const relaxed = outcome?.relaxed ?? false;
  const intentLabel = outcome?.intent?.label;
  const recortou = filtroBuscaAtivo(filtro);

  /** Só o clique que navega conta (padrão do RecommendationRail). */
  const aoClicar = (product: Product, index: number) => (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('a')) {
      trackSelectItem(product, 'busca-resultados', index);
      reportSearchClicked(term);
    }
  };

  /** Populares NÃO entram no CTR da busca — não são resultado do termo. */
  const aoClicarPopular = (product: Product, index: number) => (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('a')) {
      trackSelectItem(product, 'busca-populares', index);
    }
  };

  return (
    <>
      {/* Header editorial */}
      <Section space="sm" width="page">
        <p className="eyebrow text-primary-strong">Busca</p>
        <h1 className="mt-4 font-display text-h1 text-ink">
          {term.length >= 2 ? (
            <>
              Resultados para <span className="italic">“{term}”</span>
            </>
          ) : (
            <>
              O que você <span className="italic">procura</span>?
            </>
          )}
        </h1>
        {intentLabel && (
          <p className="mt-4 text-body font-light text-ink-soft">
            Entendemos: <span className="font-normal text-ink">{intentLabel}</span>
          </p>
        )}
        {!carregando && term.length >= 2 && !relaxed && (
          <p className="tabular mt-2 text-small text-ink-muted" aria-live="polite">
            {/* A contagem do TERMO, não a do recorte: quem diz quantas sobraram
                depois do filtro é a própria barra de filtro, embaixo. */}
            {todos.length} {todos.length === 1 ? 'peça encontrada' : 'peças encontradas'}
          </p>
        )}
      </Section>

      {/* Busca relaxada: assume a conversa antes da grade. */}
      {relaxed && !carregando && (
        <Section space="none" width="page" className="pb-10">
          <div className="rounded-md border border-primary/25 bg-surface-alt/60 px-6 py-7 lg:px-9">
            <p className="font-display text-h4 text-ink">
              Não achamos exatamente isso — mas veja o que <span className="italic">combina</span>.
            </p>

            {(outcome?.suggestions.length ?? 0) > 0 && (
              <div className="mt-5">
                <p className="eyebrow text-ink-muted">Tente buscar por</p>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {outcome?.suggestions.map((sugestao) => (
                    <li key={sugestao}>
                      <Link
                        href={`/busca?q=${encodeURIComponent(sugestao)}`}
                        className="inline-block rounded-pill border border-border bg-surface px-4 py-2 text-small text-ink-soft transition-colors hover:border-primary hover:text-ink"
                      >
                        {sugestao}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {relacionados.length > 0 && (
              <div className="mt-6">
                <p className="eyebrow text-ink-muted">Ou navegue por</p>
                <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
                  {relacionados.map((item) => (
                    <li key={item.href}>
                      <Link href={item.href} className="link-underline text-body text-ink">
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Grade de resultados */}
      <Section space="sm" width="wide">
        {/* FILTRO — em cima da grade, sempre visível. Só aparece quando há
            mais de uma resposta possível (ver `FiltroDaBusca`). */}
        {!carregando && todos.length > 1 && (
          <div className="mb-8">
            <FiltroDaBusca
              produtos={todos}
              valor={filtro}
              onChange={setFiltro}
              totalFiltrado={total}
            />
          </div>
        )}

        {carregando ? (
          <ProductGridSkeleton count={8} />
        ) : total > 0 ? (
          <>
            {relaxed && (
              <p className="eyebrow mb-8 flex items-center gap-2 text-ink-muted">
                <Sparkles className="size-3.5 text-primary-strong" strokeWidth={1.75} />
                O que mais combina com a sua busca
              </p>
            )}
            <div className="grid grid-cols-2 gap-x-2 gap-y-6 lg:grid-cols-4 lg:gap-x-6">
              {produtos.map((product, index) => (
                <div key={chaveDoCard(product)} onClickCapture={aoClicar(product, index)}>
                  <ProductCard product={product} index={index} priority={index < 4} />
                </div>
              ))}
            </div>
          </>
        ) : recortou ? (
          /**
           * Zerou POR CAUSA DO RECORTE, não da busca. Mandar a cliente falar
           * no WhatsApp aqui seria mentir sobre o que aconteceu: o termo achou
           * peça, o número dela é que não tem. A saída é desfazer o recorte —
           * e o botão de limpar está logo acima, na barra de filtro.
           */
          <EmptyState
            icon={<Search strokeWidth={1.5} />}
            title="Nenhuma peça com esse recorte."
            description="Tente soltar um dos filtros acima — ou fale com uma consultora: a gente procura no estoque das 14 lojas."
            action={{ label: 'Falar no WhatsApp', href: LINK_WHATSAPP_SITE }}
          />
        ) : term.length >= 2 ? (
          // Último recurso (BFF fora do ar E navegação sem pista): ainda assim
          // com saída dupla — consultora e vitrine. Nunca uma frase seca.
          <EmptyState
            icon={<Search strokeWidth={1.5} />}
            title="A busca descansou por um instante."
            description="Nossas consultoras encontram a peça pra você no estoque das 14 lojas — ou explore a vitrine enquanto isso."
            action={{ label: 'Falar no WhatsApp', href: LINK_WHATSAPP_SITE }}
            secondaryAction={{ label: 'Ver novidades', href: '/novidades' }}
          />
        ) : (
          // Sem termo: convite com termos-guia.
          <div className="pb-4">
            <p className="eyebrow text-ink-muted">Comece por aqui</p>
            <ul className="mt-4 flex flex-wrap gap-2">
              {TERMOS_GUIA.map((sugestao) => (
                <li key={sugestao}>
                  <Link
                    href={`/busca?q=${encodeURIComponent(sugestao)}`}
                    className="inline-block rounded-pill border border-border bg-surface px-4 py-2 text-small text-ink-soft transition-colors hover:border-primary hover:text-ink"
                  >
                    {sugestao}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {/* Populares — rail de resgate quando a busca relaxou (ou não há termo) */}
      {populares.length > 0 && (relaxed || term.length < 2) && (
        <Section space="sm" width="wide" tone="alt" aria-labelledby="busca-populares">
          <p id="busca-populares" className="eyebrow text-ink-muted">
            As mais desejadas agora
          </p>
          <div className="mt-8 grid grid-cols-2 gap-x-2 gap-y-6 lg:grid-cols-4 lg:gap-x-6">
            {populares.map((product, index) => (
              <div key={chaveDoCard(product)} onClickCapture={aoClicarPopular(product, index)}>
                <ProductCard product={product} index={index} />
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
