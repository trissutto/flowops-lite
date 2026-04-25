'use client';

/**
 * / — Home/Launchpad LURDS (v7 — PASTEL TABLET).
 *
 * Inspirado em ScapeBuilder/HS-Net: grade de botões circulares grandes,
 * cada módulo com sua cor pastel (rosa, pêssego, hortelã, lavanda, céu,
 * amarelo, coral, creme). Painel central como se fosse um tablet.
 *
 * - Header: logo + nome + data
 * - Grid principal: 4×2 botões circulares (módulos mãe)
 * - Linha utilitária: 4 botões pequenos (Piloto, Site, ERP, Logs)
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ClipboardList, Boxes, TrendingUp, Settings,
  Megaphone, Inbox, CreditCard, MessageCircle,
  Zap, Bot, ShoppingBag, Database, FileText,
  type LucideIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { isPilotOn, fetchPilotStatus, togglePilotServer, PilotStatus } from '@/lib/auto-send-order';

interface CountsResp {
  byStatus: Record<string, { name: string; total: number }>;
  grand: number;
}

type PastelTone = 'rose' | 'peach' | 'mint' | 'sky' | 'lavender' | 'yellow' | 'coral' | 'cream';

type ModuleButton = {
  href: string;
  label: string;
  icon: LucideIcon;
  tone: PastelTone;
  kpiKey?: string;
  badge?: 'count' | 'dot';
};

// 8 módulos mãe — grade 4×2
const MODULES: ModuleButton[] = [
  { href: '/separacao',           label: 'Pedidos',     icon: ClipboardList,  tone: 'rose',     kpiKey: 'processing', badge: 'count' },
  { href: '/retaguarda',          label: 'Retaguarda',  icon: Boxes,          tone: 'peach' },
  { href: '/gestao',              label: 'Gestão',      icon: TrendingUp,     tone: 'mint' },
  { href: '/sistema',             label: 'Sistema',     icon: Settings,       tone: 'lavender' },
  { href: '/marketing/recuperacao', label: 'Marketing',  icon: Megaphone,      tone: 'sky' },
  { href: '/retaguarda/materiais', label: 'Materiais',   icon: Inbox,          tone: 'yellow' },
  { href: '/crediario',           label: 'Crediário',   icon: CreditCard,     tone: 'coral' },
  { href: '/retaguarda/whatsapp', label: 'WhatsApp',    icon: MessageCircle,  tone: 'cream' },
];

// Linha utilitária — atalhos rápidos
type UtilityButton = {
  href: string;
  label: string;
  icon: LucideIcon;
  tone: PastelTone;
};
const UTILITIES: UtilityButton[] = [
  { href: '/retaguarda/baixas-log', label: 'Baixas',  icon: FileText, tone: 'sky' },
  { href: '/retaguarda',            label: 'ERP',     icon: Database, tone: 'mint' },
  { href: '/separacao',             label: 'Site',    icon: ShoppingBag, tone: 'rose' },
];

// Mapa de tons pastel → cores reais (hex e sombras)
const TONE_MAP: Record<PastelTone, { ring: string; bg: string; icon: string; badge: string }> = {
  rose:     { ring: '#f9a8d4', bg: '#fdf2f8', icon: '#db2777', badge: '#ec4899' },
  peach:    { ring: '#fdba74', bg: '#fff7ed', icon: '#ea580c', badge: '#f97316' },
  mint:     { ring: '#86efac', bg: '#f0fdf4', icon: '#16a34a', badge: '#22c55e' },
  sky:      { ring: '#7dd3fc', bg: '#f0f9ff', icon: '#0284c7', badge: '#0ea5e9' },
  lavender: { ring: '#c4b5fd', bg: '#f5f3ff', icon: '#7c3aed', badge: '#8b5cf6' },
  yellow:   { ring: '#fde68a', bg: '#fefce8', icon: '#ca8a04', badge: '#eab308' },
  coral:    { ring: '#fca5a5', bg: '#fef2f2', icon: '#dc2626', badge: '#ef4444' },
  cream:    { ring: '#fcd6a5', bg: '#fffbeb', icon: '#a16207', badge: '#d97706' },
};

export default function DashboardHome() {
  const router = useRouter();
  const [counts, setCounts] = useState<Record<string, { name: string; total: number }>>({});
  const [enviadosHoje, setEnviadosHoje] = useState<number>(0);
  const [userName, setUserName] = useState<string>('');
  const [pilot, setPilot] = useState(false);
  const [pilotStatus, setPilotStatus] = useState<PilotStatus | null>(null);
  const [pilotBusy, setPilotBusy] = useState(false);

  // Guard de sessão + role
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    api<{ role: string; name?: string }>('/auth/me')
      .then((me) => {
        if (me.role === 'store') router.push('/minha-loja');
        if (me.name) setUserName(me.name);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Piloto Automático
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

  // KPIs
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const cnt = await api<CountsResp>('/orders/wc/counts');
        if (!cancelled) setCounts(cnt.byStatus);
      } catch {}
      try {
        const env = await api<any>('/retaguarda/enviados-hoje');
        if (!cancelled) {
          if (Array.isArray(env)) {
            const total = env.reduce((a, x: any) => a + (x.total ?? x.count ?? 0), 0);
            setEnviadosHoje(total);
          } else if (env?.total != null) {
            setEnviadosHoje(env.total);
          } else if (env?.stores && Array.isArray(env.stores)) {
            const total = env.stores.reduce((a: number, x: any) => a + (x.total ?? 0), 0);
            setEnviadosHoje(total);
          }
        }
      } catch {}
    }
    load();
    const timer = setInterval(load, 30_000);
    const sock = getSocket();
    const onAny = () => load();
    sock.on('order:new', onAny);
    sock.on('order:status-changed', onAny);
    return () => {
      cancelled = true;
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
          alert('Piloto LIGADO, mas o WhatsApp não está conectado. Conecte em /retaguarda/whatsapp antes de receber pedidos.');
        }
      } else {
        setPilot(!next);
        alert('Não foi possível mudar o estado do Piloto. Tenta de novo.');
      }
    } catch {
      setPilot(!next);
    } finally {
      setPilotBusy(false);
    }
  }

  const today = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long',
  });

  const totalPending =
    (counts['processing']?.total ?? 0) +
    (counts['separacao']?.total ?? 0) +
    (counts['pending']?.total ?? 0) +
    (counts['on-hold']?.total ?? 0);

  return (
    <div
      className="min-h-screen"
      style={{
        background:
          'radial-gradient(1100px 600px at 50% -10%, #fce7f3 0%, transparent 60%), linear-gradient(180deg, #fef9f3 0%, #fdf2f8 100%)',
      }}
    >
      <div className="max-w-6xl mx-auto px-6 sm:px-10 py-10 sm:py-14">

        {/* Header ------------------------------------------------------- */}
        <header className="flex items-center justify-between flex-wrap gap-6 mb-8 fade-up">
          <div>
            <div className="text-[11px] uppercase tracking-[0.3em] text-pink-400 font-semibold mb-2">
              Lurds Order One
            </div>
            <h1 className="font-display text-4xl sm:text-5xl text-slate-800 leading-tight">
              {userName ? <>Oi, <span className="text-pink-500 italic">{userName.split(' ')[0]}</span> 🌸</> : 'Bem-vindo 🌸'}
            </h1>
            <div className="text-sm text-slate-500 mt-2 capitalize">{today}</div>
          </div>

          <PilotPill
            pilot={pilot}
            busy={pilotBusy}
            status={pilotStatus}
            onToggle={togglePilot}
          />
        </header>

        {/* Faixa de KPI rápida ----------------------------------------- */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-8 fade-up" style={{ animationDelay: '0.05s' }}>
          <MiniKpi label="Pendentes" value={totalPending} tone="rose" />
          <MiniKpi label="Processando" value={counts['processing']?.total ?? 0} tone="peach" />
          <MiniKpi label="Em separação" value={counts['separacao']?.total ?? 0} tone="lavender" />
          <MiniKpi label="Enviados hoje" value={enviadosHoje} tone="mint" />
        </section>

        {/* Painel principal — "tablet" pastel --------------------------- */}
        <section
          className="panel-pastel p-6 sm:p-10 fade-up"
          style={{ animationDelay: '0.1s' }}
        >
          {/* Grade de 8 botões circulares — 4 col × 2 row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-y-8 gap-x-4 sm:gap-x-6 justify-items-center">
            {MODULES.map((mod, idx) => {
              const kpi = mod.kpiKey ? counts[mod.kpiKey]?.total : undefined;
              return (
                <CircleButton
                  key={mod.href}
                  module={mod}
                  badgeValue={mod.badge === 'count' ? kpi : undefined}
                  index={idx}
                />
              );
            })}
          </div>

          {/* Divisor pastel */}
          <div className="my-8 h-px bg-gradient-to-r from-transparent via-pink-200 to-transparent" />

          {/* Linha de utilitários — botões menores */}
          <div className="flex items-center justify-center gap-6 sm:gap-10 flex-wrap">
            {UTILITIES.map((u, idx) => (
              <UtilityCircle key={u.href} util={u} index={idx} />
            ))}
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-8 flex items-center justify-between text-xs text-slate-400">
          <span>Lurds · Plus Size</span>
          <span className="text-pink-400">Launchpad v7</span>
        </footer>
      </div>
    </div>
  );
}

