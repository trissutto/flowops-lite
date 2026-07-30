'use client';

import Link from 'next/link';
import { Heart, MapPin, Search, ShoppingBag, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMounted } from '@/hooks';
import { useWishlistCount } from '@/store/wishlist';
import { useCartCount } from '@/store/cart';
import { accountLinks } from '@/data/navigation';
import { useClickOutside } from '@/hooks';
import { useState } from 'react';
import { motion } from 'framer-motion';
import { transition } from '@/lib/motion';

/**
 * Ações do header — cada botão é um componente próprio (responsabilidade única).
 * Todos aceitam `tone` pra funcionar sobre foto (hero transparente) ou sobre
 * fundo sólido (header sticky).
 */

type Tone = 'dark' | 'light';

function actionClass(tone: Tone) {
  return cn(
    'relative inline-flex items-center justify-center rounded-pill p-2.5 transition-colors duration-[180ms]',
    tone === 'light'
      ? 'text-light hover:bg-light/10'
      : 'text-ink hover:bg-surface-alt hover:text-primary-strong',
  );
}

/** Contador sobreposto ao ícone. Só aparece depois da hidratação (localStorage). */
function CountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="tabular absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-pill bg-primary-strong px-1 text-[0.5625rem] leading-4 font-semibold text-light">
      {count > 9 ? '9+' : count}
    </span>
  );
}

export function SearchButton({ tone = 'dark', onClick }: { tone?: Tone; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Buscar" className={actionClass(tone)}>
      <Search className="size-[18px]" strokeWidth={1.5} />
    </button>
  );
}

export function StoreButton({ tone = 'dark' }: { tone?: Tone }) {
  return (
    <Link href="/lojas" aria-label="Nossas lojas" className={cn(actionClass(tone), 'hidden lg:inline-flex')}>
      <MapPin className="size-[18px]" strokeWidth={1.5} />
    </Link>
  );
}

export function WishlistButton({ tone = 'dark' }: { tone?: Tone }) {
  const mounted = useMounted();
  const count = useWishlistCount();

  return (
    <Link href="/conta/favoritos" aria-label={`Favoritos${mounted && count ? ` (${count})` : ''}`} className={actionClass(tone)}>
      <Heart className="size-[18px]" strokeWidth={1.5} />
      {mounted && <CountBadge count={count} />}
    </Link>
  );
}

export function CartButton({ tone = 'dark' }: { tone?: Tone }) {
  const mounted = useMounted();
  const count = useCartCount();

  return (
    <Link href="/carrinho" aria-label={`Sacola${mounted && count ? ` (${count} itens)` : ''}`} className={actionClass(tone)}>
      <ShoppingBag className="size-[18px]" strokeWidth={1.5} />
      {mounted && <CountBadge count={count} />}
    </Link>
  );
}

/** Menu da conta — dropdown discreto no desktop. */
export function UserMenu({ tone = 'dark' }: { tone?: Tone }) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside<HTMLDivElement>(open, () => setOpen(false));

  return (
    <div ref={ref} className="relative hidden lg:block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Minha conta"
        aria-expanded={open}
        aria-haspopup="menu"
        className={actionClass(tone)}
      >
        <User className="size-[18px]" strokeWidth={1.5} />
      </button>

      <motion.div
        role="menu"
        aria-hidden={!open}
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: open ? 1 : 0, y: open ? 0 : -8 }}
        transition={transition.fast}
        style={{ pointerEvents: open ? 'auto' : 'none' }}
        className="absolute right-0 z-[var(--z-dropdown)] mt-3 w-56 overflow-hidden rounded-md border border-border bg-surface shadow-md"
      >
        <div className="border-b border-border px-5 py-4">
          <p className="font-display text-h4">Olá!</p>
          <p className="mt-0.5 text-small font-light text-ink-soft">
            Entre para acompanhar pedidos e favoritos.
          </p>
        </div>
        <ul className="py-2">
          {accountLinks.map((link) => (
            <li key={link.href} role="none">
              <Link
                role="menuitem"
                href={link.href}
                onClick={() => setOpen(false)}
                className="block px-5 py-2.5 text-body font-light text-ink-soft transition-colors hover:bg-surface-alt hover:text-ink"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="border-t border-border p-4">
          <Link
            href="/conta/entrar"
            onClick={() => setOpen(false)}
            className="flex w-full items-center justify-center rounded-pill bg-ink px-5 py-3 text-[0.6875rem] font-medium tracking-[0.16em] text-light uppercase transition-colors hover:bg-primary-strong"
          >
            Entrar
          </Link>
        </div>
      </motion.div>
    </div>
  );
}
