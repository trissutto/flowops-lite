import { cn } from '@/lib/utils';
import type { ProductBadge } from '@/types';

/**
 * Badge (etiqueta sobre a foto) e Chip (pílula removível de filtro ativo).
 * As etiquetas de produto têm cor fixa por significado — nunca improvisar.
 */

const BADGE_TONES = {
  neutral: 'bg-ink/90 text-light',
  gold: 'bg-primary-strong/95 text-light',
  wine: 'bg-secondary/95 text-light',
  light: 'bg-light/95 text-ink',
  success: 'bg-success/95 text-light',
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'eyebrow inline-flex items-center rounded-pill px-3 py-1 backdrop-blur-sm',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Mapa oficial etiqueta → rótulo + cor. */
const PRODUCT_BADGES: Record<ProductBadge, { label: string; tone: BadgeTone }> = {
  novo: { label: 'Novo', tone: 'neutral' },
  promocao: { label: 'Promoção', tone: 'wine' },
  'preco-especial': { label: 'Preço especial', tone: 'gold' },
  'best-seller': { label: 'Best seller', tone: 'gold' },
  exclusivo: { label: 'Exclusivo', tone: 'gold' },
  'loja-fisica': { label: 'Na loja física', tone: 'light' },
  'ultimas-pecas': { label: 'Últimas peças', tone: 'wine' },
};

export function ProductBadgeTag({ badge }: { badge: ProductBadge }) {
  const conf = PRODUCT_BADGES[badge];
  return <Badge tone={conf.tone}>{conf.label}</Badge>;
}

/** Chip de filtro ativo — clicar remove. */
export function Chip({
  children,
  onRemove,
  className,
}: {
  children: React.ReactNode;
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-pill border border-border bg-surface py-1.5 pr-2 pl-3.5 text-small text-ink-soft',
        className,
      )}
    >
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remover filtro"
          className="flex size-5 items-center justify-center rounded-pill text-ink-muted transition-colors hover:bg-surface-alt hover:text-ink"
        >
          <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden>
            <path
              d="M1 1l8 8M9 1L1 9"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </button>
      )}
    </span>
  );
}
