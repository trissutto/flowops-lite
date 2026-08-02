import { AppLink as Link } from '@/components/ui/AppLink';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Breadcrumb — trilha discreta. O JSON-LD correspondente é responsabilidade
 * da página (breadcrumbSchema em lib/seo.ts), não deste componente.
 */

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumb({
  items,
  /** Sobre foto escura (hero) usa a variante clara. */
  tone = 'default',
  className,
}: {
  items: Crumb[];
  tone?: 'default' | 'light';
  className?: string;
}) {
  return (
    <nav aria-label="Você está em" className={className}>
      <ol
        className={cn(
          'flex flex-wrap items-center gap-2 text-small',
          tone === 'light' ? 'text-light/75' : 'text-ink-muted',
        )}
      >
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-2">
              {item.href && !isLast ? (
                <Link
                  href={item.href}
                  className={cn(
                    'transition-colors',
                    tone === 'light' ? 'hover:text-light' : 'hover:text-ink',
                  )}
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={isLast ? 'page' : undefined}
                  className={tone === 'light' ? 'text-light' : 'text-ink'}
                >
                  {item.label}
                </span>
              )}
              {!isLast && <ChevronRight className="size-3 opacity-50" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
