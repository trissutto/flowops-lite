'use client';

import { useId, useState } from 'react';
import { motion } from 'framer-motion';
import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { transition } from '@/lib/motion';

/**
 * Accordion — usado nos grupos de filtro e em FAQ/descrição de produto.
 * Altura anima via `height: auto` do framer (evita max-height mágico).
 */

interface AccordionItemProps {
  title: React.ReactNode;
  /** Aberto na primeira renderização. */
  defaultOpen?: boolean;
  /** Contador/resumo à direita do título (ex: filtros ativos). */
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function AccordionItem({
  title,
  defaultOpen = false,
  meta,
  children,
  className,
}: AccordionItemProps) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <div className={cn('border-b border-border', className)}>
      <h3>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          className="flex w-full items-center justify-between gap-4 py-4 text-left"
        >
          <span className="eyebrow text-ink">{title}</span>
          <span className="flex items-center gap-3">
            {meta}
            {open ? (
              <Minus className="size-4 shrink-0 text-primary-strong" strokeWidth={1.75} />
            ) : (
              <Plus className="size-4 shrink-0 text-primary-strong" strokeWidth={1.75} />
            )}
          </span>
        </button>
      </h3>
      <motion.div
        id={`${id}-panel`}
        role="region"
        initial={false}
        animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
        transition={transition.base}
        className="overflow-hidden"
      >
        <div className="pb-5">{children}</div>
      </motion.div>
    </div>
  );
}

export function Accordion({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('border-t border-border', className)}>{children}</div>;
}
