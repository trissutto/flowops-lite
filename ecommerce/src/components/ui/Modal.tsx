'use client';

import { cn } from '@/lib/utils';
import { Overlay } from './Overlay';

/**
 * Modal — diálogo centralizado. Usado com parcimônia (Quick View, confirmações).
 * Para conteúdo longo prefira Drawer: rola melhor no mobile.
 */

interface ModalProps {
  open: boolean;
  onClose: () => void;
  label: string;
  title?: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg';
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

const SIZES = {
  sm: 'w-[min(420px,92vw)]',
  md: 'w-[min(620px,92vw)]',
  lg: 'w-[min(920px,94vw)]',
} as const;

export function Modal({
  open,
  onClose,
  label,
  title,
  description,
  size = 'md',
  footer,
  children,
  className,
}: ModalProps) {
  return (
    <Overlay
      open={open}
      onClose={onClose}
      side="center"
      label={label}
      layer="modal"
      className={cn('overflow-hidden rounded-lg', SIZES[size], className)}
    >
      {(title || description) && (
        <div className="shrink-0 px-8 pt-9 pr-16">
          {title && <h2 className="font-display text-h3">{title}</h2>}
          {description && <p className="mt-2 text-body font-light text-ink-soft">{description}</p>}
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-8 py-7">{children}</div>
      {footer && <div className="shrink-0 border-t border-border px-8 py-5">{footer}</div>}
    </Overlay>
  );
}
