'use client';

/**
 * TopNav — Topbar slim (hamburger mobile + título + logout).
 *
 * No mobile: [☰] ORDER ONE [Sair]  — hamburger dispara custom event
 *   'sidenav:open' que o SideNav escuta pra abrir o drawer.
 * No desktop: sidebar sempre visível, topbar só mostra [Sair] à direita.
 *
 * `sticky top-0` mantém o header visível com scroll longo. Altura 56px (h-14).
 * Esconde em /login e /minha-loja (UI dedicada).
 */

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, Menu } from 'lucide-react';

export default function TopNav() {
  const pathname = usePathname() || '/';
  const router = useRouter();
  const [storeLabel, setStoreLabel] = useState<string>('ORDER ONE');

  // Hidratação: se tiver nome da loja salvo em localStorage, mostra no mobile
  useEffect(() => {
    try {
      const raw = localStorage.getItem('flowops_store_name');
      if (raw) setStoreLabel(raw);
    } catch {}
  }, []);

  const hide = useMemo(
    () =>
      pathname === '/login' ||
      pathname.startsWith('/login') ||
      pathname.startsWith('/minha-loja') ||
      pathname.startsWith('/vitrine') || // vitrine simula site público — sem header interno
      pathname.startsWith('/trocas') || // portal de trocas público — cliente não vê chrome interno
      pathname.startsWith('/meus-pedidos'), // acompanhamento público de pedidos
    [pathname],
  );

  if (hide) return null;

  function logout() {
    try { window.localStorage.removeItem('flowops_token'); } catch {}
    try { import('@/lib/socket').then(m => m.disconnectSocket()); } catch {}
    router.push('/login');
  }

  function openSidebar() {
    // SideNav escuta esse evento pra abrir o drawer no mobile
    window.dispatchEvent(new CustomEvent('sidenav:open'));
  }

  return (
    <header className="bg-brand text-white shadow sticky top-0 z-40">
      <div className="h-14 px-3 sm:px-4 md:px-6 flex items-center gap-2">
        {/* Hamburger — só mobile */}
        <button
          onClick={openSidebar}
          className="md:hidden p-2 -ml-1 hover:bg-white/10 rounded transition"
          aria-label="Abrir menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* Título/branding — só mobile (no desktop quem mostra é a sidebar) */}
        <div className="md:hidden font-bold tracking-wide text-sm sm:text-base truncate flex-1">
          {storeLabel}
        </div>

        {/* Spacer desktop empurra o botão Sair pra direita */}
        <div className="hidden md:block flex-1" />

        <button
          onClick={logout}
          className="flex items-center gap-1.5 text-sm px-2.5 sm:px-3 py-1.5 hover:bg-white/10 rounded transition shrink-0"
          title="Sair"
        >
          <LogOut className="w-4 h-4" />
          <span className="hidden sm:inline">Sair</span>
        </button>
      </div>
    </header>
  );
}
