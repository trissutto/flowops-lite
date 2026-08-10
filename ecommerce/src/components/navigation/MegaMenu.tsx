'use client';

import { AppLink as Link } from '@/components/ui/AppLink';
import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { Container } from '@/components/layout/Container';
import { transition } from '@/lib/motion';
import type { NavItem } from '@/types';
import { CategoryColumn } from './CategoryColumn';
import { MenuCard } from './MenuCard';

/**
 * MegaMenu — painel full-width abaixo do header.
 *
 * Layout: colunas de links à esquerda (flex-1) + card editorial à direita
 * (largura fixa). O card é o que dá o tom de revista; sem ele, o painel
 * viraria um dropdown comum.
 *
 * Só renderiza quando `item.menu` existe — itens simples (Outlet) são links.
 */
export function MegaMenu({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
  const { menu } = item;
  if (!menu) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition.fast}
      className="border-t border-border bg-background shadow-lg"
    >
      <Container width="wide" className="py-12">
        <div className="flex flex-col gap-12 lg:flex-row lg:gap-16">
          {/* Colunas de links */}
          <div
            className="grid flex-1 gap-x-12 gap-y-10"
            style={{
              gridTemplateColumns: `repeat(${Math.min(menu.columns.length, 3)}, minmax(0, 1fr))`,
            }}
          >
            {menu.columns.map((column, i) => (
              // `onNavigate` não era repassado às colunas: clicar num link de
              // dentro do painel navegava e deixava o painel ABERTO por cima
              // da página nova, tapando o conteúdo inteiro (achado 10/08 ao
              // clicar num tamanho). O `Navigation` também fecha por mudança
              // de rota — este aqui é o fechamento imediato, sem esperar a
              // navegação resolver.
              <CategoryColumn key={`${column.title}-${i}`} column={column} onNavigate={onNavigate} />
            ))}
          </div>

          {/* Cards editoriais */}
          {menu.features && menu.features.length > 0 && (
            <div className="flex shrink-0 gap-6 lg:w-[340px]">
              {menu.features.map((feature) => (
                <MenuCard key={feature.href} feature={feature} className="flex-1" />
              ))}
            </div>
          )}
        </div>

        {/* Rodapé do painel: atalho pro eixo inteiro + links rápidos */}
        <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-border pt-6">
          <Link
            href={item.href}
            onClick={onNavigate}
            className="group inline-flex items-center gap-2 text-[0.6875rem] font-medium tracking-[0.16em] text-ink uppercase"
          >
            Ver tudo em {item.label}
            <ArrowRight className="size-3.5 transition-transform duration-[320ms] group-hover:translate-x-1" />
          </Link>
          {menu.quickLinks?.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={onNavigate}
              className="link-underline text-small font-light text-ink-soft hover:text-ink"
            >
              {link.label}
            </Link>
          ))}
        </div>
      </Container>
    </motion.div>
  );
}
