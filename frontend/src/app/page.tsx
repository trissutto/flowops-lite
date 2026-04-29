'use client';

/**
 * / — Home/Launchpad LURDS (v11 — AdminShell + KpiCards funcionais).
 *
 * Refatorada pro novo padrão visual (referência ObraFácil):
 *   - Sidebar fixa com nav dos 4 hubs + dashboard + sair
 *   - 4 KPI cards coloridos GRANDES (teal/green/orange/purple) clicáveis
 *   - Card "Filtros" + Card "Resumo das lojas" abaixo
 *   - Header com saudação + Piloto Automático + ações (Atualizar/Sair)
 *
 * Filial (role=store) é redirecionada pro /minha-loja/pdv automaticamente —
 * essa home é só pra matriz.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  LayoutDashboard, Globe2, Store, BarChart3, Settings, ShoppingBag,
  Receipt, Truck, Wifi, WifiOff, Filter, Loader2, Download, RefreshCw,
  Zap, Bot, ArrowUpRight,
} from 'lucide-react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { isPilotOn, fetchPilotStatus, togglePilotServer, PilotStatus } from '@/lib/auto-send-order';
import AdminShell, { type AdminNavItem } from '@/components/AdminShell';
import KpiCard from '@/components/KpiCard';

interface CountsResp {
  byStatus: Record<string, { name: string; total: number }>;
  grand: number;
}
interface PresenceItem {
  code: string;
  name: string;
  online: boolean;
  active: boolean;
}

// === Sidebar: 5 itens (Dashboard + 4 hubs) ===
const NAV: AdminNavItem[] = [
  { key: 'dashboard', label: 'Dashboard',  href: '/',                       icon: LayoutDashboard },
  { key: 'site',      label: 'Site',       href: '/site',                   icon: Globe2 },
  { key: 'loja',      label: 'Loja',       href: '/loja',                   icon: Store },
  { key: 'gestao',    label: 'Gestão',     href: '/retaguarda',             icon: BarChart3 },
  { key: 'config',    label: 'Config',     href: '/config',                 icon: Settings },
];

export default function DashboardHome() {
  const router = useRouter();
  const [userName, setUserName] = useState<string>('');
  const [counts, setCounts] = useState<Record<string, { name: string; total: number }>>({});
  const [concluidosHoje, setConcluidosHoje] = useState<number>(0);
  const [presence, setPresence] = useState<PresenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Pilot
  const [pilot, setPilot] = useState(false);
  const [pilotStatus, setPilotStatus] = useState<PilotStatus | null>(null);
  const [pilotBusy, setPilotBusy] = useState(false);

  // Filtros (visual — ainda não plugados)
  const [filterStore, setFilterStore] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  // Auth + redirect store→PDV
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    api<{ role: string; name?: string }>('/auth/me')
      .then((me) => {
        if (me.role === 'store') router.push('/minha-loja/pdv');
        if (me.name) setUserName(me.name);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pilot status
  useEffect(() => {
    setPilot(isPilotOn());
    let cancelled = false;
    async function sync() {
      const s = await fetchPilotStatus();
      if (cancelled || !s) return;
      setPilotStatus(s);
      setPilot(!!s.on);
    }
    sync();
    const t = setInterval(sync, 30_000);
    const onChange = (e: Event) => {
      const det = (e as CustomEvent).detail;
      setPilot(!!det?.on);
    };
    window.addEventListener('lurds:pilot-changed', onChange);
    return () => {
      cancelled = true;
      clearInterval(t);
      window.removeEventListener('lurds:pilot-changed', onChange);
    };
  }, []);

  // KPIs reais (counts + presence + completed-today)
  async function loadKpis() {
    try {
      const [cnt, done, pres] = await Promise.all([
        api<CountsResp>('/orders/wc/counts').catch(() => null),
        api<{ total: number }>('/orders/wc/completed-today').catch(() => null),
        api<PresenceItem[]>('/stores/presence').catch(() => []),
      ]);
      if (cnt) setCounts(cnt.byStatus);
      if (done?.total != null) setConcluidosHoje(done.total);
      if (Array.isArray(pres)) setPresence(pres);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }
  useEffect(() => {
    loadKpis();
    const timer = setInterval(loadKpis, 30_000);
    const sock = getSocket();
    const onAny = () => loadKpis();
    sock.on('order:new', onAny);
    sock.on('order:status-changed', onAny);
    return () => {
      clearInterval(timer);
      sock.off('order:new', onAny);
      sock.off('order:status-changed', onAny);
    };
  }, []);

  async function togglePilot() {
    if (pilotBusy) return;
    const next = !pilot;
    setPilotBusy(true);
    setPilot(next);
    try {
      const s = await togglePilotServer(next);
      if (s) {
        setPilotStatus(s);
        setPilot(!!s.on);
        if (next && !s.whatsappConnected) {
          alert('Piloto LIGADO, mas o WhatsApp não está conectado. Conecte em /config/whatsapp antes de receber pedidos.');
        }
      } else {
        setPilot(!next);
      }
    } catch {
      setPilot(!next);
    } finally {
      setPilotBusy(false);
    }
  }

  function handleRefresh() {
    setRefreshing(true);
    loadKpis();
  }

  // Derivações
  const totalPending =
    (counts['processing']?.total ?? 0) +
    (counts['separacao']?.total ?? 0) +
    (counts['pending']?.total ?? 0) +
    (counts['on-hold']?.total ?? 0);

  const emSeparacao = counts['separacao']?.total ?? 0;
  const emTransito = counts['shipped']?.total ?? 0;
  const lojasOnline = presence.filter((p) => p.online).length;
  const lojasTotal = presence.filter((p) => p.active).length;

  const today = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long',
  });

  const filteredPresence = useMemo(() => {
    if (!filterStore) return presence;
    return presence.filter((p) => p.code === filterStore);
  }, [presence, filterStore]);

  return (
    <AdminShell
      title={userName ? `Olá, ${userName.split(' ')[0]}` : 'Bem-vinda'}
      subtitle={
        <span className="capitalize">
          {today} · <span className="text-slate-700 font-semibold">Lurds Order One</span>
        </span>
      }
      navItems={NAV}
      activeKey="dashboard"
      actions={
        <>
          <PilotPill pilot={pilot} busy={pilotBusy} status={pilotStatus} onToggle={togglePilot} />
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1.5"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </>
      }
    >
      {/* === Visão geral · 4 KPIs coloridos FUNCIONAIS === */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-sm mb-5">
        <div className="mb-4">
          <h2 className="text-lg font-bold text-slate-900">Visão geral</h2>
          <p className="text-sm text-slate-500">
            Acompanhe pedidos, separação e remessas em tempo real. Clique em qualquer card pra ver detalhe.
          </p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <KpiCard
            tone="teal"
            label="Pedidos pendentes"
            value={loading ? '…' : totalPending}
            hint="Pagar · processar · aguardar"
            icon={ShoppingBag}
            onClick={() => router.push('/separacao?status=processing')}
          />
          <KpiCard
            tone="green"
            label="Concluídos hoje"
            value={loading ? '…' : concluidosHoje}
            hint="WC completed após 00h"
            icon={Receipt}
            onClick={() => router.push('/separacao?status=completed')}
          />
          <KpiCard
            tone="orange"
            label="Em separação"
            value={loading ? '…' : emSeparacao}
            hint="Filiais separando agora"
            icon={Truck}
            onClick={() => router.push('/separacao?status=separacao')}
          />
          <KpiCard
            tone="purple"
            label="Lojas online"
            value={loading ? '…' : `${lojasOnline}/${lojasTotal}`}
            hint={`${emTransito} pedido(s) em trânsito`}
            icon={Wifi}
            onClick={() => router.push('/separacao?status=em-transito')}
          />
        </div>
      </section>

      {/* === Atalhos pros 4 hubs (cores combinadas com KPIs) === */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
        <HubCard href="/site"       label="Site"   subtitle="E-commerce"     description="Pedidos · Marketing · Vitrine" tone="teal" icon={Globe2} />
        <HubCard href="/loja"       label="Loja"   subtitle="Operação física" description="Estoque · Crediário · Materiais" tone="green" icon={Store} />
        <HubCard href="/retaguarda" label="Gestão" subtitle="Estratégico"    description="Inteligência · Financeiro · Cobrança" tone="orange" icon={BarChart3} />
        <HubCard href="/config"     label="Config" subtitle="Setup técnico"  description="NFC-e · Pagamentos · WhatsApp" tone="purple" icon={Settings} />
      </section>

      {/* === Filtros + Status lojas === */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Filtros */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Filter className="w-4 h-4 text-slate-500" />
                Filtros
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">Loja · período</p>
            </div>
            <button
              onClick={() => { setFilterStore(''); setFilterFrom(''); setFilterTo(''); }}
              className="text-xs px-3 py-1.5 rounded-lg bg-orange-500 hover:bg-orange-600 text-white font-bold"
            >
              Limpar
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Loja</label>
              <select
                value={filterStore}
                onChange={(e) => setFilterStore(e.target.value)}
                className="w-full text-sm rounded-lg border border-slate-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500"
              >
                <option value="">Todas</option>
                {presence.map((p) => (
                  <option key={p.code} value={p.code}>{p.code} · {p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Data inicial</label>
              <input
                type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)}
                className="w-full text-sm rounded-lg border border-slate-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Data final</label>
              <input
                type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)}
                className="w-full text-sm rounded-lg border border-slate-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500"
              />
            </div>
          </div>
          {/* Breakdown de status */}
          {Object.keys(counts).length > 0 && (
            <div className="mt-5 pt-4 border-t border-slate-100">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">Pedidos por status</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(counts)
                  .sort((a, b) => (b[1].total || 0) - (a[1].total || 0))
                  .filter(([_, info]) => (info.total || 0) > 0)
                  .map(([slug, info]) => (
                    <div key={slug} className="px-3 py-1.5 rounded-lg bg-slate-100 border border-slate-200 text-xs">
                      <span className="font-semibold text-slate-700">{info.name}</span>{' '}
                      <span className="font-bold text-slate-900">{info.total}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>

        {/* Resumo das lojas (online/offline) */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Store className="w-4 h-4 text-slate-500" />
                Status lojas
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
            <div className="text-center py-6 text-slate-400 text-sm">Nenhuma loja com os filtros atuais.</div>
          )}
          {!loading && filteredPresence.length > 0 && (
            <div className="space-y-1.5 max-h-[320px] overflow-y-auto pr-1">
              {filteredPresence.map((p) => (
                <div key={p.code} className="flex items-center gap-2 py-1.5 px-2.5 rounded-lg hover:bg-slate-50 transition">
                  <span className={`w-2 h-2 rounded-full ${p.online ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-slate-800 truncate">{p.code} · {p.name}</div>
                  </div>
                  {p.online ? <Wifi className="w-3.5 h-3.5 text-emerald-600" /> : <WifiOff className="w-3.5 h-3.5 text-slate-400" />}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </AdminShell>
  );
}

// ============================================================================
// HubCard — card grande pros 4 hubs (cores em sintonia com KpiCard)
// ============================================================================
const HUB_TONES = {
  teal:   { from: '#0e7e87', to: '#0a5a62' },
  green:  { from: '#5b9b3e', to: '#3f7029' },
  orange: { from: '#d68a3c', to: '#b66a1f' },
  purple: { from: '#8a5cb6', to: '#5f3e8a' },
} as const;

function HubCard({
  href, label, subtitle, description, tone, icon: Icon,
}: {
  href: string;
  label: string;
  subtitle: string;
  description: string;
  tone: keyof typeof HUB_TONES;
  icon: typeof Globe2;
}) {
  const t = HUB_TONES[tone];
  return (
    <Link
      href={href}
      className="relative overflow-hidden rounded-2xl px-5 py-5 text-white shadow-sm hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 transition flex flex-col gap-2"
      style={{ background: `linear-gradient(135deg, ${t.from} 0%, ${t.to} 100%)` }}
    >
      <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full opacity-15"
           style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
      <div className="relative flex items-center justify-between">
        <Icon className="w-6 h-6 opacity-90" strokeWidth={1.7} />
        <ArrowUpRight className="w-4 h-4 opacity-70" />
      </div>
      <div className="relative">
        <div className="text-[11px] font-bold tracking-wider uppercase opacity-90">{subtitle}</div>
        <div className="text-2xl font-bold leading-tight mt-0.5">{label}</div>
        <div className="text-[11px] opacity-80 mt-1.5 leading-snug">{description}</div>
      </div>
    </Link>
  );
}

// ============================================================================
// PilotPill — toggle do Piloto Automático (mantido do v10)
// ============================================================================
function PilotPill({
  pilot, busy, status, onToggle,
}: {
  pilot: boolean;
  busy: boolean;
  status: PilotStatus | null;
  onToggle: () => void;
}) {
  const disabled = busy || status?.killSwitch === true;
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className="group flex items-center gap-2 px-4 py-2 rounded-full transition disabled:opacity-50 disabled:cursor-not-allowed shadow-sm hover:shadow"
      style={{
        background: pilot ? '#e3ebd9' : 'white',
        border: `2px solid ${pilot ? '#9caf88' : '#e2e8f0'}`,
      }}
      title={
        status?.killSwitch
          ? 'Bloqueado via env PILOT_DISABLED=1.'
          : pilot
          ? `Pedidos automáticos. WA: ${status?.whatsappConnected ? 'OK' : 'DESCONECTADO ⚠️'}.`
          : 'Envio manual. Clique pra ligar.'
      }
    >
      <div
        className={`relative flex items-center justify-center w-7 h-7 rounded-full ${pilot ? 'pulse-soft' : ''}`}
        style={{ background: pilot ? '#5d7048' : '#f1f5f9' }}
      >
        {pilot ? (
          <Zap className="w-3.5 h-3.5 text-white" strokeWidth={2.2} fill="white" />
        ) : (
          <Bot className="w-3.5 h-3.5 text-slate-400" strokeWidth={1.8} />
        )}
      </div>
      <div className="text-left">
        <div className="text-[9px] uppercase tracking-wider text-slate-500 font-bold leading-none">
          Piloto {status?.killSwitch && '· bloq'}
        </div>
        <div className="text-xs font-bold leading-tight" style={{ color: pilot ? '#475636' : '#475569' }}>
          {busy ? '…' : pilot ? 'Ligado' : 'Desligado'}
        </div>
      </div>
      {pilot && status && !status.whatsappConnected && (
        <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: '#c9a96e' }} title="WhatsApp desconectado" />
      )}
    </button>
  );
}
