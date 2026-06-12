'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, ShoppingBag, Wallet, User } from 'lucide-react';
import clsx from 'clsx';

/**
 * Bottom Navigation — barra fixa inferior estilo iOS/Android nativo.
 * Mostra 4 abas principais. Ativa via highlight dourado.
 *
 * Posicionamento respeita safe-area-inset-bottom (iPhone notch).
 */
export default function BottomNav() {
  const path = usePathname();

  const items = [
    { href: '/', icon: Home, label: 'Início' },
    { href: '/catalogo', icon: ShoppingBag, label: 'Catálogo' },
    { href: '/cashback', icon: Wallet, label: 'Cashback' },
    { href: '/conta', icon: User, label: 'Conta' },
  ];

  return (
    <nav
      className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-app
                 bg-ink/95 backdrop-blur-md border-t border-ink-600
                 z-40"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="grid grid-cols-4 px-2 py-2">
        {items.map(({ href, icon: Icon, label }) => {
          const active = href === '/' ? path === '/' : path.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                'flex flex-col items-center gap-0.5 py-2 rounded-xl transition-colors touch-tap',
                active
                  ? 'text-gold'
                  : 'text-cream/50 hover:text-cream/80',
              )}
            >
              <Icon className={clsx('w-5 h-5', active && 'drop-shadow-[0_0_8px_rgba(201,169,97,0.5)]')} />
              <span className="text-[10px] font-bold uppercase tracking-wider">
                {label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