// ============================================================================
// Botão circular grande — módulo mãe
// ============================================================================
function CircleButton({
  module: mod,
  badgeValue,
  index,
}: {
  module: ModuleButton;
  badgeValue?: number;
  index: number;
}) {
  const Icon = mod.icon;
  const tone = TONE_MAP[mod.tone];
  return (
    <Link
      href={mod.href}
      className="group flex flex-col items-center gap-3 fade-up"
      style={{ animationDelay: `${0.15 + index * 0.05}s` }}
    >
      <div className="relative">
        <div
          className="circle-ring flex items-center justify-center w-[88px] h-[88px] sm:w-[104px] sm:h-[104px]"
          style={{
            border: `4px solid ${tone.ring}`,
            background: tone.bg,
          }}
        >
          <Icon
            className="w-9 h-9 sm:w-11 sm:h-11 transition-transform duration-500 group-hover:scale-110"
            style={{ color: tone.icon }}
            strokeWidth={1.6}
          />
        </div>
        {badgeValue != null && badgeValue > 0 && (
          <span
            className="circle-badge"
            style={{ background: tone.badge }}
          >
            {badgeValue > 99 ? '99+' : badgeValue}
          </span>
        )}
      </div>
      <div className="text-sm sm:text-base font-medium text-slate-700 group-hover:text-slate-900 transition-colors">
        {mod.label}
      </div>
    </Link>
  );
}

