'use client';

/**
 * PoShell — casca do design system LURD'S pro módulo de pedidos de compra
 * (mockup 11/08): sidebar navy fixa + breadcrumb + área clara.
 *
 * Compartilhada entre a lista (/loja/pedidos-compra) e o lançamento
 * (/loja/pedidos-compra/novo). O CSS mora em globals.css escopado em
 * `.purchase-order-theme` — nada vaza pras telas legadas.
 *
 * Itens da sidebar sem tela própria ainda ficam esmaecidos ("Em breve") —
 * visual do mockup sem criar link quebrado.
 */

import { Fragment, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Home, ChevronRight, LayoutDashboard, ShoppingBag, Box, Layers,
  Users, CircleDollarSign, BarChart3, Tag, Settings,
} from 'lucide-react';
import { api } from '@/lib/api';

const SIDE_NAV: Array<{ label: string; icon: any; href?: string }> = [
  { label: 'Dashboard', icon: LayoutDashboard, href: '/loja' },
  { label: 'Pedidos', icon: ShoppingBag, href: '/loja/pedidos-compra' },
  { label: 'Produtos', icon: Box, href: '/produtos' },
  { label: 'Coleções', icon: Layers },
  { label: 'Fornecedores', icon: Users },
  { label: 'Financeiro', icon: CircleDollarSign, href: '/financeiro' },
  { label: 'Relatórios', icon: BarChart3 },
  { label: 'Etiquetas', icon: Tag, href: '/loja/etiquetas-avulsas' },
  { label: 'Configurações', icon: Settings, href: '/configuracoes' },
];

export function PoShell({
  crumbs,
  activeNav = 'Pedidos',
  children,
}: {
  /** Trilha depois do ícone Home. Sem href = página atual (negrito). */
  crumbs: Array<{ label: string; href?: string }>;
  activeNav?: string;
  children: React.ReactNode;
}) {
  // Usuária logada — só pro chip do rodapé da sidebar (visual).
  const [me, setMe] = useState<{ name?: string; email?: string; role?: string } | null>(null);
  useEffect(() => {
    api<{ name?: string; email?: string; role?: string }>('/auth/me').then(setMe).catch(() => {});
  }, []);
  const userName = me?.name || me?.email || 'Usuária';
  const userInitial = (userName.trim()[0] || 'L').toUpperCase();

  return (
    <div className="purchase-order-theme min-h-screen flex">
      <aside className="po-sidebar">
        <div className="po-side-logo">
          <span className="po-side-logo-mark">L</span>
          <span className="po-side-logo-name">LURD&apos;S</span>
          <span className="po-side-logo-sub">PLUS SIZE</span>
        </div>
        <nav className="po-side-nav">
          {SIDE_NAV.map((n) =>
            n.href ? (
              <Link
                key={n.label}
                href={n.href}
                className={`po-side-link ${n.label === activeNav ? 'is-active' : ''}`}
              >
                <n.icon />
                {n.label}
              </Link>
            ) : (
              <span key={n.label} className="po-side-link is-soon" title="Em breve">
                <n.icon />
                {n.label}
              </span>
            ),
          )}
        </nav>
        <div className="po-side-user">
          <span className="po-side-avatar">{userInitial}</span>
          <div className="min-w-0 flex-1">
            <div className="po-side-user-name" title={userName}>{userName}</div>
            <div className="po-side-user-role">{me?.role || 'Compras'}</div>
          </div>
          <ChevronRight className="w-4 h-4 text-[#8fa1b8] shrink-0" />
        </div>
      </aside>

      <div className="po-main">
        <div className="po-main-inner space-y-5">
          <div className="po-breadcrumb">
            <Link href="/loja" aria-label="Início"><Home /></Link>
            {crumbs.map((c, i) => (
              <Fragment key={`${c.label}-${i}`}>
                <ChevronRight />
                {c.href ? (
                  <Link href={c.href}>{c.label}</Link>
                ) : (
                  <span className="is-current">{c.label}</span>
                )}
              </Fragment>
            ))}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
