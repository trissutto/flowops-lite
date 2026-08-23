'use client';

import { useMemo } from 'react';
import { X } from 'lucide-react';
import { SizePill } from '@/components/ui/Choice';
import { cn } from '@/lib/utils';
import type { Product } from '@/types';

/**
 * FILTRO DA BUSCA — o que faltava em /busca.
 *
 * A categoria tem barra de filtros desde a sprint 005; a busca devolvia
 * dezenas de peças e nenhuma forma de cortar. Quem digitou "vestido" e veste
 * 58 tinha que abrir peça por peça pra descobrir se serve — que é exatamente
 * a pergunta nº 1 desta loja.
 *
 * POR QUE NÃO REUSEI O `FilterPanel`: ele é alimentado por FACETAS do
 * servidor (`filterGroups`), e a busca não passa por lá — ela roda no
 * navegador, sobre as até 48 peças que o motor já devolveu. Fingir facetas de
 * servidor aqui seria inventar contagem. Estas saem dos RESULTADOS REAIS que
 * estão na tela, com o número ao lado, e por isso nunca levam a zero.
 *
 * Barra horizontal, não drawer: são poucos controles e o mais importante
 * (tamanho) precisa estar à vista no celular. Filtro atrás de botão é filtro
 * que ninguém abre.
 */

export interface FiltroBusca {
  tamanhos: string[];
  categorias: string[];
  soDesconto: boolean;
}

export const FILTRO_BUSCA_VAZIO: FiltroBusca = { tamanhos: [], categorias: [], soDesconto: false };

export function filtroBuscaAtivo(f: FiltroBusca): boolean {
  return f.tamanhos.length > 0 || f.categorias.length > 0 || f.soDesconto;
}

/** Aplica o recorte. Peça entra se atende TODOS os grupos escolhidos. */
export function aplicarFiltroBusca(produtos: Product[], f: FiltroBusca): Product[] {
  if (!filtroBuscaAtivo(f)) return produtos;
  return produtos.filter((p) => {
    if (f.soDesconto && !(p.compareAtPrice && p.compareAtPrice > p.price)) return false;
    if (f.categorias.length && !f.categorias.includes(p.category)) return false;
    if (f.tamanhos.length) {
      // Tamanho tem que estar DISPONÍVEL — filtrar por número que a peça tem
      // no cadastro mas não no estoque devolveria a mesma frustração de antes.
      const temAlgum = p.sizes.some((s) => s.available && f.tamanhos.includes(s.label));
      if (!temAlgum) return false;
    }
    return true;
  });
}

/** "calcas" → "Calças" — os slugs vêm sem acento do CRM. */
const ROTULO: Record<string, string> = {
  calcas: 'Calças',
  macacoes: 'Macacões',
  'moda-praia': 'Moda praia',
};

function rotuloCategoria(slug: string): string {
  if (ROTULO[slug]) return ROTULO[slug];
  const limpo = slug.replace(/[-_]+/g, ' ');
  return limpo.charAt(0).toUpperCase() + limpo.slice(1);
}

/** Ordena numérico quando dá (44, 46, 48…), alfabético no resto (P, M, G). */
function ordenarTamanhos(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b, 'pt-BR');
}

export function FiltroDaBusca({
  produtos,
  valor,
  onChange,
  totalFiltrado,
}: {
  /** Os resultados SEM filtro — é deles que saem as opções e as contagens. */
  produtos: Product[];
  valor: FiltroBusca;
  onChange: (f: FiltroBusca) => void;
  totalFiltrado: number;
}) {
  const { tamanhos, categorias, comDesconto } = useMemo(() => {
    const t = new Map<string, number>();
    const c = new Map<string, number>();
    let d = 0;
    for (const p of produtos) {
      for (const s of p.sizes) {
        if (s.available) t.set(s.label, (t.get(s.label) ?? 0) + 1);
      }
      if (p.category) c.set(p.category, (c.get(p.category) ?? 0) + 1);
      if (p.compareAtPrice && p.compareAtPrice > p.price) d++;
    }
    return {
      tamanhos: [...t.entries()].sort((a, b) => ordenarTamanhos(a[0], b[0])),
      categorias: [...c.entries()].sort((a, b) => b[1] - a[1]),
      comDesconto: d,
    };
  }, [produtos]);

  // Nada pra recortar? A barra não aparece — controle que só tem uma resposta
  // possível é ruído.
  const vale = tamanhos.length > 1 || categorias.length > 1 || comDesconto > 0;
  if (!vale) return null;

  const alternar = (chave: 'tamanhos' | 'categorias', v: string) => {
    const atual = valor[chave];
    onChange({
      ...valor,
      [chave]: atual.includes(v) ? atual.filter((x) => x !== v) : [...atual, v],
    });
  };

  const ativo = filtroBuscaAtivo(valor);

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-surface-alt/50 px-4 py-4 lg:px-6">
      {tamanhos.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="eyebrow shrink-0 text-ink-muted">Meu número</p>
          <div className="flex flex-wrap gap-1.5">
            {/* Sem a contagem DENTRO da pílula: ela mede 44px e o número
                viraria sopa. Quem informa o tamanho da lista é a linha de
                resultado embaixo, que muda ao vivo. */}
            {tamanhos.map(([label]) => (
              <SizePill
                key={label}
                label={label}
                selected={valor.tamanhos.includes(label)}
                onSelect={() => alternar('tamanhos', label)}
                className="min-w-12"
              />
            ))}
          </div>
        </div>
      )}

      {(categorias.length > 1 || comDesconto > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="eyebrow shrink-0 text-ink-muted">Recorte</p>
          <div className="flex flex-wrap gap-1.5">
            {categorias.length > 1 &&
              categorias.map(([slug, qtd]) => (
                <button
                  key={slug}
                  type="button"
                  onClick={() => alternar('categorias', slug)}
                  aria-pressed={valor.categorias.includes(slug)}
                  className={cn(
                    'rounded-pill border px-3.5 py-2 text-small transition-colors',
                    valor.categorias.includes(slug)
                      ? 'border-ink bg-ink text-light'
                      : 'border-border bg-surface text-ink-soft hover:border-primary hover:text-ink',
                  )}
                >
                  {rotuloCategoria(slug)} <span className="tabular opacity-60">{qtd}</span>
                </button>
              ))}
            {comDesconto > 0 && (
              <button
                type="button"
                onClick={() => onChange({ ...valor, soDesconto: !valor.soDesconto })}
                aria-pressed={valor.soDesconto}
                className={cn(
                  'rounded-pill border px-3.5 py-2 text-small transition-colors',
                  valor.soDesconto
                    ? 'border-secondary bg-secondary text-light'
                    : 'border-border bg-surface text-ink-soft hover:border-secondary hover:text-ink',
                )}
              >
                Em promoção <span className="tabular opacity-60">{comDesconto}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {ativo && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <p className="tabular text-small text-ink-soft" aria-live="polite">
            {totalFiltrado === 0
              ? 'Nenhuma peça com esse recorte'
              : `${totalFiltrado} ${totalFiltrado === 1 ? 'peça' : 'peças'} com o seu recorte`}
          </p>
          <button
            type="button"
            onClick={() => onChange(FILTRO_BUSCA_VAZIO)}
            className="inline-flex items-center gap-1.5 text-small text-ink-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
          >
            <X className="size-3.5" strokeWidth={1.75} />
            Limpar
          </button>
        </div>
      )}
    </div>
  );
}
