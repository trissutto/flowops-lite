'use client';

import { useId, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { transition } from '@/lib/motion';

/**
 * Tooltip — só para complementos curtos (nunca informação essencial).
 * Abre no hover E no foco, pra funcionar por teclado.
 */
export function Tooltip({
  content,
  side = 'top',
  children,
  className,
}: {
  content: string;
  side?: 'top' | 'bottom';
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span
      className={cn('relative inline-flex', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined}>{children}</span>
      <motion.span
        id={id}
        role="tooltip"
        aria-hidden={!open}
        initial={{ opacity: 0, y: side === 'top' ? 4 : -4 }}
        animate={{ opacity: open ? 1 : 0, y: open ? 0 : side === 'top' ? 4 : -4 }}
        transition={transition.fast}
        className={cn(
          'pointer-events-none absolute left-1/2 z-[var(--z-tooltip)] -translate-x-1/2 rounded-sm bg-ink px-2.5 py-1.5 text-[11px] whitespace-nowrap text-light',
          side === 'top' ? 'bottom-[calc(100%+8px)]' : 'top-[calc(100%+8px)]',
        )}
      >
        {content}
      </motion.span>
    </span>
  );
}
