'use client';

/**
 * TopBreadcrumb — Topbar que substitui a SideNav lateral.
 *
 * Motivação: a home virou um launchpad com cards grandes coloridos (estilo
 * /minha-loja). Dentro dos módulos, a sidebar empilhada ficou redundante e
 * ocupa 240px de espaço horizontal. Troquei por uma topbar slim com:
 *   - Logo LURDS clicável → volta pra /
 *   - Breadcrumb gerado do pathname (ex: Retaguarda › Log de baixas)
 *   - Botão home (ícone) de atalho
 *   - Busca (placeholder — fica pra fase 2)
 *   - Avatar + botão Sair
 *
 * Esconde em /login, /minha-loja (UI dedicada de filial), /vitrine (simula
 * site público) e em / (a home já tem o header de boas-vindas embutido).
 *
 * Mapa de labels das seções — traduz os segmentos do pathname pra PT-BR
 * sem depender de um JSON de rotas (adicionar nova rota não precisa mexer
 * aqui, só melhora o label se entrar no mapa).
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Home, LogOut, ChevronRight } from 'lucide-react';
import { useMemo } from 'react';

// Labels amigáveis pra cada segmento da rota (quando aparece no breadcrumb)
const SEGMENT_LABELS: Record<string, string> = {
  'retaguarda':        'Retaguarda',
  'enviados-hoje':     'Enviados por Loja',
  'baixas-log':        'Log de Baixas',
  'venda-certa':       'Venda Certa',
  'materiais':         'Materiais',
  'almoxarifado':      'Almoxarifado',
  'publicar-site':     'Publicar no Site',
  'whatsapp':          'WhatsApp',
  'diagnostico-erp':   'Diagnóstico ERP',
  'baixa-estoque':     'Baixa Estoque',
  'financeiro':        'Financeiro',
  'produtos':          'Produtos',
  'clientes':          'Clientes',
  'marketing':         'Marketing',
  'recuperacao':       'Recuperação de Carrinho',
  'vendedoras':        'Vendedoras',
  'realinhamento':     'Realinhamento',
  'relatorios':        'Relatórios',
  'configuracoes':     'Configurações',
  'auditoria-sku':     'Auditoria SKU',
  'carrinhos-abandonados': 'Carrinhos Abandonados',
  'pedidos':           'Pedidos',
  'separacao':         'Pedidos & Separação',
  'logs':              'Logs',
  'lojas':             'Lojas',
  'usuarios':          'Usuários',
  'admin':             'Admin',
  'crm':               'CRM',
  'wc':                'WC',
  'imprimir':          'Imprimir',
  'visao-geral':       'Visão Geral',
};

function labelForSegment(seg: string): string {
  if (SEGMENT_LABELS[seg]) return SEGMENT_LABELS[seg];
  // IDs numéricos ou slugs desconhecidos — capitaliza
  if (/^\d+$/.test(seg)) return `#${seg}`;
  return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, ' ');
}

export default function TopBreadcrumb() {
  const pathname = usePathname() || '/';
  const router = useRouter();

  // Esconde em telas que não devem ter a topbar (auth, filial, vitrine, home)
  const hide =
    pathname === '/' ||
    pathname === '/login' || pathname.startsWith('/login') ||
    pathname.startsWith('/minha-loja') ||
    pathname.startsWith('/vitrine');

  // Monta o breadcrumb a partir do pathname — cada nível é clicável (exceto o último)
  const crumbs = useMemo(() => {
    if (hide) return [];
    const segs = pathname.split('/').filter(Boolean);
    return segs.map((seg, i) => {
      const href = '/' + segs.slice(0, i + 1).join('/');
      return { label: labelForSegment(seg), href, isLast: i === segs.length - 1 };
    });
  }, [pathname, hide]);

  function logout() {
    try { window.localStorage.removeItem('flowops_token'); } catch {}
    router.push('/login');
  }

  if (hide) return null;

  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-40 shadow-sm">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 h-14 flex items-center gap-3">
        {/* Logo — volta pra home */}
        <Link
          href="/"
          className="flex items-center gap-2 shrink-0 group"
          title="Voltar à home"
        >
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-slate-800 to-slate-900 text-white flex items-center justify-center text-xs font-black shadow-sm group-hover:shadow transition">
            L1
          </div>
          <span className="hidden sm:inline font-bold text-slate-800 tracking-wide">
            ORDER ONE
          </span>
        </Link>

        {/* Separador vertical */}
        <div className="h-5 w-px bg-slate-200 hidden sm:block" />

        {/* Breadcrumb */}
        <nav className="flex items-center gap-1 text-sm min-w-0 flex-1 overflow-x-auto scrollbar-none">
          <Link
            href="/"
            className="flex items-center gap-1 text-slate-500 hover:text-slate-800 transition shrink-0"
            title="Home"
          >
            <Home className="w-4 h-4" />
          </Link>
          {crumbs.map((c, i) => (
            <div key={c.href + i} className="flex items-center gap-1 shrink-0">
              <ChevronRight className="w-3.5 h-3.5 text-slate-300" />
              {c.isLast ? (
                <span className="font-semibold text-slate-800 truncate max-w-[220px] sm:max-w-[400px]">
                  {c.label}
                </span>
              ) : (
                <Link
                  href={c.href}
                  className="text-slate-500 hover:text-slate-800 transition truncate max-w-[140px]"
                >
                  {c.label}
                </Link>
              )}
            </div>
          ))}
        </nav>

        {/* Ações à direita */}
        <button
          onClick={logout}
          className="flex items-center gap-1.5 text-sm px-2.5 sm:px-3 py-1.5 text-slate-600 hover:bg-slate-100 rounded-lg transition shrink-0"
          title="Sair"
        >
          <LogOut className="w-4 h-4" />
          <span className="hidden sm:inline">Sair</span>
        </button>
      </div>
    </header>
  );
}
