import { cn } from '@/lib/utils';

/**
 * Card — casca genérica (superfície + borda + sombra + hover opcional).
 * Cards de domínio (ProductCard, StoreCard…) compõem esta base.
 */

interface CardProps {
  /** Aplica o hover premium da marca: sobe 6px e aprofunda a sombra. */
  interactive?: boolean;
  /** Sem padding interno — quando o conteúdo é uma foto sangrada. */
  flush?: boolean;
  className?: string;
  children: React.ReactNode;
  as?: 'div' | 'article' | 'li';
}

export function Card({
  interactive = false,
  flush = false,
  className,
  children,
  as: Tag = 'div',
}: CardProps) {
  return (
    <Tag
      className={cn(
        'overflow-hidden rounded-lg border border-border bg-surface shadow-sm',
        !flush && 'p-6',
        interactive &&
          'transition-all duration-[560ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-1.5 hover:border-primary/50 hover:shadow-gold',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** Avatar circular com fallback de iniciais. */
export function Avatar({
  name,
  src,
  size = 'md',
  className,
}: {
  name: string;
  src?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const sizes = { sm: 'size-8 text-[11px]', md: 'size-11 text-small', lg: 'size-14 text-body' };
  const initials = name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-pill bg-champagne font-medium text-primary-strong',
        sizes[size],
        className,
      )}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- avatar externo pequeno, sem otimização necessária
        <img src={src} alt={name} className="size-full object-cover" loading="lazy" />
      ) : (
        <span aria-hidden>{initials}</span>
      )}
      {src ? null : <span className="sr-only">{name}</span>}
    </span>
  );
}
