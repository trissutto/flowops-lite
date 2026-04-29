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
  LayoutDashboard, Globe2, Store, BarChart3, Settings,
  RefreshCw, Zap, Bot, ArrowUpRight,
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
    // Recarrega frase do dia + força re-render do clock
    setNow(new Date());
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

      {/* === Atalhos pros 4 hubs (cores combinadas com KPIs) === */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
        <HubCard href="/site"       label="Site"   subtitle="E-commerce"     description="Pedidos · Marketing · Vitrine" tone="teal" icon={Globe2} />
        <HubCard href="/loja"       label="Loja"   subtitle="Operação física" description="Estoque · Crediário · Materiais" tone="green" icon={Store} />
        <HubCard href="/retaguarda" label="Gestão" subtitle="Estratégico"    description="Inteligência · Financeiro · Cobrança" tone="orange" icon={BarChart3} />
        <HubCard href="/config"     label="Config" subtitle="Setup técnico"  description="NFC-e · Pagamentos · WhatsApp" tone="purple" icon={Settings} />
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