// ============================================================================
// Botão circular pequeno — utilitário (linha de baixo)
// ============================================================================
function UtilityCircle({ util, index }: { util: UtilityButton; index: number }) {
  const Icon = util.icon;
  const tone = TONE_MAP[util.tone];
  return (
    <Link
      href={util.href}
      className="group flex flex-col items-center gap-2 fade-up"
      style={{ animationDelay: `${0.5 + index * 0.05}s` }}
    >
      <div
        className="circle-ring flex items-center justify-center w-14 h-14"
        style={{
          border: `2.5px solid ${tone.ring}`,
          background: tone.bg,
        }}
      >
        <Icon className="w-5 h-5" style={{ color: tone.icon }} strokeWidth={1.7} />
      </div>
      <div className="text-[11px] font-medium text-slate-500 group-hover:text-slate-700 transition-colors">
        {util.label}
      </div>
    </Link>
  );
}

// ============================================================================
// Mini KPI — pílula pastel pequena no topo
// ============================================================================
function MiniKpi({ label, value, tone }: { label: string; value: number; tone: PastelTone }) {
  const t = TONE_MAP[tone];
  return (
    <div
      className="rounded-2xl px-4 py-3 flex items-center justify-between"
      style={{
        background: t.bg,
        border: `1px solid ${t.ring}`,
      }}
    >
      <div className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: t.icon }}>
        {label}
      </div>
      <div className="font-display text-2xl tabular-nums" style={{ color: t.icon }}>
        {value.toLocaleString('pt-BR')}
      </div>
    </div>
  );
}

// ============================================================================
// Piloto Pill — toggle pastel
// ============================================================================
function PilotPill({
  pilot,
  busy,
  status,
  onToggle,
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
      className="group flex items-center gap-3 px-5 py-3 rounded-full transition disabled:opacity-50 disabled:cursor-not-allowed shadow-sm hover:shadow-md"
      style={{
        background: pilot ? '#dcfce7' : 'white',
        border: `2px solid ${pilot ? '#86efac' : '#e2e8f0'}`,
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
        className={`relative flex items-center justify-center w-9 h-9 rounded-full ${pilot ? 'pulse-soft' : ''}`}
        style={{ background: pilot ? '#22c55e' : '#f1f5f9' }}
      >
        {pilot ? (
          <Zap className="w-4 h-4 text-white" strokeWidth={2.2} fill="white" />
        ) : (
          <Bot className="w-4 h-4 text-slate-400" strokeWidth={1.8} />
        )}
      </div>
      <div className="text-left">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          Piloto {status?.killSwitch && '· bloqueado'}
        </div>
        <div className={`text-sm font-semibold ${pilot ? 'text-green-700' : 'text-slate-600'}`}>
          {busy ? '…' : pilot ? 'Ligado' : 'Desligado'}
        </div>
      </div>
      {pilot && status && !status.whatsappConnected && (
        <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" title="WhatsApp desconectado" />
      )}
    </button>
  );
}
