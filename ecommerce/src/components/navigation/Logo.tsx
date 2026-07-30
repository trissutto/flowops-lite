import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * Logo — lettering tipográfico (Playfair + eyebrow). Enquanto o SVG oficial
 * da marca não chega, o desenho é feito em tipo, o que mantém nitidez em
 * qualquer densidade de tela e zero requisição extra.
 *
 * variant: horizontal (padrão) · compact (só o monograma, header reduzido)
 * tone: dark (sobre claro) · light (sobre foto/fundo escuro)
 */

interface LogoProps {
  variant?: 'horizontal' | 'compact';
  tone?: 'dark' | 'light';
  /** Renderiza como <h1> na home; link nas outras páginas. */
  asHeading?: boolean;
  className?: string;
}

export function Logo({
  variant = 'horizontal',
  tone = 'dark',
  asHeading = false,
  className,
}: LogoProps) {
  const inner =
    variant === 'compact' ? (
      <span
        aria-hidden
        className={cn(
          'font-display text-[1.75rem] leading-none font-medium italic',
          tone === 'light' ? 'text-light' : 'text-ink',
        )}
      >
        L
      </span>
    ) : (
      <span className="flex flex-col items-center leading-none">
        <span
          aria-hidden
          className={cn(
            'font-display text-[1.5rem] font-medium tracking-[0.06em] sm:text-[1.75rem]',
            tone === 'light' ? 'text-light' : 'text-ink',
          )}
        >
          LURD&apos;S
        </span>
        <span
          aria-hidden
          className={cn(
            'eyebrow mt-1 text-[0.5rem] tracking-[0.42em]',
            tone === 'light' ? 'text-light/70' : 'text-primary-strong',
          )}
        >
          PLUS SIZE
        </span>
      </span>
    );

  const content = (
    <>
      {inner}
      <span className="sr-only">Lurd&apos;s Plus Size — página inicial</span>
    </>
  );

  if (asHeading) {
    return (
      <h1 className={cn('inline-flex', className)}>
        <Link href="/" className="inline-flex items-center">
          {content}
        </Link>
      </h1>
    );
  }

  return (
    <Link href="/" className={cn('inline-flex items-center', className)}>
      {content}
    </Link>
  );
}
