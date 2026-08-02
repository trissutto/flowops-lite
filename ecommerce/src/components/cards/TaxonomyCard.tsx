'use client';

import Image from 'next/image';
import { AppLink as Link } from '@/components/ui/AppLink';
import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { BLUR_DATA_URL, cn } from '@/lib/utils';
import { fadeUp, reveal } from '@/lib/motion';
import type { TaxonomyCard as TaxonomyCardData } from '@/types';

/**
 * Card de eixo de navegação (categoria, ocasião, modelagem).
 *
 * Duas variantes:
 *  - "editorial": foto grande com o nome sobreposto. Usada em Ocasiões e
 *    Categorias na home — é o que dá cara de revista.
 *  - "text": sem foto, tipografia grande + fio dourado. Usada em Modelagem,
 *    onde o conteúdo é educativo e a foto atrapalharia a leitura.
 *
 * CategoryCard / OccasionCard / FitCard abaixo são apenas apelidos semânticos
 * (mesma base, zero duplicação) — as páginas usam o nome do domínio.
 */

interface TaxonomyCardProps {
  data: TaxonomyCardData;
  variant?: 'editorial' | 'text';
  /** Proporção da foto na variante editorial. */
  aspect?: '3/4' | '4/5' | '1/1' | '4/3';
  index?: number;
  className?: string;
}

export function TaxonomyCard({
  data,
  variant = 'editorial',
  aspect = '4/5',
  index = 0,
  className,
}: TaxonomyCardProps) {
  const aspectClass = {
    '3/4': 'aspect-3/4',
    '4/5': 'aspect-4/5',
    '1/1': 'aspect-square',
    '4/3': 'aspect-4/3',
  }[aspect];

  if (variant === 'text') {
    return (
      <motion.div {...reveal(fadeUp, '-40px')} transition={{ duration: 0.56, delay: (index % 3) * 0.08 }}>
        <Link
          href={data.href}
          className={cn(
            'group flex h-full flex-col rounded-md border border-border bg-surface p-7 transition-all duration-[560ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-1.5 hover:border-primary/50 hover:shadow-gold',
            className,
          )}
        >
          <h3 className="font-display text-h3 text-ink">{data.title}</h3>
          <div className="mt-4 h-px w-10 bg-primary transition-all duration-[560ms] group-hover:w-20" />
          {data.description && (
            <p className="mt-5 flex-1 text-body font-light text-ink-soft">{data.description}</p>
          )}
          <span className="mt-7 inline-flex items-center gap-2 text-[0.6875rem] font-medium tracking-[0.16em] text-primary-strong uppercase">
            Ver peças
            <ArrowRight className="size-3.5 transition-transform duration-[320ms] group-hover:translate-x-1" />
          </span>
        </Link>
      </motion.div>
    );
  }

  return (
    <motion.div {...reveal(fadeUp, '-40px')} transition={{ duration: 0.56, delay: (index % 4) * 0.06 }}>
      <Link href={data.href} className={cn('group block', className)}>
        <div className={cn('relative overflow-hidden rounded-md bg-surface-alt', aspectClass)}>
          {data.image ? (
            <Image
              src={data.image.src}
              alt={data.image.alt}
              fill
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
              placeholder="blur"
              blurDataURL={BLUR_DATA_URL}
              className="object-cover transition-transform duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.04]"
            />
          ) : (
            <div className="grain size-full bg-gradient-to-br from-champagne to-surface-alt" />
          )}

          <div className="absolute inset-0 bg-gradient-to-t from-ink/70 via-ink/15 to-transparent" />

          <div className="absolute inset-x-5 bottom-5">
            <h3 className="font-display text-[1.375rem] leading-tight text-light">{data.title}</h3>
            {data.description && (
              <p className="mt-1.5 text-small font-light text-light/75">{data.description}</p>
            )}
            <span className="mt-3 inline-flex h-px w-8 bg-primary-soft transition-all duration-[560ms] group-hover:w-16" />
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

/** Categoria de produto (Vestidos, Blusas…). */
export function CategoryCard(props: Omit<TaxonomyCardProps, 'variant'>) {
  return <TaxonomyCard {...props} variant="editorial" />;
}

/** Ocasião (Trabalho, Casamento…). Proporção 3/4 dá mais presença editorial. */
export function OccasionCard(props: Omit<TaxonomyCardProps, 'variant'>) {
  return <TaxonomyCard aspect="3/4" {...props} variant="editorial" />;
}

/** Modelagem/caimento (Valoriza a cintura, Alonga silhueta…). */
export function FitCard(props: Omit<TaxonomyCardProps, 'variant' | 'aspect'>) {
  return <TaxonomyCard {...props} variant="text" />;
}
