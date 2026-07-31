import { forwardRef } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * Button — pill, caixa-alta, tracking largo. É a peça que mais se repete
 * no site, então as variantes aqui definem a linguagem de ação da marca.
 *
 * - primary   → ink, hover dourado. Ação principal.
 * - secondary → outline dourado. Ação alternativa.
 * - ghost     → sem caixa. Ação terciária/inline.
 * - light     → branco sobre foto (hero).
 * - outlineLight → contorno branco sobre foto.
 * - whatsapp  → verde. CONVENÇÃO: verde só pra WhatsApp/dinheiro.
 *
 * Passe `href` pra renderizar como <Link> mantendo o mesmo visual.
 */

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'light'
  | 'outlineLight'
  | 'whatsapp';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-light hover:bg-primary-strong',
  secondary: 'border border-primary text-primary-strong hover:bg-primary-wash',
  ghost: 'text-ink hover:text-primary-strong',
  light: 'bg-light text-ink hover:bg-primary-soft',
  // Sobre foto o contorno sozinho some nas áreas claras da imagem — o véu
  // escuro com blur garante legibilidade sem virar um botão sólido.
  outlineLight:
    'border border-light/70 bg-ink/25 text-light backdrop-blur-sm hover:border-light hover:bg-ink/40',
  whatsapp: 'bg-success text-light hover:bg-success-strong',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'px-4 py-2.5 text-[0.6875rem]',
  md: 'px-6 py-3.5 text-button',
  lg: 'px-9 py-4 text-button',
};

const BASE =
  'inline-flex items-center justify-center gap-2.5 rounded-pill font-medium uppercase tracking-[0.16em] ' +
  'transition-all duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)] ' +
  'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0';

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Ocupa toda a largura disponível (padrão no mobile). */
  block?: boolean;
  className?: string;
  children: React.ReactNode;
}

type ButtonProps = CommonProps &
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> & {
    href?: undefined;
  };

type AnchorProps = CommonProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'children' | 'href'> & {
    href: string;
    /** Abre em nova aba com rel seguro. */
    external?: boolean;
  };

export const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps | AnchorProps>(
  function Button(props, ref) {
    const { variant = 'primary', size = 'md', block, className, children, ...rest } = props;
    const classes = cn(BASE, VARIANTS[variant], SIZES[size], block && 'w-full', className);

    if (rest.href !== undefined) {
      const { href, external, ...anchorProps } = rest as Omit<AnchorProps, keyof CommonProps>;
      return (
        <Link
          ref={ref as React.Ref<HTMLAnchorElement>}
          href={href}
          className={classes}
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          {...anchorProps}
        >
          {children}
        </Link>
      );
    }

    // `href` é undefined neste ramo (união discriminada) — não vai pro DOM.
    const buttonProps = rest as Omit<ButtonProps, keyof CommonProps | 'href'>;
    return (
      <button ref={ref as React.Ref<HTMLButtonElement>} className={classes} {...buttonProps}>
        {children}
      </button>
    );
  },
);

/** Botão só-ícone. `label` é obrigatório — vira aria-label. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
    label: string;
    className?: string;
    children: React.ReactNode;
  }
>(function IconButton({ label, className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      aria-label={label}
      className={cn(
        'inline-flex items-center justify-center rounded-pill p-2.5 text-ink transition-colors duration-[180ms]',
        'hover:bg-surface-alt hover:text-primary-strong [&_svg]:size-[18px]',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
