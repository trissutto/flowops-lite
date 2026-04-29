'use client';

/**
 * /config — Hub CONFIG (setup técnico do sistema).
 *
 * Concentra cadastros estruturais e configurações que raramente mudam:
 *   - Cadastros: Lojas, Usuários, Vendedoras, Almoxarifado
 *   - Fiscal + Pagamentos: NFC-e, PagBank, Pagar.me
 *   - Integrações: WhatsApp/Baileys
 *   - Sistema: Configurações gerais, Logs
 *
 * Apenas matriz (admin) — guards no backend.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Settings, Store, UserCog, Activity, Receipt, CreditCard, QrCode,
  MessageCircle, Boxes, Users, ArrowLeft,
  LayoutDashboard, Globe2, BarChart3,
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

interface ConfigItem {
  href: string;
  label: string;
  subtitle?: string;
  description?: string;
  tone: HubTone;
  icon: typeof Globe2;
}

const CONFIG_ITEMS: ConfigItem[] = [
  // === Cadastros estruturais ===
  { href: '/lojas',                   label: 'Lojas',         subtitle: 'Cadastro',    description: 'Rede de filiais',         tone: 'rose',   icon: Store        },
  { href: '/usuarios',                label: 'Usuários',      subtitle: 'Acesso',      description: 'Logins + permissões',     tone: 'sky',    icon: UserCog      },
  { href: '/retaguarda/vendedoras',   label: 'Vendedoras',    subtitle: 'Cadastro',    description: 'Time comercial',          tone: 'orange', icon: Users        },
  { href: '/retaguarda/almoxarifado', label: 'Almoxarifado',  subtitle: 'Itens',       description: 'Materiais internos',      tone: 'purple', icon: Boxes        },

  // === Fiscal + Pagamentos (PDV) ===
  { href: '/config/nfce',             label: 'NFC-e',         subtitle: 'Fiscal',      description: 'Certificado A1 + CSC',    tone: 'rose',   icon: Receipt      },
  { href: '/config/pagarme',          label: 'Pagar.me',      subtitle: 'PIX',         description: 'Recomendado pra PDV',     tone: 'green',  icon: CreditCard   },
  { href: '/config/pagbank',          label: 'PagBank',       subtitle: 'PIX',         description: 'Requer homologação',      tone: 'sky',    icon: QrCode       },

  // === Integrações ===
  { href: '/config/whatsapp',         label: 'WhatsApp',      subtitle: 'Baileys',     description: 'Conexão + bulk send',     tone: 'green',  icon: MessageCircle },

  // === Sistema ===
  { href: '/configuracoes',           label: 'Configurações', subtitle: 'Gerais',      description: 'Prioridades + integrações', tone: 'amber',icon: Settings     },
  { href: '/logs',                    label: 'Logs',          subtitle: 'Sistema',     description: 'Eventos do servidor',     tone: 'slate',  icon: Activity     },
];

export default function ConfigHub() {
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
      title="Config"
      subtitle={<span>Setup técnico · cadastros · integrações</span>}
      navItems={NAV}
      activeKey="config"
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
        {CONFIG_ITEMS.map((item) => (
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
