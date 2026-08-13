'use client';

import { useState } from 'react';
import { AppLink as Link } from '@/components/ui/AppLink';
import { motion } from 'framer-motion';
import { ChevronDown, Heart, MapPin, MessageCircle, Package, ShoppingBag, User } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { transition } from '@/lib/motion';
import { navigation as estatico } from '@/data/navigation';
import type { NavItem } from '@/types';
import { Logo } from './Logo';
import { LINK_WHATSAPP_SITE } from '@/data/contato';

/**
 * MobileDrawer — navegação completa em tela cheia no celular.
 *
 * Estrutura: eixos principais como acordeão (toque grande, 56px de alvo),
 * atalhos de conta, e o rodapé com WhatsApp/lojas. Nada de menu-sanduíche
 * genérico: cada eixo abre suas colunas com a mesma hierarquia do desktop.
 */

const ACCOUNT_ICONS = { User, Package, Heart, ShoppingBag } as const;

export function MobileDrawer({
  open, onClose, itens,
}: { open: boolean; onClose: () => void; itens?: NavItem[] }) {
  // Mesmas categorias do CRM que o desktop — o celular é a maioria do tráfego.
  const navigation = itens?.length ? itens : estatico;
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      label="Menu"
      side="left"
      size="sm"
      header={<Logo variant="horizontal" className="justify-start" />}
      footer={
        <div className="flex flex-col gap-2.5">
          <Button href="/lojas" variant="primary" block onClick={onClose}>
            <MapPin /> Encontrar uma loja
          </Button>
          <Button
            href={LINK_WHATSAPP_SITE}
            external
            variant="whatsapp"
            block
          >
            <MessageCircle /> Falar no WhatsApp
          </Button>
        </div>
      }
    >
      <nav aria-label="Navegação principal (mobile)">
        <ul className="flex flex-col">
          {navigation.map((item) => {
            const isOpen = expanded === item.href;
            const hasMenu = Boolean(item.menu);

            return (
              <li key={item.href} className="border-b border-border">
                {hasMenu ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : item.href)}
                      aria-expanded={isOpen}
                      className="flex min-h-14 w-full items-center justify-between gap-4 py-4 text-left"
                    >
                      <span className="font-display text-[1.375rem] text-ink">{item.label}</span>
                      <ChevronDown
                        className={cn(
                          'size-4 shrink-0 text-primary-strong transition-transform duration-[320ms]',
                          isOpen && 'rotate-180',
                        )}
                        strokeWidth={1.75}
                      />
                    </button>

                    <motion.div
                      initial={false}
                      animate={{ height: isOpen ? 'auto' : 0, opacity: isOpen ? 1 : 0 }}
                      transition={transition.base}
                      className="overflow-hidden"
                    >
                      <div className="flex flex-col gap-6 pb-6">
                        {item.menu!.columns.map((column, i) => (
                          <div key={`${column.title}-${i}`}>
                            {column.title.trim() && (
                              <p className="eyebrow text-ink-muted">{column.title}</p>
                            )}
                            <ul className="mt-3 flex flex-col">
                              {column.links.map((link) => (
                                <li key={link.href}>
                                  <Link
                                    href={link.href}
                                    onClick={onClose}
                                    className={cn(
                                      'block py-2.5 text-body',
                                      link.highlight
                                        ? 'font-medium text-ink'
                                        : 'font-light text-ink-soft',
                                    )}
                                  >
                                    {link.label}
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                        <Link
                          href={item.href}
                          onClick={onClose}
                          className="text-[0.6875rem] font-medium tracking-[0.16em] text-primary-strong uppercase"
                        >
                          Ver tudo em {item.label}
                        </Link>
                      </div>
                    </motion.div>
                  </>
                ) : (
                  <Link
                    href={item.href}
                    onClick={onClose}
                    className="flex min-h-14 items-center py-4 font-display text-[1.375rem] text-ink"
                  >
                    {item.label}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Conta */}
      <div className="mt-8">
        <p className="eyebrow text-ink-muted">Minha Lurds</p>
        <ul className="mt-4 grid grid-cols-2 gap-2.5">
          {(
            [
              { label: 'Minha conta', href: '/conta', icon: 'User' },
              { label: 'Meus pedidos', href: '/conta/pedidos', icon: 'Package' },
              { label: 'Favoritos', href: '/conta/favoritos', icon: 'Heart' },
              { label: 'Sacola', href: '/carrinho', icon: 'ShoppingBag' },
            ] as const
          ).map((link) => {
            const Icon = ACCOUNT_ICONS[link.icon];
            return (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={onClose}
                  className="flex min-h-14 flex-col justify-center gap-1.5 rounded-md border border-border bg-surface px-4 py-3 transition-colors hover:border-primary"
                >
                  <Icon className="size-4 text-primary-strong" strokeWidth={1.5} />
                  <span className="text-small text-ink-soft">{link.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </Drawer>
  );
}
