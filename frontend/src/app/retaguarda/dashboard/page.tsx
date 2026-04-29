'use client';

/**
 * /retaguarda/dashboard — PILOT do novo padrão visual (AdminShell + KpiCard).
 *
 * Estilo dashboard SaaS clássico: sidebar fixa esquerda + KPI cards gradient
 * + cards brancos com filtros e resumo. Inspirado no template ObraFácil.
 *
 * Coexiste com PastelShell — esta tela é a referência pra Thiago aprovar
 * antes de a gente migrar o sistema todo.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import AdminShell, { type AdminNavItem } from '@/components/AdminShell';
import KpiCard from '@/components/KpiCard';
import {
  LayoutDashboard, ShoppingCart, Receipt, Truck, Users, Store, Settings,
  Download, RefreshCw, FileText, ArrowUpRight, Wifi, WifiOff, Filter,
  Loader2, ShoppingBag,
} from 'lucide-react';

const NAV: AdminNavItem[] = [
  { key: 'dashboard',      label: 'Dashboard',         href: '/retaguarda/dashboard',         icon: LayoutDashboard },
  { key: 'pedidos',        label: 'Pedidos',           href: '/operacao',                     icon: ShoppingBag },
  { key: 'pdv',            label: 'PDV',               href: '/minha-loja/pdv',               icon: Receipt },
  { key: 'realinhamento',  label: 'Realinhamento',     href: '/retaguarda/realinhamento',     icon: ArrowUpRight },
  { key: 'remessas',       label: 'Remessas',          href: '/retaguarda/remessas',          icon: Truck },
  { key: 'transferencias', label: 'Financeiro',        href: '/retaguarda/financeiro/transferencias', icon: FileText },
  { key: 'lojas',          label: 'Lojas',             href: '/lojas',                        icon: Store },
  { key: 'usuarios',       label: 'Usuários',          href: '/usuarios',                     icon: Users },
  { key: 'config',         label: 'Configurações',     href: '/retaguarda',                   icon: Settings },
];

interface WcCounts {
  byStatus: Record<string, { name: string; total: number }>;
  grand: number;
}
interface PresenceItem {
  code: string;
  name: string;
  online: boolean;
  active: boolean;
}
interface ShipmentKpis {
  inTransitCount?: number;
  totalUnitsInTransit?: number;
  totalRevenueInTransit?: number;
}

const formatBRL = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function RetaguardaDashboard() {
  const [me, setMe] = useState<{ email?: string; name?: string; role?: string } | null>(null);
  const [counts, setCounts] = useState<WcCounts | null>(null);
  const [completedToday, setCompletedToday] = useState<number | null>(null);
  const [presence, setPresence] = useState<PresenceItem[]>([]);
  const [shipKpis, setShipKpis] = useState<ShipmentKpis | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filtros (visual demo — não plugados ainda)
  const [filterStore, setFilterStore] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [filterText, setFilterText] = useState('');

  async function load() {
    setError(null);
    try {
      const [meR, countsR, todayR, presR, shipR] = await Promise.all([
        api<any>('/auth/me').catch(() => null),
        api<WcCounts>('/orders/wc/counts').catch(() => null),
        api<{ total: number }>('/orders/wc/completed-today').catch(() => null),
        api<PresenceItem[]>('/stores/presence').catch(() => []),
        api<ShipmentKpis>('/realignment/shipments/admin/kpis').catch(() => null),
      ]);
      setMe(meR);
      setCounts(countsR);
      setCompletedToday(todayR?.total ?? 0);
      setPresence(Array.isArray(presR) ? presR : []);
      setShipKpis(shipR);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
    // refresh leve a cada 60s
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  function handleRefresh() {
    setRefreshing(true);
    load();
  }

  const lojasOnline = presence.filter((p) => p.online).length;
  const lojasTotal = presence.filter((p) => p.active).length;

  const pendentes = useMemo(() => {
    if (!counts) return 0;
    const keys = ['processing', 'on-hold', 'pending'];
    return keys.reduce((s, k) => s + (counts.byStatus[k]?.total || 0), 0);
  }, [counts]);

  const concluidosHoje = completedToday ?? 0;
  const remessasTransito = shipKpis?.inTransitCount ?? 0;
  const valorTransito = shipKpis?.totalRevenueInTransit ?? 0;

  const filteredPresence = useMemo(() => {
    if (!filterStore && !filterText) return presence;
    return presence.filter((p) => {
      if (filterStore && p.code !== filterStore) return false;
      if (filterText) {
        const q = filterText.toLowerCase();
        if (!p.name.toLowerCase().includes(q) && !p.code.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [presence, filterStore, filterText]);

  return (
    <AdminShell
      title="Visão geral da operação"
      subtitle={
        <span>
          Usuário: <span className="font-semibold text-slate-700">{me?.email || me?.name || '—'}</span>
        </span>
      }
      navItems={NAV}
      activeKey="dashboard"
      actions={
        <>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1.5"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
          <button
            onClick={() => alert('Exportar Excel — em breve')}
            className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-sm font-semibold text-white flex items-center gap-1.5 shadow-sm"
          >
            <Download className="w-4 h-4" />
            Exportar Excel
          </button>
        </>
      }
    >
      {/* KPI cards */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-sm mb-5">
        <div className="mb-4">
          <h2 className="text-lg font-bold text-slate-900">Visão geral</h2>
          <p className="text-sm text-slate-500">
            Acompanhe vendas, separações e remessas em tempo real.
          </p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <KpiCard
            tone="teal"
            label="Pedidos pendentes"
            value={loading ? '…' : pendentes}
            hint="WooCommerce: processing + on-hold"
            icon={ShoppingCart}
          />
          <KpiCard
            tone="green"
            label="Concluídos hoje"
            value={loading ? '…' : concluidosHoje}
            hint="WC completed após 00h"
            icon={Receipt}
          />
          <KpiCard
            tone="orange"
            label="Em trânsito (R$)"
            value={loading ? '…' : formatBRL(valorTransito)}
            hint={`${remessasTransito} remessa(s) em rota`}
            icon={Truck}
          />
          <KpiCard
            tone="purple"
            label="Lojas online"
            value={loading ? '…' : `${lojasOnline}/${lojasTotal}`}
            hint="Apps com socket ativo agora"
            icon={Wifi}
          />
        </div>
      </section>

      {/* Filtros + Resumo lojas */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Filtros */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Filter className="w-4 h-4 text-slate-500" />
                Filtros
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Filtre por loja, período e texto livre.
              </p>
            </div>
            <button
              onClick={() => {
                setFilterStore('');
                setFilterFrom('');
                setFilterTo('');
                setFilterText('');
              }}
              className="text-xs px-3 py-1.5 rounded-lg bg-orange-500 hover:bg-orange-600 text-white font-bold"
            >
              Limpar
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                Loja
              </label>
              <select
                value={filterStore}
                onChange={(e) => setFilterStore(e.target.value)}
                className="w-full text-sm rounded-lg border border-slate-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500"
              >
                <option value="">Todas</option>
                {presence.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                Data inicial
              </label>
              <input
                type="date"
                value={filterFrom}
                onChange={(e) => setFilterFrom(e.target.value)}
                className="w-full text-sm rounded-lg border border-slate-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                Data final
              </label>
              <input
                type="date"
                value={filterTo}
                onChange={(e) => setFilterTo(e.target.value)}
                className="w-full text-sm rounded-lg border border-slate-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                Buscar texto
              </label>
              <input
                type="text"
                placeholder="Loja, cidade…"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                className="w-full text-sm rounded-lg border border-slate-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500"
              />
            </div>
          </div>

          {/* Breakdown de status pedidos WC */}
          {counts && (
            <div className="mt-5 pt-4 border-t border-slate-100">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">
                Pedidos por status
              </div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(counts.byStatus)
                  .sort((a, b) => (b[1].total || 0) - (a[1].total || 0))
                  .map(([slug, info]) => (
                    <div
                      key={slug}
                      className="px-3 py-1.5 rounded-lg bg-slate-100 border border-slate-200 text-xs"
                    >
                      <span className="font-semibold text-slate-700">{info.name}</span>{' '}
                      <span className="font-bold text-slate-900">{info.total}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>

        {/* Resumo lojas */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Store className="w-4 h-4 text-slate-500" />
                Status das lojas
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">Online · offline em tempo real</p>
            </div>
          </div>
          {loading && (
            <div className="text-center py-6 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin inline" />
            </div>
          )}
          {!loading && filteredPresence.length === 0 && (
            <div className="text-center py-6 text-slate-400 text-sm">
              Nenhuma loja com os filtros atuais.
            </div>
          )}
          {!loading && filteredPresence.length > 0 && (
            <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
              {filteredPresence.map((p) => (
                <div
                  key={p.code}
                  className="flex items-center gap-2 py-1.5 px-2.5 rounded-lg hover:bg-slate-50 transition"
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      p.online ? 'bg-emerald-500' : 'bg-slate-300'
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-slate-800 truncate">
                      {p.code} · {p.name}
                    </div>
                  </div>
                  {p.online ? (
                    <Wifi className="w-3.5 h-3.5 text-emerald-600" />
                  ) : (
                    <WifiOff className="w-3.5 h-3.5 text-slate-400" />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {error && (
        <div className="mt-4 bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      <div className="mt-6 text-xs text-slate-400 text-center">
        Pilot do novo visual · valide e me dê o ok pra migrar o sistema todo.
      </div>
    </AdminShell>
  );
}
