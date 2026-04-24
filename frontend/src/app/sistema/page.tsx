'use client';

/**
 * /sistema — Hub de sistema.
 *
 * Agrupa módulos administrativos: Configurações, Lojas, Usuários, Admin,
 * Logs. Antes ficavam espalhados — alguns na home, outros só via URL.
 */

import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Settings, Store, UserCog, Shield, Activity,
  ArrowLeft, ArrowRight,
} from 'lucide-react';
import { api } from '@/lib/api';

type ModuleCard = {
  href: string;
  label: string;
  subtitle: string;
  icon: typeof Settings;
};

const SISTEMA_CARDS: ModuleCard[] = [
  { href: '/configuracoes', label: 'Configurações', subtitle: 'Prioridades, integrações', icon: Settings },
  { href: '/lojas',         label: 'Lojas',          subtitle: 'Cadastro da rede',        icon: Store },
  { href: '/usuarios',      label: 'Usuários',       subtitle: 'Acesso e permissões',    icon: UserCog },
  { href: '/admin',         label: 'Admin',          subtitle: 'Ações avançadas',        icon: Shield },
  { href: '/logs',          label: 'Logs',           subtitle: 'Eventos do sistema',     icon: Activity },
];

export default function SistemaHub() {
  const router = useRouter();

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    api<{ role: string }>('/auth/me')
      .then((me) => { if (me.role === 'store') router.push('/minha-loja'); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-slate-50 to-slate-100">
      <div className="bg-gradient-to-br from-slate-700 via-slate-800 to-slate-950 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-5 pb-10 relative">
          <div className="absolute -top-10 -right-10 w-64 h-64 rounded-full bg-fuchsia-400/15 blur-3xl pointer-events-none" />
          <div className="absolute top-10 left-1/3 w-48 h-48 rounded-full bg-indigo-400/15 blur-3xl pointer-events-none" />
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm font-semibold opacity-90 hover:opacity-100 mb-4 transition"
          >
            <ArrowLeft className="w-4 h-4" /> Voltar
          </Link>
          <div className="flex items-center gap-4 relative">
            <div className="w-16 h-16 rounded-2xl bg-white/15 backdrop-blur-md ring-1 ring-white/25 flex items-center justify-center shadow-xl">
              <Settings className="w-8 h-8" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-widest opacity-70">Lurds Order One</div>
              <h1 className="text-3xl sm:text-5xl font-black tracking-tight">SISTEMA</h1>
              <div className="text-sm opacity-80 mt-1">Configurações · lojas · usuários · logs</div>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
          {SISTEMA_CARDS.map((item) => (
            <ModuleCardView key={item.href} item={item} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ModuleCardView({ item }: { item: ModuleCard }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className="group flex flex-col rounded-2xl bg-gradient-to-br from-slate-700 to-slate-900 text-white shadow-lg hover:shadow-2xl hover:-translate-y-1 transition-all duration-300 p-5 min-h-[170px] relative overflow-hidden"
    >
      <div className="absolute -top-10 -right-10 w-32 h-32 rounded-full bg-fuchsia-400/15 blur-2xl pointer-events-none group-hover:bg-fuchsia-400/25 transition" />
      <div className="w-12 h-12 bg-white/15 backdrop-blur-sm ring-1 ring-white/20 rounded-xl flex items-center justify-center mb-3 shadow-md relative">
        <Icon className="w-6 h-6" />
      </div>
      <div className="font-black text-base leading-tight relative">{item.label}</div>
      <div className="text-xs opacity-85 mt-1 line-clamp-2 relative">{item.subtitle}</div>
      <div className="mt-auto pt-3 relative">
        <div className="inline-flex items-center gap-1 bg-white/20 backdrop-blur text-white text-xs font-black px-3 py-1.5 rounded-lg group-hover:bg-white group-hover:text-slate-900 transition uppercase tracking-wider">
          Abrir
          <ArrowRight className="w-3.5 h-3.5" />
        </div>
      </div>
    </Link>
  );
}
