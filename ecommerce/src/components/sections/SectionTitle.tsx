'use client';

import { AppLink as Link } from '@/components/ui/AppLink';
import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fadeUp, reveal } from '@/lib/motion';

/**
 * SectionTitle — cabeçalho padrão de TODA seção do site.
 *
 * Composição fixa da marca (nunca mudar a ordem):
 *   eyebrow dourado → título serif → fio dourado → descrição → CTA
 *
 * Isso é o que faz páginas diferentes parecerem o mesmo site.
 */

interface SectionTitleProps {
  eyebrow?: string;
  title: React.ReactNode;
  subtitle?: string;
  description?: string;
  cta?: { label: string; href: string };
  align?: 'left' | 'center';
  /** Sobre fundo escuro. */
  tone?: 'default' | 'light';
  /** Esconde o fio dourado (seções muito densas). */
  hideRule?: boolean;
  as?: 'h1' | 'h2' | 'h3';
  className?: string;
  id?: string;
}

export function SectionTitle({
  eyebrow,
  title,
  subtitle,
  description,
  cta,
  align = 'center',
  tone = 'default',
  hideRule = false,
  as: Heading = 'h2',
  className,
  id,
}: SectionTitleProps) {
  const centered = align === 'center';

  return (
    <motion.div
      {...reveal(fadeUp)}
      className={cn(
        'flex flex-col',
        centered ? 'items-center text-center' : 'items-start text-left',
        cta && !centered && 'sm:flex-row sm:items-end sm:justify-between sm:gap-8',
        className,
      )}
    >
      <div className={cn('flex flex-col', centered ? 'items-center' : 'items-start')}>
        {eyebrow && (
          <p className={cn('eyebrow', tone === 'light' ? 'text-primary-soft' : 'text-primary-strong')}>
            {eyebrow}
          </p>
        )}

        <Heading
          id={id}
          className={cn(
            'mt-4 text-h2',
            tone === 'light' ? 'text-light' : 'text-ink',
            centered ? 'max-w-3xl' : 'max-w-2xl',
          )}
        >
          {title}
        </Heading>

        {subtitle && (
          <p
            className={cn(
              'mt-3 font-display text-h4 italic',
              tone === 'light' ? 'text-light/80' : 'text-primary-strong',
            )}
          >
            {subtitle}
          </p>
        )}

        {!hideRule && <div className={cn('hairline-gold mt-6 w-24', centered && 'mx-auto')} />}

        {description && (
          <p
            className={cn(
              'mt-7 max-w-2xl text-body-lg font-light',
              tone === 'light' ? 'text-light/70' : 'text-ink-soft',
            )}
          >
            {description}
          </p>
        )}
      </div>

      {cta && (
        <Link
          href={cta.href}
          className={cn(
            'group mt-8 inline-flex items-center gap-2 text-[0.6875rem] font-medium tracking-[0.16em] uppercase sm:mt-0',
            tone === 'light' ? 'text-light' : 'text-ink',
            centered && 'sm:mt-8',
          )}
        >
          {cta.label}
          <ArrowRight className="size-3.5 transition-transform duration-[320ms] group-hover:translate-x-1" />
        </Link>
      )}
    </motion.div>
  );
}
