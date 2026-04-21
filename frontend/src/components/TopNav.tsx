'use client';

/**
 * TopNav — Topbar slim (só logo + logout).
 *
 * A navegação mudou pra sidebar lateral (ver SideNav.tsx). Esse topbar ficou
 * enxuto: só um botão de logout à direita. No mobile, o SideNav renderiza um
 * hamburger + título da página ativa por cima desse topbar.
 *
 * `sticky top-0` mantém o header visível com scroll longo. Altura 56px (h-14).
 * `md:pl-60` empurra o conteúdo pra não ficar embaixo da sidebar no desktop.
 * Esconde em /login e /minha-loja (UI dedicada).
 */

import { usePathname, useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';

export default function TopNav() {
  const pathname = usePathname() || '/';
  const router = useRouter();

  if (pathname === '/login' || pathname.startsWith('/login')) return null;
  if (pathname.startsWith('/minha-loja')) return null;

  function logout() {
    try { window.localStorage.removeItem('flowops_token'); } catch {}
    router.push('/login');
  }

  return (
    <header className="bg-brand text-white shadow sticky top-0 z-40">
      <div className="h-14 px-4 md:px-6 flex items-center justify-end gap-3">
        {/* Espaço reservado pro hamburger/título que o SideNav renderiza no mobile */}
        <div className="flex-1 md:hidden" />
        <button
          onClick={logout}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 hover:bg-white/10 rounded transition"
          title="Sair"
        >
          <LogOut className="w-4 h-4" />
          <span className="hidden sm:inline">Sair</span>
        </button>
      </div>
    </header>
  );
}
