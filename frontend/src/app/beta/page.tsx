'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  AlertTriangle, ArrowRight, Boxes, CheckCircle2, CircleDollarSign,
  Clock3, PackageSearch, RefreshCw, ShoppingBag, Truck, Users,
} from 'lucide-react';

type Me = { name?: string; role: string; storeName?: string | null };
type Alerts = { pedidos: number; naoEncontrados: number; materiais: number; remessas: number };

function Metric({ label, value, hint, icon: Icon, money = false }: { label: string; value: string | number; hint: string; icon: typeof Users; money?: boolean }) {
  return <div className="rounded-xl border border-[#DDDCD7] bg-white p-5 shadow-sm"><div className="flex items-start justify-between"><div><div className="text-xs text-[#77736B]">{label}</div><div className={`mt-2 text-2xl font-semibold ${money ? 'text-[#2E7D46]' : 'text-[#24231F]'}`}>{value}</div><div className="mt-1 text-[11px] text-[#99958D]">{hint}</div></div><div className="rounded-lg bg-[#F0EFEC] p-2.5"><Icon className="h-5 w-5" /></div></div></div>;
}

export default function BetaHomePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [alerts, setAlerts] = useState<Alerts>({ pedidos: 0, naoEncontrados: 0, materiais: 0, remessas: 0 });
  const [customers, setCustomers] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(new Date());

  const load = useCallback(async () => {
    setLoading(true);
    const [actor, counts, missing, supplies, shipments, crm] = await Promise.all([
      api<Me>('/auth/me').catch(() => null),
      api<any>('/orders/wc/counts').catch(() => null),
      api<any[]>('/realignment/not-found').catch(() => []),
      api<any[]>('/supplies/requests?status=pending').catch(() => []),
      api<any>('/realignment/shipments/admin/kpis').catch(() => null),
      api<any>('/customers-crm?page=1&limit=1').catch(() => null),
    ]);
    setMe(actor);
    setCustomers(crm?.total ?? null);
    setAlerts({
      pedidos: (counts?.byStatus?.processing?.total || 0) + (counts?.byStatus?.pending?.total || 0) + (counts?.byStatus?.['on-hold']?.total || 0),
      naoEncontrados: Array.isArray(missing) ? missing.length : 0,
      materiais: Array.isArray(supplies) ? supplies.length : 0,
      remessas: shipments?.inTransitCount || 0,
    });
    setUpdatedAt(new Date()); setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const firstName = me?.name?.split(' ')[0];
  const attention = [
    { label: 'Pedidos do site aguardando ação', count: alerts.pedidos, href: '/separacao', icon: ShoppingBag },
    { label: 'Produtos não encontrados', count: alerts.naoEncontrados, href: '/retaguarda/realinhamento/nao-encontrados', icon: PackageSearch },
    { label: 'Solicitações de materiais', count: alerts.materiais, href: '/retaguarda/materiais', icon: Boxes },
    { label: 'Remessas em trânsito', count: alerts.remessas, href: '/retaguarda/remessas', icon: Truck },
  ].filter((item) => item.count > 0);

  return <main className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start">
      <div><div className="mb-2 inline-flex rounded-full border border-[#D4AF37] bg-[#FBF6E6] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.14em] text-[#8C7325]">Novo FlowOps · Beta</div><h1 className="text-2xl font-semibold sm:text-3xl">{greeting}{firstName ? `, ${firstName}` : ''}</h1><p className="mt-1 text-sm text-[#77736B]">Visão operacional da Lurd&apos;s em um único lugar.</p></div>
      <button onClick={() => void load()} disabled={loading} className="sm:ml-auto rounded-lg border border-[#D8D6D0] bg-white px-4 py-2 text-sm font-semibold hover:bg-[#F3F2EF] disabled:opacity-50"><RefreshCw className={`mr-2 inline h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Atualizar</button>
    </div>

    <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Metric label="Clientes na base única" value={customers === null ? '—' : customers.toLocaleString('pt-BR')} hint="PDV + site + live + base antiga" icon={Users} />
      <Metric label="Pedidos exigindo ação" value={alerts.pedidos} hint="Site e separação" icon={ShoppingBag} />
      <Metric label="Pendências operacionais" value={alerts.naoEncontrados + alerts.materiais} hint="Produtos e materiais" icon={AlertTriangle} />
      <Metric label="Faturamento" value="Ver painel" hint="Abre os dados consolidados atuais" icon={CircleDollarSign} money />
    </div>

    <div className="grid gap-4 lg:grid-cols-[1.35fr_.85fr]">
      <section className="rounded-xl border border-[#DDDCD7] bg-white p-5 shadow-sm"><div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">Precisa da sua atenção</h2><p className="mt-1 text-xs text-[#88847C]">Somente itens com pendência real aparecem aqui.</p></div><Clock3 className="h-5 w-5 text-[#8C7325]" /></div>{attention.length ? <div className="divide-y divide-[#ECEAE5]">{attention.map((item) => { const Icon = item.icon; return <Link key={item.label} href={item.href} className="flex items-center gap-3 py-4 hover:bg-[#FAFAF8]"><div className="rounded-lg bg-amber-50 p-2"><Icon className="h-4 w-4 text-amber-800" /></div><div className="flex-1 text-sm font-medium">{item.label}</div><span className="min-w-8 rounded-full bg-[#F0EFEC] px-2 py-1 text-center text-xs font-bold">{item.count}</span><ArrowRight className="h-4 w-4 text-[#99958D]" /></Link>; })}</div> : <div className="rounded-lg bg-emerald-50 p-6 text-center text-emerald-800"><CheckCircle2 className="mx-auto mb-2 h-7 w-7" /><div className="font-semibold">Tudo em ordem por aqui</div><div className="mt-1 text-xs">Nenhuma pendência foi localizada nas fontes disponíveis.</div></div>}</section>

      <section className="rounded-xl border border-[#DDDCD7] bg-white p-5 shadow-sm"><h2 className="font-semibold">Comece pelo Beta</h2><p className="mt-1 text-xs text-[#88847C]">Clientes é o primeiro módulo totalmente integrado ao novo núcleo.</p><Link href="/beta/clientes" className="mt-5 block rounded-xl border border-[#D8D6D0] p-4 hover:border-[#B8912B] hover:bg-[#FBF6E6]"><div className="flex items-center gap-3"><div className="rounded-lg bg-[#24231F] p-2 text-white"><Users className="h-5 w-5" /></div><div className="flex-1"><div className="font-semibold">Clientes</div><div className="text-xs text-[#77736B]">Base única e ficha consolidada</div></div><ArrowRight className="h-4 w-4" /></div></Link><Link href="/retaguarda/faturamento" className="mt-3 block rounded-xl border border-[#E4E2DD] p-4 text-sm hover:bg-[#F5F4F1]"><div className="flex items-center justify-between"><span>Faturamento das lojas</span><span className="rounded bg-[#E9E7E1] px-2 py-1 text-[9px] font-bold uppercase text-[#77736B]">Sistema atual</span></div></Link><div className="mt-5 border-t pt-3 text-[11px] text-[#99958D]">Atualizado às {updatedAt.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</div></section>
    </div>
  </main>;
}

