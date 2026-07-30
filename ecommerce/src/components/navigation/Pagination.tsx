'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Pagination — alternativa tradicional ao infinite scroll (a listagem oferece
 * as duas; ver docs/category-page.md). Sempre renderiza links reais quando
 * `hrefFor` é passado, pra o Google rastrear as páginas.
 */

function pageWindow(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | '…')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push('…');
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < total - 1) pages.push('…');
  pages.push(total);
  return pages;
}

export function Pagination({
  page,
  totalPages,
  onChange,
  hrefFor,
  className,
}: {
  page: number;
  totalPages: number;
  onChange?: (page: number) => void;
  hrefFor?: (page: number) => string;
  className?: string;
}) {
  if (totalPages <= 1) return null;

  const items = pageWindow(page, totalPages);

  const cellClass = (active: boolean) =>
    cn(
      'tabular flex size-10 items-center justify-center rounded-pill text-small transition-colors',
      active
        ? 'bg-ink text-light'
        : 'text-ink-soft hover:bg-surface-alt hover:text-ink',
    );

  function Cell({ value }: { value: number }) {
    const active = value === page;
    if (hrefFor && !active) {
      return (
        <a href={hrefFor(value)} className={cellClass(false)} aria-label={`Página ${value}`}>
          {value}
        </a>
      );
    }
    return (
      <button
        type="button"
        onClick={() => onChange?.(value)}
        aria-current={active ? 'page' : undefined}
        aria-label={`Página ${value}`}
        className={cellClass(active)}
      >
        {value}
      </button>
    );
  }

  return (
    <nav aria-label="Paginação" className={cn('flex items-center justify-center gap-1', className)}>
      <button
        type="button"
        onClick={() => onChange?.(page - 1)}
        disabled={page <= 1}
        aria-label="Página anterior"
        className="flex size-10 items-center justify-center rounded-pill text-ink-soft transition-colors hover:bg-surface-alt hover:text-ink disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronLeft className="size-4" />
      </button>
      {items.map((item, i) =>
        item === '…' ? (
          <span key={`gap-${i}`} className="px-1 text-ink-muted" aria-hidden>
            …
          </span>
        ) : (
          <Cell key={item} value={item} />
        ),
      )}
      <button
        type="button"
        onClick={() => onChange?.(page + 1)}
        disabled={page >= totalPages}
        aria-label="Próxima página"
        className="flex size-10 items-center justify-center rounded-pill text-ink-soft transition-colors hover:bg-surface-alt hover:text-ink disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronRight className="size-4" />
      </button>
    </nav>
  );
}
