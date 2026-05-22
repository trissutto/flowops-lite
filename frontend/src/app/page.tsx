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
  LayoutDashboard, Globe2, Store, BarChart3, Settings, Instagram,
  RefreshCw, Zap, Bot, ArrowUpRight, type LucideIcon,
  ShoppingBag, Shuffle, Package2, AlertTriangle, Truck, CreditCard, Bell,
  Building2,
} from 'lucide-react';
import { api } from '@/lib/api';
import { isPilotOn, fetchPilotStatus, togglePilotServer, PilotStatus } from '@/lib/auto-send-order';
import { getDailyQuote } from '@/lib/daily-quote';
import AdminShell, { type AdminNavItem } from '@/components/AdminShell';

// === Sidebar: 5 itens (Dashboard + 4 hubs) — usado quando a sidebar volta ===
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
  const [refreshing, setRefreshing] = useState(false);

  // Pilot
  const [pilot, setPilot] = useState(false);
  const [pilotStatus, setPilotStatus] = useState<PilotStatus | null>(null);
  const [pilotBusy, setPilotBusy] = useState(false);

  // Relógio live (atualiza a cada segundo)
  const [now, setNow] = useState<Date>(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // === ALERTAS — pendências que exigem ação da matriz ===
  const [alerts, setAlerts] = useState<{
    pedidosSite: number;
    naoEncontradas: number;
    materiaisPendentes: number;
    remessasTransito: number;
    crediarioAtraso: number;
  }>({ pedidosSite: 0, naoEncontradas: 0, materiaisPendentes: 0, remessasTransito: 0, crediarioAtraso: 0 });

  async function loadAlerts() {
    try {
      const [counts, naoEnc, materiais, shipKpis] = await Promise.all([
        api<{ byStatus: Record<string, { name: string; total: number }> }>('/orders/wc/counts').catch(() => null),
        api<any[]>('/realignment/not-found').catch(() => []),
        api<any[]>('/supplies/requests?status=pending').catch(() => []),
        api<{ inTransitCount?: number }>('/realignment/shipments/admin/kpis').catch(() => null),
      ]);
      const pendentesSite =
        (counts?.byStatus['processing']?.total ?? 0) +
        (counts?.byStatus['pending']?.total ?? 0) +
        (counts?.byStatus['on-hold']?.total ?? 0);
      setAlerts({
        pedidosSite: pendentesSite,
        naoEncontradas: Array.isArray(naoEnc) ? naoEnc.length : 0,
        materiaisPendentes: Array.isArray(materiais) ? materiais.length : 0,
        remessasTransito: shipKpis?.inTransitCount ?? 0,
        crediarioAtraso: 0, // placeholder — soma por loja é caro, deixa pra clicar e ver
      });
    } catch { /* silencioso */ }
  }

  useEffect(() => {
    loadAlerts();
    const id = setInterval(loadAlerts, 60_000);
    return () => clearInterval(id);
  }, []);

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
        else if (me.role === 'contador') router.push('/retaguarda/relatorio-fiscal');
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

  // Sem KPIs/contadores na home — só feedback visual no botão Atualizar.

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
    setNow(new Date());
    loadAlerts();
    setTimeout(() => setRefreshing(false), 400);
  }

  const today = now.toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long',
  });

  // Saudação dinâmica por horário
  const hour = now.getHours();
  const greeting =
    hour < 5 ? 'Boa madrugada' :
    hour < 12 ? 'Bom dia' :
    hour < 18 ? 'Boa tarde' :
    'Boa noite';
  const firstName = userName ? userName.split(' ')[0] : '';
  const heading = firstName ? `${greeting}, ${firstName}` : greeting;

  // Frase do dia (determinística — mesma o dia inteiro)
  const quote = useMemo(() => getDailyQuote(now), [now.toDateString()]);

  // Relógio HH:MM:SS
  const clockHHMM = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const clockSS = now.toLocaleTimeString('pt-BR', { second: '2-digit' });

  return (
    <AdminShell
      title={heading}
      subtitle={
        <span className="capitalize">
          {today} · <span className="text-slate-700 font-semibold">Lurds Order One</span>
        </span>
      }
      navItems={NAV}
      activeKey="dashboard"
      noSidebar
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
      {/* === Frase do dia + Relógio === */}
      <section
        className="rounded-2xl mb-5 overflow-hidden shadow-sm border border-slate-200 relative"
        style={{
          background: 'linear-gradient(120deg, #fdfaf3 0%, #fdf2f8 50%, #f5e6e3 100%)',
        }}
      >
        {/* Decoração: círculo claro no canto direito */}
        <div
          className="absolute -top-12 -right-12 w-48 h-48 rounded-full opacity-40"
          style={{ background: 'radial-gradient(circle, #f5d9e6 0%, transparent 70%)' }}
        />
        <div className="relative grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 p-5 sm:p-6 items-center">
          {/* Frase */}
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-rose-700/70 mb-2">
              Frase do dia
            </div>
            <blockquote
              className="text-lg sm:text-xl text-slate-800 leading-snug italic"
              style={{ fontFamily: 'var(--font-display), Georgia, serif' }}
            >
              "{quote.text}"
            </blockquote>
            {quote.author && (
              <div className="text-xs text-slate-500 mt-2">— {quote.author}</div>
            )}
          </div>
          {/* Relógio */}
          <div className="md:border-l md:border-rose-200/60 md:pl-6 flex md:flex-col items-center md:items-end justify-center gap-2 md:gap-1">
            <div
              className="font-bold text-3xl sm:text-4xl tabular-nums text-slate-800 leading-none"
              style={{ fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}
            >
              {clockHHMM}
              <span className="text-base sm:text-lg text-rose-500/70 ml-1.5">{clockSS}</span>
            </div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-semibold">
              Horário local
            </div>
          </div>
        </div>
      </section>

      {/* === ALERTAS · só mostra o que tem ação pendente === */}
      <AlertsSection alerts={alerts} />

      {/* === Atalhos pros 6 hubs (cores combinadas com KPIs) === */}
      <section className="grid grid-cols-2 lg:grid-cols-6 gap-3 sm:gap-4 mb-5">
        <HubCard href="/site"               label="Site"      subtitle="E-commerce"      description="Pedidos · Marketing · Vitrine" tone="teal"   icon={Globe2} />
        <HubCard href="/loja"               label="Loja"      subtitle="Operação física" description="Estoque · Crediário · Materiais" tone="green"  icon={Store} />
        <HubCard href="/retaguarda/instagram-hub" label="Instagram" subtitle="Redes & Live"  description="Inbox · Live · Conta @lurdsplussize" tone="rose" icon={Instagram} />
        <HubCard href="/retaguarda"         label="Gestão"    subtitle="Estratégico"     description="Inteligência · Financeiro · Cobrança" tone="orange" icon={BarChart3} />
        <HubCard href="/imobiliario"        label="Imóveis"   subtitle="Patrimônio"      description="Cadastro · IPTU · Contas · Cartório" tone="amber" icon={Building2} />
        <HubCard href="/config"             label="Config"    subtitle="Setup técnico"   description="NFC-e · Pagamentos · WhatsApp" tone="purple" icon={Settings} />
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
  rose:   { from: '#e11d6c', to: '#b91754' },
  // Amber/dourado pro hub Imobiliário — tom premium discreto
  amber:  { from: '#c9a96e', to: '#8a7340' },
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

// ============================================================================
// AlertsSection — pendências que pedem ação da matriz (só mostra se > 0)
// ============================================================================
type AlertItem = {
  href: string;
  count: number;
  label: string;
  hint: string;
  icon: LucideIcon;
  tone: 'rose' | 'amber' | 'sky' | 'violet' | 'emerald' | 'orange';
};

const ALERT_TONES: Record<AlertItem['tone'], { bg: string; icon: string; text: string; border: string }> = {
  rose:    { bg: '#fff1f3', icon: '#c95a78', text: '#9a3f59', border: '#f5c4cf' },
  amber:   { bg: '#fff8eb', icon: '#c9a96e', text: '#8a7340', border: '#f0e0b8' },
  sky:     { bg: '#eef7fb', icon: '#3b82a8', text: '#1f5f80', border: '#c7e0ee' },
  violet:  { bg: '#f3eefb', icon: '#8a5cb6', text: '#5f3e8a', border: '#dccaf2' },
  emerald: { bg: '#ecf5ed', icon: '#5b9b3e', text: '#3f7029', border: '#c8e0c8' },
  orange:  { bg: '#fdf1e6', icon: '#d68a3c', text: '#b66a1f', border: '#f4d4b1' },
};

function AlertsSection({ alerts }: {
  alerts: {
    pedidosSite: number;
    naoEncontradas: number;
    materiaisPendentes: number;
    remessasTransito: number;
    crediarioAtraso: number;
  };
}) {
  const items: AlertItem[] = [
    { href: '/separacao?status=processing', count: alerts.pedidosSite,        label: 'Pedidos site pendentes',     hint: 'Aguardando separação',    icon: ShoppingBag,    tone: 'rose'    },
    { href: '/retaguarda/realinhamento/nao-encontrados', count: alerts.naoEncontradas,    label: 'Realinhamento — não encontradas', hint: 'Filiais reportaram',  icon: AlertTriangle, tone: 'amber'   },
    { href: '/retaguarda/materiais',         count: alerts.materiaisPendentes, label: 'Pedidos de materiais',       hint: 'Filiais aguardando',      icon: Package2,       tone: 'violet'  },
    { href: '/retaguarda/remessas',          count: alerts.remessasTransito,   label: 'Remessas em trânsito',       hint: 'Aguardando recebimento',  icon: Truck,          tone: 'sky'     },
    { href: '/retaguarda/crediario',         count: alerts.crediarioAtraso,    label: 'Crediário em atraso',        hint: 'Cobrança pendente',       icon: CreditCard,     tone: 'orange'  },
  ];
  const visible = items.filter((it) => it.count > 0);

  if (visible.length === 0) {
    return (
      <div className="mb-5 bg-white border border-slate-200 rounded-2xl p-4 flex items-center gap-3 shadow-sm">
        <div className="w-9 h-9 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center">
          <Bell className="w-4 h-4" />
        </div>
        <div>
          <div className="font-semibold text-sm text-slate-800">Tudo em ordem</div>
          <div className="text-xs text-slate-500">Nenhuma pendência exigindo ação agora.</div>
        </div>
      </div>
    );
  }

  return (
    <section className="mb-5">
      <div className="flex items-center gap-2 mb-3">
        <Bell className="w-4 h-4 text-rose-600" />
        <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider">
          Alertas — {visible.length} {visible.length === 1 ? 'pendência' : 'pendências'}
        </h2>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {visible.map((it) => <AlertCard key={it.href} item={it} />)}
      </div>
    </section>
  );
}

function AlertCard({ item }: { item: AlertItem }) {
  const t = ALERT_TONES[item.tone];
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className="rounded-xl px-4 py-3 flex items-center gap-3 transition hover:shadow-md hover:-translate-y-0.5 active:translate-y-0"
      style={{ background: t.bg, border: `1.5px solid ${t.border}` }}
    >
      <div
        className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 shadow-sm"
        style={{ background: 'white' }}
      >
        <Icon className="w-5 h-5" style={{ color: t.icon }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <div className="font-bold text-2xl tabular-nums" style={{ color: t.text }}>
            {item.count}
          </div>
          <div className="text-sm font-semibold truncate" style={{ color: t.text }}>
            {item.label}
          </div>
        </div>
        <div className="text-[11px] text-slate-500 truncate">{item.hint}</div>
      </div>
      <ArrowUpRight className="w-4 h-4 text-slate-400 shrink-0" />
    </Link>
  );
}
