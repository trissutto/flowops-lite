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
  compact = false,
  className,
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  /**
   * Etiqueta para card de slot estreito (a grade da home, 3 colunas no
   * celular). A `.eyebrow` é 11px com 0,32em de tracking — desenhada pra
   * respirar numa linha larga. Com `px-3` ela faz "Promoção" medir 117px, e
   * ali o card tem 91px num aparelho de 360: a etiqueta estourava a moldura e
   * era CORTADA no meio da palavra pelo `overflow-hidden` da foto, sem
   * reticências, porque etiqueta é posicionada e não encolhe sozinha.
   *
   * 10px com 0,12em levam a mesma palavra pra 67px de TEXTO — e 10px é o menor
   * corpo que o projeto já usa (pílula de tamanho, "+N" das cores), não um
   * tamanho novo inventado aqui. O `max-w-full` é a rede para os rótulos
   * longos ("Últimas peças", "Preço especial"), que nem assim caberiam numa
   * linha: quebram DENTRO da pílula em vez de vazar pra fora do card.
   *
   * O `px-1` abaixo de 420px NÃO é gosto, é o único jeito de a pílula caber
   * inteira no aparelho de 360. Ali o card tem 91,5px, o que dá 75,8px de
   * `max-w-full`; "PROMOÇÃO" com `px-2` pede 83,1px, então o `max-w` CLAMPA a
   * pílula e a palavra passa por cima do próprio respiro — sobra 0,8px de
   * padding à direita contra 8px à esquerda, e a palavra encosta na curva.
   * Com 4px de cada lado ela pede 75,1px e cabe, simétrica. De 420px pra cima
   * (`--breakpoint-xs`, "large mobile") o card já tem 111px e o respiro de 8px
   * volta — é a primeira vez que o projeto usa esse breakpoint, e é o caso
   * exato pro qual ele foi declarado.
   */
  compact?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-pill backdrop-blur-sm',
        compact
          ? 'max-w-full px-1 py-0.5 text-center text-[0.625rem] leading-[1.5] font-medium tracking-[0.12em] uppercase xs:px-2'
          : 'eyebrow px-3 py-1',
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

export function ProductBadgeTag({ badge, compact = false }: { badge: ProductBadge; compact?: boolean }) {
  const conf = PRODUCT_BADGES[badge];
  return <Badge tone={conf.tone} compact={compact}>{conf.label}</Badge>;
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
