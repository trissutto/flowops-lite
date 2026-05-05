'use client';

/**
 * /retaguarda — Hub GESTÃO (estratégico · admin matriz).
 *
 * Concentra dashboard, inteligência, financeiro, vendedoras (relatórios),
 * cobrança automática, clientes, remessas, realinhamento (criar), giga
 * explorer, auditoria e logs.
 *
 * URL preservada (`/retaguarda`) por compatibilidade com bookmarks antigos —
 * o LABEL passa a ser "Gestão". Visual unificado com a home.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  LayoutDashboard, BarChart3, DollarSign, Users, ShoppingBag,
  Shuffle, Truck, AlertTriangle, FileSearch, Activity, ArrowLeft,
  Globe2, Store, Settings, Megaphone, CreditCard, ClipboardList,
  Package,
} from 'lucide-react';
import { api } from '@/lib/api';
import AdminShell, { type AdminNavItem } from '@/components/AdminShell';
import HubCard, { type HubTone } from '@/components/HubCard';

const NAV: AdminNavItem[] = [
  { key: 'dashboard', label: 'Dashboard',  href: '/',           icon: LayoutDashboard },
  { key: 'site',      label: 'Site',       href: '/site',       icon: Globe2 },
  { key: 'loja',      label: 'Loja',       href: '/loja',       icon: Store },
  { key: 'gestao',    label: 'Gestão',     href: '/retaguarda', icon: BarChart3 },
  { key: 'config',    label: 'Config',     href: '/config',     icon: Settings },
];

interface GestaoItem {
  href: string;
  label: string;
  subtitle?: string;
  description?: string;
  tone: HubTone;
  icon: typeof Globe2;
}

const GESTAO_ITEMS: GestaoItem[] = [
  { href: '/retaguarda/dashboard',            label: 'Dashboard',         subtitle: 'KPIs',          description: 'Visão geral em tempo real',     tone: 'teal',   icon: LayoutDashboard },
  { href: '/retaguarda/inteligencia-estoque', label: 'Inteligência',      subtitle: 'Estoque',       description: 'Análise de produto + venda',    tone: 'purple', icon: BarChart3       },
  { href: '/financeiro',                      label: 'Financeiro',        subtitle: 'Faturamento',   description: 'Receita + recebíveis',          tone: 'green',  icon: DollarSign      },
  { href: '/retaguarda/financeiro/transferencias', label: 'Transferências', subtitle: 'Inter-lojas',  description: 'Royalties + fechamento',        tone: 'green',  icon: DollarSign      },
  { href: '/relatorios/vendedoras',           label: 'Vendedoras',        subtitle: 'Ranking',       description: 'Vendas por mês',                tone: 'rose',   icon: Users           },
  { href: '/retaguarda/crediario/automatico', label: 'Cobrança',          subtitle: 'Crediário',     description: 'Campanhas automáticas',         tone: 'orange', icon: CreditCard      },
  { href: '/retaguarda/crediario',            label: 'Crediário',         subtitle: 'Manual',        description: 'Lista + WhatsApp bulk',         tone: 'orange', icon: CreditCard      },
  { href: '/clientes',                        label: 'Clientes',          subtitle: 'CRM',           description: 'Histórico + segmentos',         tone: 'sky',    icon: Users           },
  { href: '/marketing',                       label: 'Marketing',         subtitle: 'Campanhas',     description: 'Recuperação + WhatsApp',        tone: 'rose',   icon: Megaphone       },
  { href: '/retaguarda/cadastro-produtos',    label: 'Cadastro Produtos', subtitle: 'Novo SKU',      description: 'Gerar SKUs no Wincred',         tone: 'purple', icon: Package         },
  { href: '/retaguarda/remessas',             label: 'Remessas',          subtitle: 'Em trânsito',   description: 'Caixas + comprovantes PDF',     tone: 'sky',    icon: Truck           },
  { href: '/retaguarda/realinhamento',        label: 'Realinhamento',     subtitle: 'Criar',         description: 'Rebalancear estoque',           tone: 'amber',  icon: Shuffle         },
  { href: '/retaguarda/realinhamento/nao-encontrados', label: 'Não Encontradas', subtitle: 'Revisar', description: 'Filiais reportaram',           tone: 'rose',   icon: AlertTriangle  },
  { href: '/retaguarda/enviados-hoje',        label: 'Enviados Hoje',     subtitle: 'Pedidos WC',    description: 'Por filial',                    tone: 'green',  icon: ClipboardList   },
  { href: '/relatorios/giga',                 label: 'Giga Explorer',     subtitle: 'SQL',           description: 'ERP em tempo real',             tone: 'slate',  icon: FileSearch      },
  { href: '/retaguarda/baixas-log',           label: 'Auditoria',         subtitle: 'Baixas ERP',    description: 'Histórico ERP → WC',            tone: 'amber',  icon: FileSearch      },
  { href: '/logs',                            label: 'Logs',              subtitle: 'Sistema',       description: 'Eventos do servidor',           tone: 'slate',  icon: Activity        },
];

export default function GestaoHub() {
  const router = useRouter();

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    api<{ role: string }>('/auth/me')
      .then((me) => { if (me.role === 'store') router.push('/minha-loja/pdv'); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AdminShell
      title="Gestão"
      subtitle={<span>Estratégico · dashboards · financeiro · cobrança</span>}
      navItems={NAV}
      activeKey="gestao"
      noSidebar
      actions={
        <Link
          href="/"
          className="px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5"
        >
          <ArrowLeft className="w-4 h-4" />
          Home
        </Link>
      }
    >
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {GESTAO_ITEMS.map((item) => (
          <HubCard
            key={item.href}
            href={item.href}
            label={item.label}
            subtitle={item.subtitle}
            description={item.description}
            tone={item.tone}
            icon={item.icon}
          />
        ))}
      </section>
    </AdminShell>
  );
}
