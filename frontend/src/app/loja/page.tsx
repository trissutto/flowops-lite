'use client';

/**
 * /loja — Hub LOJA (operação física + ERP Gigasistemas).
 *
 * Reúne os módulos que tratam estoque físico, transferências entre filiais,
 * crediário, almoxarifado e materiais (suprimentos das lojas).
 *
 * Visual unificado com a home (AdminShell noSidebar + HubCards).
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Shuffle, Database, CreditCard, Boxes, CheckCircle2, Package2, Store,
  FileSearch, Truck, BarChart3, Percent, ArrowLeft,
  LayoutDashboard, Globe2, Settings, ShoppingCart, Tags,
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

interface LojaItem {
  href: string;
  label: string;
  subtitle?: string;
  description?: string;
  tone: HubTone;
  icon: typeof Globe2;
}

const LOJA_ITEMS: LojaItem[] = [
  { href: '/loja/pedidos-compra',             label: 'Pedidos Compra', subtitle: 'Fornecedores', description: 'Pedidos + cadastro automático', tone: 'rose',   icon: ShoppingCart },
  { href: '/loja/reposicao',                  label: 'Reposição',      subtitle: 'Estoque',      description: 'Busca REF + qty + etiquetas',   tone: 'green',  icon: Package2     },
  { href: '/loja/etiquetas-avulsas',          label: 'Etiquetas',      subtitle: 'Avulsas',      description: 'Imprimir por REF/SKU',          tone: 'amber',  icon: Tags         },
  { href: '/retaguarda/inteligencia-estoque', label: 'Inteligência',   subtitle: 'Estoque',     description: 'Venda + estoque em tempo real', tone: 'purple', icon: BarChart3    },
  { href: '/retaguarda/realinhamento',        label: 'Realinhamento',  subtitle: 'Matriz',      description: 'Rebalancear entre lojas',       tone: 'orange', icon: Shuffle      },
  { href: '/retaguarda/remessas',             label: 'Remessas',       subtitle: 'Trânsito',    description: 'Caixas em rota',                tone: 'sky',    icon: Truck        },
  { href: '/auditoria-sku',                   label: 'Produtos Loja',  subtitle: 'ERP',         description: 'Gigasistemas',                  tone: 'amber',  icon: Database     },
  { href: '/retaguarda/crediario',            label: 'Crediário',      subtitle: 'Cobrança',    description: 'Parcelas + atrasos',            tone: 'rose',   icon: CreditCard   },
  { href: '/loja/juros-crediario',            label: 'Juros Crediário',subtitle: 'Config',      description: 'Carência + taxa mensal',        tone: 'amber',  icon: Percent      },
  { href: '/retaguarda/almoxarifado',         label: 'Almoxarifado',   subtitle: 'Estoque',     description: 'Materiais internos',            tone: 'purple', icon: Boxes        },
  { href: '/retaguarda/venda-certa',          label: 'Venda Certa',    subtitle: 'Auditoria',   description: 'Anti-malandragem',              tone: 'green',  icon: CheckCircle2 },
  { href: '/retaguarda/materiais',            label: 'Materiais',      subtitle: 'Inbox',       description: 'Pedidos das filiais',           tone: 'orange', icon: Package2     },
  { href: '/relatorios/giga',                 label: 'Giga Explorer',  subtitle: 'SQL',         description: 'ERP em tempo real',             tone: 'slate',  icon: FileSearch   },
];

export default function LojaHub() {
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
      title="Loja"
      subtitle={<span>Operação física · estoque · crediário · materiais</span>}
      navItems={NAV}
      activeKey="loja"
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
        {LOJA_ITEMS.map((item) => (
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
