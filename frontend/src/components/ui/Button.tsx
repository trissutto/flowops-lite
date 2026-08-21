'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'ghost' | 'quiet' | 'danger';
type Size = 'sm' | 'md' | 'lg';

/**
 * Botão do sistema Semáforo.
 *
 * `primary` é GRAFITE, não colorido: no Semáforo cor pertence ao estado, e um
 * botão azul/verde roubaria a atenção que a linha vermelha precisa ter.
 * `danger` é a única exceção — ali o vermelho está dizendo o que a ação faz.
 *
 * `lg` existe pro balcão (alvo de 44px+ pra dedo com pressa). Retaguarda usa
 * `md`; tabela densa usa `sm`.
 */
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-action text-action-ink border-action hover:brightness-125',
  ghost:   'bg-line-soft text-ink-soft border-line hover:bg-line hover:text-ink',
  quiet:   'bg-transparent text-ink-soft border-transparent hover:bg-line-soft hover:text-ink',
  danger:  'bg-crit text-white border-crit hover:brightness-110',
};

const SIZES: Record<Size, string> = {
  sm: 'text-xs px-3 py-1.5 gap-1.5',
  md: 'text-[13px] px-3.5 py-2 gap-2',
  lg: 'text-[15px] px-4 py-2.5 gap-2 min-h-[44px]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children?: ReactNode;
}

export default function Button({
  variant = 'ghost',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center rounded-field border font-semibold',
        'transition-colors disabled:opacity-45 disabled:pointer-events-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-1',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}
