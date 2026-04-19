'use client';

/**
 * TopNav — Barra de navegação global fixa no topo.
 * Plugada em layout.tsx, fica visível em todas as telas exceto /login.
 * `sticky top-0` mantém o header visível mesmo com scroll longo.
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Package } from 'lucide-react';

const NAV = [
  { href: '/',          label: 'Dashboard' },
  { href: '/pedidos',   label: 'Pedidos'   },
  { href: '/separacao', label: 'Separação' },
  { href: '/produtos',  label: 'Produtos'  },
  { href: '/auditoria-sku', label: 'Auditoria SKU' },
  { href: '/clientes',  label: 'Clientes'  },
  { href: '/carrinhos-abandonados', label: 'Carrinhos' },
  { href: '/lojas',     label: 'Lojas'     },
  { href: '/logs',      label: 'Logs'      },
];

export default function TopNav() {
  const pathname = usePathname() || '/';
  const router = useRouter();

  // Esconder na tela de login
  if (pathname === '/login' || pathname.startsWith('/login')) return null;

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
          <Package className="w-7 h-7" />
          <h1 className="text-xl font-bold">FlowOps</h1>
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
