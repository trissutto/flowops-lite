'use client';

import { AppLink as Link } from '@/components/ui/AppLink';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';

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
  /** Título mais curto exibido apenas no mobile. */
  mobileTitle?: React.ReactNode;
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
  /** Compacta título, CTA e elementos decorativos no mobile. */
  compactMobile?: boolean;
  /** Variação tipográfica restrita a títulos editoriais, como vitrines da home. */
  titleFont?: 'display' | 'editorial';
}

export function SectionTitle({
  eyebrow,
  title,
  mobileTitle,
  subtitle,
  description,
  cta,
  align = 'center',
  tone = 'default',
  hideRule = false,
  as: Heading = 'h2',
  className,
  id,
  compactMobile = false,
  titleFont = 'display',
}: SectionTitleProps) {
  const centered = align === 'center';

  return (
    <div
      className={cn(
        'flex flex-col',
        centered ? 'items-center text-center' : 'items-start text-left',
        compactMobile && cta && !centered && 'flex-row items-end justify-between gap-4',
        cta && !centered && 'sm:flex-row sm:items-end sm:justify-between sm:gap-8',
        className,
      )}
    >
      <div className={cn('flex min-w-0 flex-col', centered ? 'items-center' : 'items-start')}>
        {eyebrow && (
          <p className={cn('eyebrow', compactMobile && 'hidden sm:block', tone === 'light' ? 'text-primary-soft' : 'text-primary-strong')}>
            {eyebrow}
          </p>
        )}

        <Heading
          id={id}
          className={cn(
            compactMobile ? 'mt-0 text-h2 sm:mt-4' : 'mt-4 text-h2',
            titleFont === 'editorial'
              ? 'font-editorial font-medium leading-[1.05] tracking-[-0.015em]'
              : 'font-display',
            tone === 'light' ? 'text-light' : 'text-ink',
            centered ? 'max-w-3xl' : 'max-w-2xl',
          )}
        >
          {mobileTitle ? (
            <>
              <span className="sm:hidden">{mobileTitle}</span>
              <span className="hidden sm:inline">{title}</span>
            </>
          ) : title}
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

        {!hideRule && <div className={cn('hairline-gold mt-6 w-24', centered && 'mx-auto', compactMobile && 'hidden sm:block')} />}

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
            'group mt-8 inline-flex shrink-0 items-center gap-2 text-[0.6875rem] font-medium tracking-[0.16em] uppercase sm:mt-0',
            compactMobile && 'mt-0',
            tone === 'light' ? 'text-light' : 'text-ink',
            centered && 'sm:mt-8',
          )}
        >
          {cta.label}
          <ArrowRight className="size-3.5 transition-transform duration-[320ms] group-hover:translate-x-1" />
        </Link>
      )}
    </div>
  );
}
