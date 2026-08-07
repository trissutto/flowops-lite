'use client';

import { Menu } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { NavItem } from '@/types';
import { useScrolled } from '@/hooks';
import { useUiStore } from '@/store/ui';
import { AnnouncementBar } from './AnnouncementBar';
import { Logo } from './Logo';
import { Navigation } from './Navigation';
import { MobileDrawer } from './MobileDrawer';
import { SearchOverlay } from './SearchOverlay';
import {
  CartButton,
  SearchButton,
  StoreButton,
  UserMenu,
  WishlistButton,
} from './HeaderActions';

/**
 * HEADER — presente em todas as páginas.
 *
 * Comportamento sticky: ao passar de 24px de scroll, a barra encolhe ~15%
 * (96px → 72px no desktop), ganha fundo sólido com blur e uma sombra
 * mínima. A transição é de 320ms com o easing da marca — perceptível, nunca
 * abrupta.
 *
 * A AnnouncementBar rola junto (não é sticky): a barra promocional não deve
 * competir com a navegação depois que a cliente começou a explorar.
 *
 * Ver docs/header.md.
 */
export function Header({
  tarja,
  navegacao,
}: {
  tarja?: { label: string; href: string }[];
  /** Menu com as categorias do CRM. Ausente = o estático de `data/navigation`. */
  navegacao?: NavItem[];
}) {
  const scrolled = useScrolled(24);
  const overlay = useUiStore((s) => s.overlay);
  const toggleOverlay = useUiStore((s) => s.toggleOverlay);
  const closeOverlay = useUiStore((s) => s.closeOverlay);

  return (
    <>
      <AnnouncementBar itens={tarja} />

      <header
        className={cn(
          'sticky top-0 z-[var(--z-header)] transition-all duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
          scrolled
            ? 'border-b border-border bg-background/92 shadow-xs backdrop-blur-md'
            : 'border-b border-transparent bg-background',
        )}
      >
        <div className="relative mx-auto max-w-wide px-gutter lg:px-gutter-lg">
          <div
            className={cn(
              'flex items-center justify-between gap-6 transition-all duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
              scrolled ? 'h-[68px] lg:h-[76px]' : 'h-20 lg:h-24',
            )}
          >
            {/* Esquerda: menu mobile + logo */}
            <div className="flex flex-1 items-center gap-2 lg:flex-none">
              <button
                type="button"
                onClick={() => toggleOverlay('menu')}
                aria-label="Abrir menu"
                aria-expanded={overlay === 'menu'}
                className="-ml-2.5 inline-flex items-center justify-center rounded-pill p-2.5 text-ink transition-colors hover:bg-surface-alt lg:hidden"
              >
                <Menu className="size-5" strokeWidth={1.5} />
              </button>
              <Logo
                variant="horizontal"
                className={cn(
                  'transition-transform duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
                  scrolled && 'lg:scale-[0.92]',
                )}
              />
            </div>

            {/* Centro: navegação (desktop) */}
            <div className="hidden lg:block">
              <Navigation itens={navegacao} />
            </div>

            {/* Direita: ações */}
            <div className="flex flex-1 items-center justify-end gap-0.5 lg:flex-none lg:gap-1">
              <SearchButton onClick={() => toggleOverlay('search')} />
              <StoreButton />
              <UserMenu />
              <WishlistButton />
              <CartButton />
            </div>
          </div>
        </div>
      </header>

      <MobileDrawer open={overlay === 'menu'} onClose={closeOverlay} itens={navegacao} />
      <SearchOverlay open={overlay === 'search'} onClose={closeOverlay} />
    </>
  );
}
