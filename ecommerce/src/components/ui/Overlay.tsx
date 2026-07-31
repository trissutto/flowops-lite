'use client';

import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEscapeKey, useFocusTrap, useLockScroll } from '@/hooks';
import { transition } from '@/lib/motion';

/**
 * OVERLAY — primitivo compartilhado por Modal e Drawer.
 *
 * Decisão de arquitetura: o painel fica SEMPRE montado depois da primeira
 * abertura e anima por estado (`open`), em vez de montar/desmontar com
 * AnimatePresence. Motivo: unmount-após-exit depende de rAF e falha em
 * ambientes onde o frame não é composto (aba em background, headless),
 * deixando o painel órfão no DOM. Com `inert` + `pointer-events: none` o
 * painel fechado sai da ordem de tab e da árvore de acessibilidade, que é o
 * que realmente importa. Ver docs/animations.md.
 */

type Side = 'right' | 'left' | 'bottom' | 'center';

const PANEL_POSITION: Record<Side, string> = {
  right: 'inset-y-0 right-0 h-full',
  left: 'inset-y-0 left-0 h-full',
  bottom: 'inset-x-0 bottom-0 w-full',
  center: 'inset-0 m-auto h-fit max-h-[90vh]',
};

function hiddenTransform(side: Side) {
  switch (side) {
    case 'right':
      return { x: '100%', opacity: 1 };
    case 'left':
      return { x: '-100%', opacity: 1 };
    case 'bottom':
      return { y: '100%', opacity: 1 };
    case 'center':
      return { y: 12, opacity: 0, scale: 0.98 };
  }
}

function visibleTransform(side: Side) {
  return side === 'center' ? { y: 0, opacity: 1, scale: 1 } : { x: '0%', y: '0%', opacity: 1 };
}

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  side?: Side;
  /** Título acessível — obrigatório: vira aria-label do dialog. */
  label: string;
  /** Mostra o botão X flutuante padrão. */
  showClose?: boolean;
  className?: string;
  children: React.ReactNode;
  /** z-index token: drawer (60) ou modal (70). */
  layer?: 'drawer' | 'modal';
}

export function Overlay({
  open,
  onClose,
  side = 'right',
  label,
  showClose = true,
  className,
  children,
  layer = 'drawer',
}: OverlayProps) {
  const panelRef = useFocusTrap<HTMLDivElement>(open);
  const inertRef = useRef<HTMLDivElement | null>(null);

  useLockScroll(open);
  useEscapeKey(open, onClose);

  // Painel fechado sai da navegação por teclado e do leitor de tela.
  useEffect(() => {
    if (inertRef.current) inertRef.current.inert = !open;
  }, [open]);

  const zBackdrop = layer === 'modal' ? 'z-[var(--z-overlay)]' : 'z-[var(--z-overlay)]';
  const zPanel = layer === 'modal' ? 'z-[var(--z-modal)]' : 'z-[var(--z-drawer)]';

  return (
    <>
      <motion.div
        aria-hidden
        onClick={onClose}
        animate={{ opacity: open ? 1 : 0 }}
        initial={{ opacity: 0 }}
        transition={transition.base}
        style={{ pointerEvents: open ? 'auto' : 'none' }}
        className={cn('fixed inset-0 bg-ink/40 backdrop-blur-sm', zBackdrop)}
      />
      <motion.div
        ref={(node) => {
          inertRef.current = node;
          (panelRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-hidden={!open}
        initial={hiddenTransform(side)}
        animate={open ? visibleTransform(side) : hiddenTransform(side)}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        style={{ pointerEvents: open ? 'auto' : 'none' }}
        className={cn(
          'fixed flex flex-col bg-background shadow-xl',
          PANEL_POSITION[side],
          zPanel,
          className,
        )}
      >
        {showClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="absolute top-5 right-5 z-10 flex size-10 items-center justify-center rounded-pill bg-surface/90 text-ink shadow-sm backdrop-blur transition-colors hover:bg-surface"
          >
            <X className="size-4" strokeWidth={2} />
          </button>
        )}
        {children}
      </motion.div>
    </>
  );
}
