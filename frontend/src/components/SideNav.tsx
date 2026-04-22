'use client';

/**
 * SideNav — Navegação lateral fixa (desktop) + drawer hamburger (mobile).
 *
 * Por que sidebar ao invés de topbar horizontal?
 *  - 11+ links não cabem bem numa barra horizontal (quebra, confunde)
 *  - Itens ficam agrupados por contexto (Operação / Retaguarda / Gestão / Sistema)
 *  - Cada grupo é colapsável (accordion) → abre só o que interessa
 *  - Cor distinta por grupo, fácil identificar visualmente
 *  - Active state forte (pílula cheia, não underline)
 *
 * Plugada em layout.tsx junto com o TopNav slim. Conteúdo ganha padding-left
 * responsivo (md:pl-60) pra não ficar por baixo da sidebar.
 *
 * Esconde em /login (user não autenticado) e /minha-loja (filial usa UI
 * dedicada sem menu — tela cheia pra operador).
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard, PackageMinus, CheckCircle2, Package2, Boxes, Database,
  DollarSign, ShoppingBag, Users, Megaphone, Settings, ChevronDown, X, Globe,
  Smartphone,
} from 'lucide-react';

type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
};

type NavGroup = {
  key: string;
  label: string;
  // Cor de destaque do grupo (classes Tailwind). Aplicada no header do grupo
  // e como fallback no ícone ativo.
  color: string;    // ex: "sky", "amber", "emerald" — usado como classe dinâmica
  items: NavItem[];
};

// Grupos de navegação — reorganizados por contexto de uso
const GROUPS: NavGroup[] = [
  {
    key: 'operacao',
    label: 'Operação',
    color: 'sky',
    items: [
      { href: '/', label: 'Pedidos & Separação', icon: LayoutDashboard },
    ],
  },
  {
    key: 'retaguarda',
    label: 'Retaguarda',
    color: 'amber',
    items: [
      { href: '/retaguarda/baixa-estoque',   label: 'Baixa Estoque',    icon: PackageMinus },
      { href: '/retaguarda/venda-certa',     label: 'Venda Certa',      icon: CheckCircle2 },
      { href: '/retaguarda/materiais',       label: 'Materiais',        icon: Package2 },
      { href: '/retaguarda/almoxarifado',    label: 'Almoxarifado',     icon: Boxes },
      { href: '/retaguarda/publicar-site',   label: 'Publicar no Site', icon: Globe },
      { href: '/retaguarda/whatsapp',        label: 'WhatsApp',         icon: Smartphone },
      { href: '/retaguarda/diagnostico-erp', label: 'Diagnóstico ERP',  icon: Database },
    ],
  },
  {
    key: 'gestao',
    label: 'Gestão',
    color: 'emerald',
    items: [
      { href: '/financeiro', label: 'Financeiro', icon: DollarSign },
      { href: '/produtos',   label: 'Produtos',   icon: ShoppingBag },
      { href: '/clientes',   label: 'Clientes',   icon: Users },
      { href: '/marketing',  label: 'Marketing',  icon: Megaphone },
    ],
  },
  {
    key: 'sistema',
    label: 'Sistema',
    color: 'slate',
    items: [
      { href: '/configuracoes', label: 'Configurações', icon: Settings },
    ],
  },
];

// Mapa fixo de classes por cor — Tailwind precisa ver as classes completas pra
// não fazer purge. Não concatenar dinamicamente.
const COLOR_CLASSES: Record<string, {
  headerBg: string;       // fundo do header do grupo
  headerText: string;     // texto do header
  activeBg: string;       // fundo do item ativo
  activeText: string;     // texto do item ativo
  activeDot: string;      // bolinha indicadora lateral quando ativo
  hoverBg: string;        // fundo do item no hover
}> = {
  sky: {
    headerBg: 'bg-sky-50',
    headerText: 'text-sky-900',
    activeBg: 'bg-gradient-to-r from-sky-500 to-blue-600',
    activeText: 'text-white',
    activeDot: 'bg-sky-500',
    hoverBg: 'hover:bg-sky-50',
  },
  amber: {
    headerBg: 'bg-amber-50',
    headerText: 'text-amber-900',
    activeBg: 'bg-gradient-to-r from-amber-500 to-orange-600',
    activeText: 'text-white',
    activeDot: 'bg-amber-500',
    hoverBg: 'hover:bg-amber-50',
  },
  emerald: {
    headerBg: 'bg-emerald-50',
    headerText: 'text-emerald-900',
    activeBg: 'bg-gradient-to-r from-emerald-500 to-teal-600',
    activeText: 'text-white',
    activeDot: 'bg-emerald-500',
    hoverBg: 'hover:bg-emerald-50',
  },
  slate: {
    headerBg: 'bg-slate-100',
    headerText: 'text-slate-800',
    activeBg: 'bg-gradient-to-r from-slate-600 to-slate-800',
    activeText: 'text-white',
    activeDot: 'bg-slate-600',
    hoverBg: 'hover:bg-slate-100',
  },
};

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

// Descobre qual grupo tem o item ativo — inicializa o accordion aberto nele
function findActiveGroupKey(pathname: string): string {
  for (const g of GROUPS) {
    if (g.items.some((i) => isActive(pathname, i.href))) return g.key;
  }
  return 'operacao';
}

export default function SideNav() {
  const pathname = usePathname() || '/';
  const hide = pathname === '/login' || pathname.startsWith('/login') ||
               pathname.startsWith('/minha-loja');

  // Grupos abertos — múltiplos podem estar abertos ao mesmo tempo (estilo
  // explorador de pastas). Persistido em localStorage pra não refechar ao navegar.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Ao montar, carrega estado salvo E garante que o grupo do item ativo está aberto
  useEffect(() => {
    try {
      const raw = localStorage.getItem('flowops_nav_open');
      const saved = raw ? new Set<string>(JSON.parse(raw)) : new Set<string>();
      saved.add(findActiveGroupKey(pathname));
      setOpenGroups(saved);
    } catch {
      setOpenGroups(new Set([findActiveGroupKey(pathname)]));
    }
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ao mudar de rota, garante que o grupo correspondente abre (mesmo se fechado antes)
  useEffect(() => {
    setOpenGroups((prev) => {
      const active = findActiveGroupKey(pathname);
      if (prev.has(active)) return prev;
      const next = new Set(prev);
      next.add(active);
      return next;
    });
    setDrawerOpen(false); // fecha drawer mobile ao navegar
  }, [pathname]);

  // Persiste estado do accordion
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem('flowops_nav_open', JSON.stringify([...openGroups]));
    } catch {}
  }, [openGroups, hydrated]);

  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Escuta o evento 'sidenav:open' disparado pelo hamburger do TopNav
  useEffect(() => {
    const handler = () => setDrawerOpen(true);
    window.addEventListener('sidenav:open', handler);
    return () => window.removeEventListener('sidenav:open', handler);
  }, []);

  // Fecha o drawer com ESC (UX — ajuda quem usa teclado)
  useEffect(() => {
    if (!drawerOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [drawerOpen]);

  if (hide) return null;

  return (
    <>
      {/* Overlay pra fechar drawer no mobile */}
      {drawerOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed top-0 left-0 h-screen w-60 bg-white border-r border-slate-200 z-50
          flex flex-col transition-transform duration-200
          ${drawerOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}
      >
        {/* Cabeçalho da sidebar */}
        <div className="h-16 px-4 flex items-center justify-between border-b border-slate-200 bg-brand text-white">
          <Link href="/" className="flex items-center gap-2 font-bold tracking-wide">
            <span className="w-8 h-8 rounded bg-white/15 flex items-center justify-center text-xs font-black">
              L1
            </span>
            ORDER ONE
          </Link>
          <button
            className="md:hidden p-1 hover:bg-white/10 rounded"
            onClick={() => setDrawerOpen(false)}
            aria-label="Fechar menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Lista de grupos */}
        <nav className="flex-1 overflow-y-auto py-2">
          {GROUPS.map((g) => {
            const c = COLOR_CLASSES[g.color];
            const open = openGroups.has(g.key);
            const hasActive = g.items.some((i) => isActive(pathname, i.href));
            return (
              <div key={g.key} className="mb-1">
                <button
                  onClick={() => toggleGroup(g.key)}
                  className={`w-full flex items-center justify-between px-3 py-2 text-xs font-bold uppercase tracking-wider ${c.headerText} ${
                    hasActive ? c.headerBg : 'hover:bg-slate-50'
                  } transition`}
                >
                  <span>{g.label}</span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-0' : '-rotate-90'}`}
                  />
                </button>
                {open && (
                  <div className="mt-1 mb-2 space-y-0.5 px-2">
                    {g.items.map((item) => {
                      const Icon = item.icon;
                      const active = isActive(pathname, item.href);
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          className={`
                            group flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium
                            ${active
                              ? `${c.activeBg} ${c.activeText} shadow-sm`
                              : `text-slate-700 ${c.hoverBg}`
                            }
                            transition
                          `}
                        >
                          <Icon
                            className={`w-4 h-4 shrink-0 ${active ? '' : 'text-slate-500 group-hover:text-slate-800'}`}
                          />
                          <span className="truncate">{item.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Rodapé — versão/usuário */}
        <div className="border-t border-slate-200 p-3 text-[10px] text-slate-400 text-center">
          LURDS ORDER ONE · v1
        </div>
      </aside>
    </>
  );
}
