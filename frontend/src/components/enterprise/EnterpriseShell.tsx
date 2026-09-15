'use client';

/**
 * ORDER ONE · Executive Operations UI — casca do sistema.
 *
 * Barra navy com o NOME DO PRODUTO, navegação real e a conta. Substitui a
 * TopBreadcrumb nas telas que migrarem (a TopBreadcrumb esconde a própria
 * rota). Mantém o que a barra antiga oferecia: voltar à home, trilha,
 * "Entrar PDV" (StoreSwitcher) e Sair.
 *
 * Fontes: Inter Tight (títulos e números grandes) + Inter 400–700 (dados).
 * O layout raiz carrega Inter só até 600 — por isso esta casca traz as suas.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Inter, Inter_Tight } from 'next/font/google';
import { ChevronRight, LogOut } from 'lucide-react';
import StoreSwitcher from '@/components/StoreSwitcher';

const display = Inter_Tight({
  subsets: ['latin'],
  weight: ['600', '700'],
  variable: '--font-oo-display',
  display: 'swap',
});

const sans = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-oo-sans',
  display: 'swap',
});

export type Trilha = { label: string; href?: string };

const NAV = [
  { label: 'Início', href: '/' },
  { label: 'Gestão', href: '/retaguarda' },
  { label: 'Franquias', href: '/franquias' },
  { label: 'Imobiliário', href: '/imobiliario' },
  { label: 'Configurações', href: '/config' },
];

export default function EnterpriseShell({
  trilha,
  children,
}: {
  trilha: Trilha[];
  children: ReactNode;
}) {
  const pathname = usePathname() || '/';
  const router = useRouter();

  function sair() {
    try { window.localStorage.removeItem('flowops_token'); } catch {}
    try { import('@/lib/socket').then((m) => m.disconnectSocket()); } catch {}
    router.push('/login');
  }

  return (
    <div className={`${display.variable} ${sans.variable} min-h-screen bg-oo-bg font-oo-sans text-oo-ink antialiased`}>
      <header className="bg-oo-nav text-white">
        <div className="flex h-14 items-center gap-6 px-4 sm:px-6 2xl:px-12">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oo-primary"
            title="Voltar à home"
          >
            <span className="grid h-7 w-7 place-items-center rounded-md bg-white font-oo-display text-[13px] font-bold text-oo-nav">
              L1
            </span>
            <span className="font-oo-display text-[15px] font-bold tracking-[-0.01em]">
              ORDER ONE
            </span>
          </Link>

          <nav className="hidden h-14 items-stretch gap-1 md:flex" aria-label="Módulos">
            {NAV.map((n) => {
              const ativo = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={ativo ? 'page' : undefined}
                  className={`relative flex items-center px-3 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oo-primary ${
                    ativo ? 'text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {n.label}
                  {ativo && <span className="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-oo-primary" />}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            {/* botão verde do StoreSwitcher (compartilhado) vestido de ação primária só aqui */}
            <div className="[&>div>button]:!rounded-md [&>div>button]:!bg-oo-primary [&>div>button]:!shadow-none [&>div>button:hover]:!bg-oo-primary-hover">
              <StoreSwitcher />
            </div>
            <span className="hidden h-6 w-px bg-oo-nav-line sm:block" />
            <button
              type="button"
              onClick={sair}
              className="flex h-9 items-center gap-2 rounded-md px-2.5 text-[13px] font-medium text-slate-300 transition-colors duration-150 hover:bg-oo-nav-2 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oo-primary"
              title="Sair"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sair</span>
            </button>
          </div>
        </div>

        {/* Trilha */}
        <div className="border-y border-oo-nav-line bg-oo-nav">
          <ol className="flex h-9 items-center gap-1.5 overflow-x-auto px-4 text-[12px] text-slate-400 sm:px-6 2xl:px-12">
            {trilha.map((t, i) => (
              <li key={t.label} className="flex shrink-0 items-center gap-1.5">
                {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-slate-600" />}
                {t.href ? (
                  <Link href={t.href} className="transition-colors hover:text-white">{t.label}</Link>
                ) : (
                  <span className="font-medium text-slate-200">{t.label}</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      </header>

      {children}
    </div>
  );
}
