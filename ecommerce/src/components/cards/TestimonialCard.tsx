'use client';

import { motion } from 'framer-motion';
import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fadeUp, reveal } from '@/lib/motion';
import { Avatar } from '@/components/ui/Card';
import type { Testimonial } from '@/types';

/**
 * TESTIMONIAL CARD — avaliação de cliente.
 *
 * O diferencial pro público plus size é o bloco de CAIMENTO: altura, peso e
 * numeração comprada. É a informação que faz a cliente confiar no tamanho,
 * e nenhum ecommerce comum mostra.
 */

export function TestimonialCard({
  testimonial,
  index = 0,
  className,
}: {
  testimonial: Testimonial;
  index?: number;
  className?: string;
}) {
  const { name, city, quote, rating, avatar, fit, productName } = testimonial;

  return (
    <motion.figure
      {...reveal(fadeUp, '-40px')}
      transition={{ duration: 0.56, delay: (index % 3) * 0.08 }}
      className={cn(
        'flex h-full flex-col rounded-lg border border-border bg-surface p-7 shadow-sm',
        className,
      )}
    >
      <div
        className="flex items-center gap-1"
        aria-label={`Avaliação: ${rating} de 5 estrelas`}
        role="img"
      >
        {Array.from({ length: 5 }, (_, i) => (
          <Star
            key={i}
            className={cn(
              'size-3.5',
              i < Math.round(rating) ? 'fill-primary text-primary' : 'text-border-strong',
            )}
            strokeWidth={1.5}
          />
        ))}
      </div>

      <blockquote className="mt-5 flex-1">
        <p className="font-display text-[1.25rem] leading-snug italic text-ink">“{quote}”</p>
      </blockquote>

      {productName && (
        <p className="mt-4 text-small font-light text-ink-muted">Comprou: {productName}</p>
      )}

      {/* Contexto de caimento — o dado que gera confiança */}
      {fit && (fit.height || fit.weight || fit.sizeBought) && (
        <dl className="mt-5 flex flex-wrap gap-x-6 gap-y-2 rounded-md bg-surface-alt px-4 py-3">
          {fit.height && (
            <div>
              <dt className="eyebrow text-ink-muted">Altura</dt>
              <dd className="tabular mt-0.5 text-small text-ink">{fit.height}</dd>
            </div>
          )}
          {fit.weight && (
            <div>
              <dt className="eyebrow text-ink-muted">Peso</dt>
              <dd className="tabular mt-0.5 text-small text-ink">{fit.weight}</dd>
            </div>
          )}
          {fit.sizeBought && (
            <div>
              <dt className="eyebrow text-ink-muted">Tamanho</dt>
              <dd className="tabular mt-0.5 text-small font-medium text-ink">{fit.sizeBought}</dd>
            </div>
          )}
        </dl>
      )}

      <figcaption className="mt-6 flex items-center gap-3 border-t border-border pt-5">
        <Avatar name={name} src={avatar?.src} size="md" />
        <div>
          <p className="text-small font-medium text-ink">{name}</p>
          <p className="text-small font-light text-ink-muted">{city}</p>
        </div>
      </figcaption>
    </motion.figure>
  );
}
