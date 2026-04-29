'use client';

/**
 * /site — Hub SITE (e-commerce online).
 *
 * Reúne tudo que é tocado pelo time/canal online: pedidos do WC, marketing,
 * vendedoras (atribuição de venda), publicação de produto novo, catálogo WC,
 * baixas (auditoria ERP→WC), trocas, vitrine.
 *
 * Visual unificado com a home: AdminShell sem sidebar + HubCards coloridos.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ClipboardList, Megaphone, Users, Globe, ShoppingBag,
  FileSearch, MessageCircle, Store, ArrowRightLeft, ArrowLeft,
  LayoutDashboard, Globe2, BarChart3, Settings,
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

interface SiteItem {
  href: string;
  label: string;
  subtitle?: string;
  description?: string;
  tone: HubTone;
  icon: typeof Globe2;
}

const SITE_ITEMS: SiteItem[] = [
  { href: '/separacao',                label: 'Pedidos',         subtitle: 'WooCommerce',  description: 'Separação e envio',     tone: 'teal',   icon: ClipboardList  },
  { href: '/marketing',                label: 'Marketing',       subtitle: 'CRM',          description: 'Recuperação · campanhas', tone: 'rose',  icon: Megaphone      },
  { href: '/retaguarda/vendedoras',    label: 'Vendedoras',      subtitle: 'Atribuição',   description: 'Quem vende cada pedido',  tone: 'orange', icon: Users         },
  { href: '/retaguarda/publicar-site', label: 'Publicar no Site',subtitle: 'IA',           description: 'Cadastros automáticos',   tone: 'green',  icon: Globe         },
  { href: '/produtos',                 label: 'Produtos Site',   subtitle: 'WooCommerce',  description: 'Catálogo · variações',    tone: 'purple', icon: ShoppingBag   },
  { href: '/retaguarda/baixas-log',    label: 'Log de Baixas',   subtitle: 'Auditoria',    description: 'ERP → WC',                tone: 'amber',  icon: FileSearch    },
  { href: '/site/trocas',              label: 'Trocas Site',     subtitle: 'Devolução',    description: 'Pedidos WC',              tone: 'rose',   icon: ArrowRightLeft },
  { href: '/config/whatsapp',          label: 'WhatsApp',        subtitle: 'Conexão',      description: 'Baileys + bulk send',     tone: 'green',  icon: MessageCircle },
  { href: '/vitrine',                  label: 'Vitrine',         subtitle: 'Pública',      description: 'Catálogo cliente',        tone: 'sky',    icon: Store         },
];

export default function SiteHub() {
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
      title="Site"
      subtitle={
        <span>
          E-commerce · pedidos · marketing · vitrine
        </span>
      }
      navItems={NAV}
      activeKey="site"
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
        {SITE_ITEMS.map((item) => (
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
