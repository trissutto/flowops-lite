'use client';

import { useCallback, useEffect, useState } from 'react';
import useEmblaCarousel from 'embla-carousel-react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * LUXURY CAROUSEL — carrossel da marca (Embla).
 *
 * Por que Embla: gesto nativo no touch, arraste no mouse, teclado acessível e
 * ~5kb. Sem autoplay por padrão — conteúdo de moda que se move sozinho tira a
 * atenção da peça e é problema de acessibilidade.
 *
 * Setas ficam FORA do conteúdo (nunca sobre a foto) e desaparecem quando não
 * há para onde ir. Bullets viram traços — o mesmo vocabulário do fio dourado.
 */

interface LuxuryCarouselProps {
  children: React.ReactNode[];
  /** Itens visíveis por breakpoint. */
  perView?: { base?: number; sm?: number; lg?: number; xl?: number };
  gap?: 'sm' | 'md' | 'lg';
  /** Mostra setas (desktop). */
  arrows?: boolean;
  /** Mostra indicadores de posição. */
  dots?: boolean;
  align?: 'start' | 'center';
  loop?: boolean;
  ariaLabel: string;
  className?: string;
}

const GAPS = { sm: 'gap-3', md: 'gap-4 lg:gap-6', lg: 'gap-6 lg:gap-8' } as const;

/**
 * ⚠️ TUDO EM VARIÁVEL — NADA DE `flexBasis` INLINE (bug real, 07/08).
 *
 * Antes esta função devolvia `flexBasis` direto no `style`, junto das
 * variáveis dos breakpoints. Só que **estilo inline vence classe CSS**: o
 * `sm:basis-*`, `lg:basis-*` e `xl:basis-*` nunca entravam, e a largura de
 * CELULAR (1,15–1,35 card) valia até num monitor de 1920px. Todos os
 * carrosséis do site — novidades, best sellers, "quem viu também levou" —
 * mostravam um card e meio gigante em vez de quatro.
 *
 * Agora a base também é variável, aplicada por classe: todas as larguras
 * ficam no mesmo nível de especificidade e o breakpoint manda, como sempre
 * foi a intenção.
 */
function basisClass(perView: NonNullable<LuxuryCarouselProps['perView']>) {
  const { base = 1.15, sm = 2, lg = 3, xl = 4 } = perView;
  const pct = (n: number) => `${(100 / n).toFixed(4)}%`;
  return {
    '--base-basis': pct(base),
    '--sm-basis': pct(sm),
    '--lg-basis': pct(lg),
    '--xl-basis': pct(xl),
  } as React.CSSProperties;
}

export function LuxuryCarousel({
  children,
  perView = {},
  gap = 'md',
  arrows = true,
  dots = false,
  align = 'start',
  loop = false,
  ariaLabel,
  className,
}: LuxuryCarouselProps) {
  const [emblaRef, emblaApi] = useEmblaCarousel({ align, loop, containScroll: 'trimSnaps' });
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);
  const [selected, setSelected] = useState(0);
  const [snapCount, setSnapCount] = useState(0);

  const sync = useCallback((api: NonNullable<typeof emblaApi>) => {
    setCanPrev(api.canScrollPrev());
    setCanNext(api.canScrollNext());
    setSelected(api.selectedScrollSnap());
    setSnapCount(api.scrollSnapList().length);
  }, []);

  useEffect(() => {
    if (!emblaApi) return;
    sync(emblaApi);
    emblaApi.on('select', sync).on('reInit', sync);
    return () => {
      emblaApi.off('select', sync).off('reInit', sync);
    };
  }, [emblaApi, sync]);

  const style = basisClass(perView);

  return (
    <div className={cn('relative', className)}>
      <div
        ref={emblaRef}
        className="overflow-hidden"
        role="region"
        aria-roledescription="carrossel"
        aria-label={ariaLabel}
      >
        <div className={cn('flex', GAPS[gap])}>
          {children.map((child, i) => (
            <div
              key={i}
              style={style}
              className="min-w-0 shrink-0 grow-0 basis-[var(--base-basis)] sm:basis-[var(--sm-basis)] lg:basis-[var(--lg-basis)] xl:basis-[var(--xl-basis)]"
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} de ${children.length}`}
            >
              {child}
            </div>
          ))}
        </div>
      </div>

      {arrows && (canPrev || canNext) && (
        <div className="mt-8 hidden items-center justify-end gap-2 lg:flex">
          <button
            type="button"
            onClick={() => emblaApi?.scrollPrev()}
            disabled={!canPrev}
            aria-label="Anterior"
            className="flex size-11 items-center justify-center rounded-pill border border-border text-ink-soft transition-colors hover:border-primary hover:text-primary-strong disabled:pointer-events-none disabled:opacity-35"
          >
            <ChevronLeft className="size-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => emblaApi?.scrollNext()}
            disabled={!canNext}
            aria-label="Próximo"
            className="flex size-11 items-center justify-center rounded-pill border border-border text-ink-soft transition-colors hover:border-primary hover:text-primary-strong disabled:pointer-events-none disabled:opacity-35"
          >
            <ChevronRight className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      )}

      {dots && snapCount > 1 && (
        <div className="mt-7 flex items-center justify-center gap-2">
          {Array.from({ length: snapCount }, (_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => emblaApi?.scrollTo(i)}
              aria-label={`Ir para o slide ${i + 1}`}
              aria-current={i === selected}
              className={cn(
                'h-0.5 rounded-pill transition-all duration-[320ms]',
                i === selected ? 'w-9 bg-primary-strong' : 'w-4 bg-border-strong',
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}
