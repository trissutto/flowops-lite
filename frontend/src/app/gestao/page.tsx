'use client';

/**
 * /gestao — Hub de gestão.
 *
 * Tela intermediária entre a home (4 botões MÃE) e os módulos de gestão
 * (Financeiro, Produtos, Clientes, Marketing, Vendas por Vendedora).
 */

import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  DollarSign, ShoppingBag, Users, Megaphone, TrendingUp,
  ArrowLeft, ArrowRight,
} from 'lucide-react';
import { api } from '@/lib/api';

type ModuleCard = {
  href: string;
  label: string;
  subtitle: string;
  icon: typeof DollarSign;
};

const GESTAO_CARDS: ModuleCard[] = [
  { href: '/financeiro',            label: 'Financeiro',           subtitle: 'Faturamento + recebíveis', icon: DollarSign },
  { href: '/produtos',              label: 'Produtos',             subtitle: 'Sync + variações',         icon: ShoppingBag },
  { href: '/clientes',              label: 'Clientes',             subtitle: 'CRM + compras',            icon: Users },
  { href: '/marketing',             label: 'Marketing',            subtitle: 'Recuperação + campanhas',  icon: Megaphone },
  { href: '/relatorios/vendedoras', label: 'Vendas por Vendedora', subtitle: 'Ranking mensal + CSV',     icon: TrendingUp },
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
      .then((me) => { if (me.role === 'store') router.push('/minha-loja'); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 via-teal-50 to-cyan-50">
      <div className="bg-gradient-to-br from-emerald-500 via-teal-600 to-cyan-700 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-5 pb-10 relative">
          <div className="absolute -top-10 -right-10 w-64 h-64 rounded-full bg-lime-300/20 blur-3xl pointer-events-none" />
          <div className="absolute top-10 left-1/3 w-48 h-48 rounded-full bg-cyan-300/20 blur-3xl pointer-events-none" />
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm font-semibold opacity-90 hover:opacity-100 mb-4 transition"
          >
            <ArrowLeft className="w-4 h-4" /> Voltar
          </Link>
          <div className="flex items-center gap-4 relative">
            <div className="w-16 h-16 rounded-2xl bg-white/20 backdrop-blur-md ring-1 ring-white/25 flex items-center justify-center shadow-xl">
              <TrendingUp className="w-8 h-8" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-widest opacity-80">Lurds Order One</div>
              <h1 className="text-3xl sm:text-5xl font-black tracking-tight">GESTÃO</h1>
              <div className="text-sm opacity-90 mt-1">Financeiro · produtos · CRM · marketing</div>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
          {GESTAO_CARDS.map((item) => (
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
      className="group flex flex-col rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg hover:shadow-2xl hover:-translate-y-1 transition-all duration-300 p-5 min-h-[170px] relative overflow-hidden"
    >
      <div className="absolute -top-10 -right-10 w-32 h-32 rounded-full bg-lime-300/20 blur-2xl pointer-events-none group-hover:bg-lime-300/30 transition" />
      <div className="w-12 h-12 bg-white/20 backdrop-blur-sm ring-1 ring-white/20 rounded-xl flex items-center justify-center mb-3 shadow-md relative">
        <Icon className="w-6 h-6" />
      </div>
      <div className="font-black text-base leading-tight relative">{item.label}</div>
      <div className="text-xs opacity-85 mt-1 line-clamp-2 relative">{item.subtitle}</div>
      <div className="mt-auto pt-3 relative">
        <div className="inline-flex items-center gap-1 bg-white/25 backdrop-blur text-white text-xs font-black px-3 py-1.5 rounded-lg group-hover:bg-white group-hover:text-teal-700 transition uppercase tracking-wider">
          Abrir
          <ArrowRight className="w-3.5 h-3.5" />
        </div>
      </div>
    </Link>
  );
}
