'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { navigation } from '@/data/navigation';
import { MegaMenu } from './MegaMenu';

/**
 * Navigation — menu principal do desktop com mega menu por hover/foco.
 *
 * Detalhes que importam:
 * - O painel abre no hover COM pequeno atraso na saída (120ms). Sem isso, o
 *   menu fecha quando o mouse atravessa o gap entre o item e o painel.
 * - Abre também por foco de teclado e fecha com Esc.
 * - O painel vive fora do <ul> (posicionado absoluto no wrapper) pra ocupar a
 *   largura inteira da viewport.
 */
export function Navigation() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathname = usePathname();

  function open(index: number) {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpenIndex(index);
  }

  function scheduleClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpenIndex(null), 120);
  }

  function closeNow() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpenIndex(null);
  }

  const activeItem = openIndex !== null ? navigation[openIndex] : null;

  return (
    <div
      onMouseLeave={scheduleClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') closeNow();
      }}
    >
      <nav aria-label="Navegação principal">
        <ul className="flex items-center gap-7 xl:gap-9">
          {navigation.map((item, index) => {
            const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const isOpen = openIndex === index;

            return (
              <li key={item.href} onMouseEnter={() => open(index)} onFocus={() => open(index)}>
                <Link
                  href={item.href}
                  data-active={isActive || isOpen}
                  aria-expanded={item.menu ? isOpen : undefined}
                  className={cn(
                    'link-underline block py-2 text-[0.8125rem] font-light tracking-[0.02em] whitespace-nowrap transition-colors',
                    isActive || isOpen ? 'text-ink' : 'text-ink-soft hover:text-ink',
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {activeItem?.menu && (
        <div className="absolute inset-x-0 top-full" onMouseEnter={() => open(openIndex!)}>
          <MegaMenu item={activeItem} onNavigate={closeNow} />
        </div>
      )}
    </div>
  );
}
