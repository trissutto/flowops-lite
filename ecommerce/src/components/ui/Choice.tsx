'use client';

import { forwardRef, useId } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Controles de escolha — Checkbox, Radio, Switch, ColorSwatch, SizePill.
 *
 * Padrão: o input nativo fica dentro da <label>, visualmente oculto com
 * `sr-only` (nunca display:none — perderia o foco de teclado) e marcado como
 * `peer`. A caixa desenhada é o irmão seguinte e reage com `peer-checked:`.
 */

const BOX =
  'flex size-[18px] shrink-0 items-center justify-center rounded-xs border border-border-strong bg-surface ' +
  'transition-colors duration-[180ms] peer-checked:border-primary peer-checked:bg-primary ' +
  'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary';

type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> & {
  label: React.ReactNode;
  /** Contagem à direita (filtros: "Vestidos · 128"). */
  count?: number;
  className?: string;
};

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, count, className, id: idProp, ...rest },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? autoId;

  return (
    <label
      htmlFor={id}
      className={cn(
        'group flex cursor-pointer items-center gap-3 text-body text-ink-soft transition-colors hover:text-ink',
        className,
      )}
    >
      <input ref={ref} id={id} type="checkbox" className="peer sr-only" {...rest} />
      <span aria-hidden className={cn(BOX, '[&>svg]:opacity-0 peer-checked:[&>svg]:opacity-100')}>
        <Check className="size-3 text-light transition-opacity duration-[180ms]" strokeWidth={3} />
      </span>
      <span className="flex-1">{label}</span>
      {count !== undefined && <span className="tabular text-small text-ink-muted">{count}</span>}
    </label>
  );
});

type RadioProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> & {
  label: React.ReactNode;
  className?: string;
};

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { label, className, id: idProp, ...rest },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? autoId;

  return (
    <label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer items-center gap-3 text-body text-ink-soft transition-colors hover:text-ink',
        className,
      )}
    >
      <input ref={ref} id={id} type="radio" className="peer sr-only" {...rest} />
      <span
        aria-hidden
        className={cn(
          'flex size-[18px] shrink-0 items-center justify-center rounded-pill border border-border-strong bg-surface',
          'transition-colors duration-[180ms] peer-checked:border-primary',
          'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary',
          '[&>span]:scale-0 peer-checked:[&>span]:scale-100',
        )}
      >
        <span className="size-2 rounded-pill bg-primary transition-transform duration-[180ms]" />
      </span>
      <span>{label}</span>
    </label>
  );
});

type SwitchProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> & {
  label: React.ReactNode;
  className?: string;
};

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, className, id: idProp, ...rest },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? autoId;

  return (
    <label
      htmlFor={id}
      className={cn('flex cursor-pointer items-center justify-between gap-4', className)}
    >
      <span className="text-body text-ink-soft">{label}</span>
      <input ref={ref} id={id} type="checkbox" role="switch" className="peer sr-only" {...rest} />
      <span
        aria-hidden
        className={cn(
          'relative h-6 w-11 shrink-0 rounded-pill bg-border-strong transition-colors duration-[180ms] peer-checked:bg-primary',
          'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary',
          '[&>span]:translate-x-0 peer-checked:[&>span]:translate-x-5',
        )}
      >
        <span className="absolute top-1 left-1 size-4 rounded-pill bg-surface shadow-xs transition-transform duration-[180ms]" />
      </span>
    </label>
  );
});

/** Swatch de cor pro filtro — o próprio círculo é o controle. */
export function ColorSwatch({
  hex,
  name,
  selected,
  onSelect,
}: {
  hex: string;
  name: string;
  selected?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={name}
      title={name}
      className={cn(
        'size-7 rounded-pill border transition-all duration-[180ms]',
        selected
          ? 'border-primary ring-1 ring-primary ring-offset-2'
          : 'border-border-strong hover:border-primary',
      )}
      style={{ backgroundColor: hex }}
    />
  );
}

/** Pílula de tamanho — usada no filtro, no card e na página de produto. */
export function SizePill({
  label,
  selected,
  disabled,
  onSelect,
  size = 'md',
}: {
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  /** `lg` na PDP: é a decisão principal da página e merece alvo maior. */
  size?: 'md' | 'lg';
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={disabled ? `Tamanho ${label} esgotado` : `Tamanho ${label}`}
      className={cn(
        'tabular rounded-sm border font-medium transition-all duration-[180ms]',
        // `lg` cresceu (dono, 17/08): a pílula de tamanho é o controle que
        // decide a compra — 64% de quem toca nela põe na sacola. Alvo maior
        // é menos erro de dedo, e a grade cabe em 3 por linha no celular.
        size === 'lg' ? 'min-w-16 px-5 py-3.5 text-h5 font-medium' : 'min-w-11 px-3 py-2 text-small',
        /* Esgotado TEM que gritar (dono, 14/08: "quase não dá pra ver"): o
           line-through fino em texto 50% passava batido. Agora a pílula
           inteira leva um traço diagonal (gradiente em currentColor — segue o
           tom do texto nos dois temas) sobre fundo lavado e borda tracejada:
           lê como "riscado do mapa" a um metro do celular. */
        disabled &&
          'cursor-not-allowed border-dashed border-border bg-surface-alt/70 text-ink-muted ' +
            'bg-[linear-gradient(to_top_right,transparent_calc(50%-0.8px),currentColor_calc(50%-0.8px),currentColor_calc(50%+0.8px),transparent_calc(50%+0.8px))]',
        !disabled && selected && 'border-ink bg-ink text-light',
        !disabled &&
          !selected &&
          'border-border-strong text-ink hover:border-primary hover:text-primary-strong',
      )}
    >
      {label}
    </button>
  );
}
