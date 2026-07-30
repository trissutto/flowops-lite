'use client';

import { motion } from 'framer-motion';
import { Container } from '@/components/layout/Container';
import { cn } from '@/lib/utils';
import { fadeUp, reveal, staggerBase } from '@/lib/motion';

/**
 * MANIFESTO — seção institucional. Não vende: posiciona.
 *
 * Tipografia grande, muito branco, números em destaque. É a seção que
 * transforma "loja de roupa grande" em "marca com propósito".
 */

interface ManifestoProps {
  eyebrow?: string;
  title: string;
  paragraphs: string[];
  stats?: { value: string; label: string }[];
  className?: string;
}

export function Manifesto({ eyebrow, title, paragraphs, stats, className }: ManifestoProps) {
  return (
    <section className={cn('py-section lg:py-section-lg', className)}>
      <Container width="text">
        <motion.div {...reveal(fadeUp)} className="text-center">
          {eyebrow && <p className="eyebrow text-primary-strong">{eyebrow}</p>}
          <h2 className="mt-6 text-h1 text-ink">{title}</h2>
          <div className="hairline-gold mx-auto mt-8 w-24" />
          <div className="mt-9 flex flex-col gap-6">
            {paragraphs.map((text) => (
              <p key={text.slice(0, 24)} className="text-body-lg font-light text-ink-soft">
                {text}
              </p>
            ))}
          </div>
        </motion.div>

        {stats && stats.length > 0 && (
          <motion.dl
            {...reveal(staggerBase, '-40px')}
            className="mt-16 grid grid-cols-2 gap-x-6 gap-y-12 sm:grid-cols-4"
          >
            {stats.map((stat) => (
              <motion.div key={stat.label} variants={fadeUp} className="text-center">
                <dt className="sr-only">{stat.label}</dt>
                <dd>
                  <span className="tabular block font-display text-[2.5rem] leading-none font-medium text-primary-strong sm:text-[3rem]">
                    {stat.value}
                  </span>
                  <span className="eyebrow mt-3 block text-ink-soft">{stat.label}</span>
                </dd>
              </motion.div>
            ))}
          </motion.dl>
        )}
      </Container>
    </section>
  );
}
