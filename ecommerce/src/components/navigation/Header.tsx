'use client';

import { Menu, Search } from 'lucide-react';
import { usePathname } from 'next/navigation';
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
  const pathname = usePathname();
  const overlay = useUiStore((s) => s.overlay);
  const toggleOverlay = useUiStore((s) => s.toggleOverlay);
  const closeOverlay = useUiStore((s) => s.closeOverlay);

  /**
   * A BARRA DE BUSCA DO CELULAR — visível, não escondida atrás do ícone.
   *
   * No desktop a busca sempre foi alcançável; no celular era só a lupa, e quem
   * chega de anúncio procurando uma peça específica precisava descobrir o
   * ícone primeiro. Numa loja com 152 vestidos no catálogo, campo aberto é
   * atalho, não enfeite.
   *
   * Ela NÃO aparece em todo lugar, e isso é deliberado: 44px a mais no topo
   * empurram a dobra pra baixo, e nas telas de DECISÃO (a peça, a sacola, o
   * pagamento) a dobra vale mais que a descoberta — a PDP luta por cada pixel
   * pra levar o seletor de tamanho pra cima. Some também quando a cliente
   * começa a rolar: aí ela já está lendo, e a lupa do header dá conta.
   *
   * É um BOTÃO com cara de campo, não um input: quem faz a busca de verdade é
   * o `SearchOverlay`, que tem histórico, intenções e sugestões. Dois campos
   * de busca com dois comportamentos seria pior que um só escondido.
   */
  const telaDeDecisao =
    !!pathname &&
    (pathname.startsWith('/produto/') ||
      pathname.startsWith('/carrinho') ||
      pathname.startsWith('/checkout') ||
      pathname.startsWith('/busca'));
  const mostrarBuscaMobile = !telaDeDecisao && !scrolled;

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
              /* CELULAR MAIS BAIXO (22/08): 80px parados e 68 rolando era
                 cromo demais numa tela de 734 — a PDP precisa da dobra pro
                 tamanho e pra cor. 64/56 mantém o logo (36px) e os ícones
                 (40px) com folga. O desktop não muda. */
              scrolled ? 'h-14 lg:h-[76px]' : 'h-16 lg:h-24',
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

          {/* Busca aberta — só celular, só nas telas de descoberta. */}
          {mostrarBuscaMobile && (
            <div className="pb-3 lg:hidden">
              <button
                type="button"
                onClick={() => toggleOverlay('search')}
                className="flex h-11 w-full items-center gap-2.5 rounded-pill border border-border bg-surface px-4 text-left text-small font-light text-ink-muted transition-colors hover:border-border-strong"
              >
                <Search className="size-4 shrink-0 text-primary-strong" strokeWidth={1.5} />
                <span className="truncate">Buscar peça, cor ou tamanho</span>
              </button>
            </div>
          )}
        </div>
      </header>

      <MobileDrawer open={overlay === 'menu'} onClose={closeOverlay} itens={navegacao} />
      <SearchOverlay open={overlay === 'search'} onClose={closeOverlay} />
    </>
  );
}
