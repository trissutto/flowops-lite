'use client';

import { useId, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { transition } from '@/lib/motion';

/**
 * Tabs — navegação por abas com indicador deslizante (layoutId do framer).
 * Teclado: setas ←/→ trocam de aba (padrão ARIA de tablist).
 */

export interface TabItem {
  value: string;
  label: string;
  content: React.ReactNode;
}

export function Tabs({
  items,
  defaultValue,
  className,
}: {
  items: TabItem[];
  defaultValue?: string;
  className?: string;
}) {
  const [active, setActive] = useState(defaultValue ?? items[0]?.value);
  const groupId = useId();

  function onKeyDown(event: React.KeyboardEvent) {
    const index = items.findIndex((i) => i.value === active);
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      setActive(items[(index + 1) % items.length].value);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setActive(items[(index - 1 + items.length) % items.length].value);
    }
  }

  return (
    <div className={className}>
      <div role="tablist" onKeyDown={onKeyDown} className="flex gap-8 border-b border-border">
        {items.map((item) => {
          const selected = item.value === active;
          return (
            <button
              key={item.value}
              role="tab"
              type="button"
              id={`${groupId}-tab-${item.value}`}
              aria-selected={selected}
              aria-controls={`${groupId}-panel-${item.value}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(item.value)}
              className={cn(
                'relative pb-3 text-small font-medium tracking-wide uppercase transition-colors',
                selected ? 'text-ink' : 'text-ink-muted hover:text-ink-soft',
              )}
            >
              {item.label}
              {selected && (
                <motion.span
                  layoutId={`${groupId}-indicator`}
                  transition={transition.base}
                  className="absolute inset-x-0 -bottom-px h-px bg-primary"
                />
              )}
            </button>
          );
        })}
      </div>
      {items.map((item) => (
        <div
          key={item.value}
          role="tabpanel"
          id={`${groupId}-panel-${item.value}`}
          aria-labelledby={`${groupId}-tab-${item.value}`}
          hidden={item.value !== active}
          className="pt-8"
        >
          {item.value === active && item.content}
        </div>
      ))}
    </div>
  );
}
