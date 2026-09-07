'use client';

import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { navegarParaSub, useSubcategoriaStore } from '@/store/subcategoria';

/**
 * SUBCATEGORIAS como chips no topo da categoria — "Blusas" → "Manga curta".
 *
 * ── POR QUE CHIP, E NÃO MAIS UM FILTRO NA BARRA LATERAL ──
 *
 * A subcategoria é o recorte mais previsível de todos: quem entra em Blusas
 * já sabe se quer manga curta ou manga longa. Enterrar isso numa barra que no
 * celular está atrás de um botão "Filtrar" custa o clique mais provável da
 * página. Aqui é a primeira coisa depois do título.
 *
 * ── POR QUE VAI NA URL (E POR QUE `history`, NÃO `router.push`) ──
 *
 * `?sub=manga-curta` é endereço: dá pra mandar no WhatsApp, salvar, e o botão
 * voltar do navegador funciona (o `popstate` é ouvido no store). Mas desde que
 * a página de categoria voltou a ser ISR (06/09), o chip troca a URL com
 * `history.pushState` e grava no store `subcategoria` — sem `router.push`,
 * que refaria a viagem ao servidor por um recorte que é 100% do navegador, e
 * sem `useSearchParams`, que exigiria Suspense e tiraria os chips do HTML
 * pré-renderizado. `pushState` também não mexe no scroll: a cliente está
 * olhando a grade, e é a grade que muda.
 *
 * A lista só chega aqui com subcategorias que TÊM peça publicada (o backend
 * filtra), então nenhum chip leva a página vazia.
 */
export function ChipsSubcategoria({
  subcategorias,
  className,
}: {
  subcategorias: Array<{ slug: string; nome: string; qtdPecas: number }>;
  className?: string;
}) {
  // No HTML do servidor o store está vazio ("Tudo" ativo) — quem chega por
  // link com `?sub=` vê o chip acender logo após a hidratação, junto da
  // grade. A trava de pathname impede o sub de OUTRA categoria de acender
  // chip aqui no primeiro frame após navegação client-side.
  const pathname = usePathname();
  const atual = useSubcategoriaStore((s) => (s.path === pathname ? s.sub : undefined)) ?? null;

  if (!subcategorias.length) return null;

  function ir(slug: string | null) {
    navegarParaSub(slug);
  }

  return (
    <div className={cn('flex flex-wrap gap-2', className)} role="group" aria-label="Subcategorias">
      <button
        type="button"
        onClick={() => ir(null)}
        aria-pressed={!atual}
        className={cn(
          'h-9 rounded-pill border px-4 text-small transition-colors',
          !atual
            ? 'border-primary bg-primary font-medium text-light'
            : 'border-border bg-surface text-ink-soft hover:border-primary/60 hover:text-ink',
        )}
      >
        Tudo
      </button>
      {subcategorias.map((s) => {
        const ativo = atual === s.slug;
        return (
          <button
            key={s.slug}
            type="button"
            onClick={() => ir(ativo ? null : s.slug)}
            aria-pressed={ativo}
            className={cn(
              'h-9 rounded-pill border px-4 text-small transition-colors',
              ativo
                ? 'border-primary bg-primary font-medium text-light'
                : 'border-border bg-surface text-ink-soft hover:border-primary/60 hover:text-ink',
            )}
          >
            {s.nome}
          </button>
        );
      })}
    </div>
  );
}
