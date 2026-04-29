'use client';

/**
 * AdminShell — Layout admin "dashboard clássico":
 *   - Sidebar fixa esquerda (cinza grafite, item ativo em teal)
 *   - Header com título + subtítulo + ações (à direita)
 *   - Área de conteúdo cream com cards brancos
 *
 * Inspirado no template ObraFácil / dashboards SaaS modernos.
 * Coexiste com PastelShell — migração incremental tela a tela.
 *
 * Uso:
 *   <AdminShell
 *     title="Controle multiusuário"
 *     subtitle="Usuário: ..."
 *     navItems={NAV}
 *     activeKey="dashboard"
 *     actions={<Button>Sair</Button>}
 *   >
 *     {children}
 *   </AdminShell>
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useEffect, useState } from 'react';
import { LogOut, Menu, X, type LucideIcon } from 'lucide-react';

export interface AdminNavItem {
  key: string;
  label: string;
  href: string;
  icon?: LucideIcon;
  badge?: number | string;
}

interface AdminShellProps {
  brand?: { initials: string; name: string; subtitle?: string };
  title: string;
  subtitle?: ReactNode;
  navItems: AdminNavItem[];
  activeKey?: string;
  actions?: ReactNode;
  showLogout?: boolean;
  onLogout?: () => void;
  /** Esconde a sidebar (útil pra tela de home/launchpad limpa) */
  noSidebar?: boolean;
  children: ReactNode;
}

export default function AdminShell({
  brand = { initials: 'L', name: "Lurd's Order One", subtitle: 'Operação · varejo plus size' },
  title,
  subtitle,
  navItems,
  activeKey,
  actions,
  showLogout = true,
  onLogout,
  noSidebar = false,
  children,
}: AdminShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Auto-detect active item via pathname se activeKey não veio
  const auto = activeKey ?? navItems.find((i) => pathname === i.href || pathname?.startsWith(i.href + '/'))?.key;

  function handleLogout() {
    if (onLogout) return onLogout();
    if (typeof window !== 'undefined') {
      localStorage.removeItem('flowops_token');
      router.push('/login');
    }
  }

  // Fecha o menu mobile ao mudar de rota
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <div className="min-h-screen bg-[#f4f1ec] text-slate-800">
      {/* Sidebar mobile overlay */}
      {!noSidebar && mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      {!noSidebar && (
      <aside
        className={`fixed top-0 left-0 z-50 h-screen w-[260px] bg-[#f7f5f0] border-r border-slate-200 flex flex-col transition-transform md:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Brand */}
        <div className="px-5 py-5 flex items-center gap-3 border-b border-slate-200/70">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#0f7a82] to-[#0a5258] text-white flex items-center justify-center font-bold text-lg shadow-sm">
            {brand.initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-slate-900 text-[15px] leading-tight truncate">{brand.name}</div>
            {brand.subtitle && (
              <div className="text-[11px] text-slate-500 leading-tight truncate">{brand.subtitle}</div>
            )}
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            className="md:hidden p-1 rounded hover:bg-slate-100"
            aria-label="Fechar menu"
          >
            <X className="w-5 h-5 text-slate-600" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const active = auto === item.key;
            const Icon = item.icon;
            return (
              <Link
                key={item.key}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-[14px] font-semibold transition ${
                  active
                    ? 'bg-[#0f7a82] text-white shadow-sm'
                    : 'text-slate-700 hover:bg-slate-200/60'
                }`}
              >
                {Icon && <Icon className={`w-4 h-4 ${active ? 'text-white' : 'text-slate-500'}`} />}
                <span className="flex-1 truncate">{item.label}</span>
                {item.badge != null && (
                  <span
                    className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                      active ? 'bg-white/25 text-white' : 'bg-rose-100 text-rose-700'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Footer sidebar */}
        {showLogout && (
          <div className="px-3 py-3 border-t border-slate-200/70">
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold text-rose-700 hover:bg-rose-50 transition"
            >
              <LogOut className="w-4 h-4" />
              Sair
            </button>
          </div>
        )}
      </aside>
      )}

      {/* Main */}
      <div className={`${noSidebar ? '' : 'md:ml-[260px]'} min-h-screen flex flex-col`}>
        {/* Top header */}
        <header className="bg-[#f4f1ec] px-4 sm:px-8 pt-5 sm:pt-7 pb-4 flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            {!noSidebar && (
              <button
                onClick={() => setMobileOpen(true)}
                className="md:hidden p-1.5 rounded hover:bg-slate-200/60 mt-1"
                aria-label="Abrir menu"
              >
                <Menu className="w-6 h-6 text-slate-700" />
              </button>
            )}
            <div className="min-w-0">
              <h1 className="text-2xl sm:text-[28px] font-bold text-slate-900 leading-tight truncate">
                {title}
              </h1>
              {subtitle && (
                <div className="text-sm text-slate-500 mt-1">{subtitle}</div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {actions}
            {noSidebar && showLogout && (
              <button
                onClick={handleLogout}
                className="px-3 py-2 rounded-lg bg-white border border-rose-200 text-sm font-semibold text-rose-700 hover:bg-rose-50 flex items-center gap-1.5"
                title="Sair"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:inline">Sair</span>
              </button>
            )}
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 px-4 sm:px-8 pb-8">
          {children}
        </main>
      </div>
    </div>
  );
}
