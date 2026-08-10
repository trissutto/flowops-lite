'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';

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
 * ── POR QUE VAI NA URL ──
 *
 * `?sub=manga-curta` é endereço: dá pra mandar no WhatsApp, salvar, e o
 * Google indexa. Guardar num `useState` perderia tudo isso — e o botão
 * voltar do navegador deixaria de funcionar como a cliente espera.
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
  const router = useRouter();
  const params = useSearchParams();
  const atual = params.get('sub');

  if (!subcategorias.length) return null;

  function ir(slug: string | null) {
    const q = new URLSearchParams(params.toString());
    if (slug) q.set('sub', slug);
    else q.delete('sub');
    const qs = q.toString();
    // `scroll: false` — trocar de recorte não pode jogar a cliente pro topo:
    // ela está olhando a grade, e é a grade que muda.
    router.push(qs ? `?${qs}` : '?', { scroll: false });
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
