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
  LayoutDashboard, Globe2, BarChart3, Settings, DollarSign, UserPlus, MapPin,
  Tags, LayoutGrid, TrendingUp,
} from 'lucide-react';
import { api } from '@/lib/api';
import AdminShell, { type AdminNavItem } from '@/components/AdminShell';
import { type HubTone } from '@/components/HubCard';
import HubGrid from '@/components/HubGrid';

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
  { href: '/financeiro',               label: 'Financeiro',      subtitle: 'Analítico WC', description: 'Faturamento · ticket médio · KPIs', tone: 'green', icon: DollarSign },
  { href: '/marketing',                label: 'Marketing',       subtitle: 'CRM',          description: 'Recuperação · campanhas', tone: 'rose',  icon: Megaphone      },
  { href: '/retaguarda/vendedoras',    label: 'Vendedoras',      subtitle: 'Atribuição',   description: 'Quem vende cada pedido',  tone: 'orange', icon: Users         },
  { href: '/retaguarda/publicar-site', label: 'Publicar no Site',subtitle: 'IA',           description: 'Cadastros automáticos',   tone: 'green',  icon: Globe         },
  /**
   * AS DUAS TELAS QUE DESENHAM O SITE — moravam só dentro da Gestão, e quem
   * cuida do online não achava (pedido do dono, 18/08).
   *
   * São coisas diferentes e a ordem aqui conta a sequência: primeiro a
   * CATEGORIA existe (e recebe peça), depois ela pode virar vitrine na home.
   */
  { href: '/retaguarda/vendas-por-produto', label: 'Vendas por Produto', subtitle: 'Relatório', description: 'Quanto vendeu cada REF+cor · marca · período · estoque hoje', tone: 'orange', icon: TrendingUp },
  { href: '/retaguarda/categorias',     label: 'Categorias do Site', subtitle: 'Vitrine',     description: 'Criar categoria e subcategoria · foto · ordem · destaque', tone: 'sky', icon: Tags },
  { href: '/retaguarda/vitrines-home',  label: 'Vitrines da Home',  subtitle: 'Página inicial', description: 'Atalhos e carrosséis da home · ordem sem deploy',        tone: 'teal', icon: LayoutGrid },
  { href: '/retaguarda/leads',         label: 'Cadastros do Site', subtitle: 'Cupom 10%',  description: 'Quem deixou contato no popup', tone: 'rose', icon: UserPlus     },
  { href: '/retaguarda/cliques-lojas', label: 'Cliques nas Lojas', subtitle: 'Site → loja', description: 'Rota · WhatsApp · Instagram por unidade', tone: 'purple', icon: MapPin },
  { href: '/produtos',                 label: 'Produtos Site',   subtitle: 'WooCommerce',  description: 'Catálogo · variações',    tone: 'purple', icon: ShoppingBag   },
  { href: '/retaguarda/baixas-log',    label: 'Log de Baixas',   subtitle: 'Auditoria',    description: 'ERP → WC',                tone: 'amber',  icon: FileSearch    },
  { href: '/site/trocas',              label: 'Trocas Site',     subtitle: 'Devolução',    description: 'Pedidos WC',              tone: 'rose',   icon: ArrowRightLeft },
  { href: '/site/portal-trocas',       label: 'Portal de Trocas',subtitle: 'Self-service', description: 'Solicitações da cliente', tone: 'amber',  icon: ArrowRightLeft },
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
      <HubGrid chave="site" itens={SITE_ITEMS} />
    </AdminShell>
  );
}
