'use client';

import { cn } from '@/lib/utils';
import { Overlay } from './Overlay';

/**
 * Drawer — painel lateral (ou de baixo no mobile). Usado pelo menu mobile,
 * filtros e mini-carrinho. Estrutura fixa: header opcional, corpo rolável,
 * rodapé fixo pros CTAs.
 */

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  label: string;
  side?: 'right' | 'left' | 'bottom';
  /** Largura no desktop. */
  size?: 'sm' | 'md' | 'lg';
  header?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

const SIZES = {
  sm: 'w-full sm:w-[380px]',
  md: 'w-full sm:w-[min(460px,92vw)]',
  lg: 'w-full sm:w-[min(560px,92vw)] lg:w-[42vw]',
} as const;

export function Drawer({
  open,
  onClose,
  label,
  side = 'right',
  size = 'md',
  header,
  footer,
  children,
  className,
}: DrawerProps) {
  return (
    <Overlay
      open={open}
      onClose={onClose}
      side={side}
      label={label}
      className={cn(side === 'bottom' ? 'max-h-[88vh] rounded-t-xl' : SIZES[size], className)}
    >
      {header && (
        <div className="shrink-0 border-b border-border px-6 pt-7 pr-16 pb-5">{header}</div>
      )}
      <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-6">{children}</div>
      {footer && (
        <div className="shrink-0 border-t border-border bg-surface/95 px-6 py-5 backdrop-blur">
          {footer}
        </div>
      )}
    </Overlay>
  );
}
