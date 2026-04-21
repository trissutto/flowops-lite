'use client';

/**
 * TopNav — Barra de navegação global fixa no topo.
 * Plugada em layout.tsx, fica visível em todas as telas exceto /login.
 * `sticky top-0` mantém o header visível mesmo com scroll longo.
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import Logo from './Logo';

const NAV = [
  { href: '/',              label: 'Operação' },
  { href: '/retaguarda/baixa-estoque', label: 'Baixa Estoque' },
  { href: '/retaguarda/venda-certa', label: 'Venda Certa' },
  { href: '/retaguarda/materiais', label: 'Materiais' },
  { href: '/retaguarda/almoxarifado', label: 'Almoxarifado' },
  { href: '/retaguarda/diagnostico-erp', label: 'Diagnóstico ERP' },
  { href: '/financeiro',    label: 'Financeiro'    },
  { href: '/produtos',      label: 'Produtos'     },
  { href: '/clientes',      label: 'Clientes'     },
  { href: '/marketing',     label: 'Marketing'    },
  { href: '/configuracoes', label: 'Configurações' },
];

export default function TopNav() {
  const pathname = usePathname() || '/';
  const router = useRouter();

  // Esconder na tela de login e na operação de loja (UI dedicada com header próprio)
  if (pathname === '/login' || pathname.startsWith('/login')) return null;
  if (pathname.startsWith('/minha-loja')) return null;

  function logout() {
    try { window.localStorage.removeItem('flowops_token'); } catch {}
    router.push('/login');
  }

  function isActive(href: string) {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(href + '/');
  }

  return (
    <header className="bg-brand text-white shadow sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3 hover:opacity-90">
          <Logo height={36} className="brightness-0 invert" />
          <h1 className="text-xl font-bold tracking-wide">ORDER ONE</h1>
          <span className="ml-2 px-2 py-1 text-xs font-bold bg-red-500 text-white rounded animate-pulse">BUILD-2104-B</span>
        </Link>
        <nav className="flex gap-5 text-sm">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`hover:underline ${
                isActive(n.href) ? 'font-bold underline underline-offset-4' : ''
              }`}
            >
              {n.label}
            </Link>
          ))}
          <button onClick={logout} className="hover:underline">Sair</button>
        </nav>
      </div>
    </header>
  );
}
