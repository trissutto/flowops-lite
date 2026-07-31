import { cn } from '@/lib/utils';

/**
 * Skeletons premium — shimmer champagne, nunca cinza. A silhueta precisa
 * ser a mesma do conteúdo final pra não haver salto de layout (CLS).
 */

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('shimmer rounded-sm', className)} />;
}

/** Placeholder de um ProductCard — mesma proporção 3/4 + linhas de texto. */
export function ProductCardSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="aspect-3/4 w-full rounded-md" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-2.5 w-20" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-24" />
      </div>
    </div>
  );
}

export function ProductGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Carregando produtos"
      className="grid grid-cols-2 gap-x-4 gap-y-10 lg:grid-cols-3 lg:gap-x-6 xl:grid-cols-4"
    >
      {Array.from({ length: count }, (_, i) => (
        <ProductCardSkeleton key={i} />
      ))}
    </div>
  );
}

export function CardSkeleton({ aspect = 'aspect-4/5' }: { aspect?: string }) {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className={cn('w-full rounded-md', aspect)} />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

/** Bloco de texto editorial carregando. */
export function TextSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3.5', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}
