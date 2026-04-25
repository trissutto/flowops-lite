'use client';

/**
 * / — Home/Launchpad LURDS (v8 — HIERARQUIA + CORES VIBRANTES).
 *
 * Reorganizado em 3 blocos por importância:
 *
 * 1. OPERAÇÃO (3 círculos GRANDES)        — fluxo crítico do dia: Pedidos,
 *    Retaguarda, WhatsApp. São os botões maiores e em destaque.
 *
 * 2. CRESCIMENTO (4 círculos médios)      — Marketing, Crediário, Materiais,
 *    Gestão. Importam mas não são da operação minuto-a-minuto.
 *
 * 3. SISTEMA (3 círculos pequenos)        — Sistema, Vendedoras, Vitrine.
 *    Acessos eventuais.
 *
 * Cores: paleta pastel "vibrante" — anéis saturados, fundos claros.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ClipboardList, Boxes, MessageCircle,
  Megaphone, CreditCard, Inbox, TrendingUp,
  Settings, Users, ShoppingBag,
  Zap, Bot, type LucideIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { isPilotOn, fetchPilotStatus, togglePilotServer, PilotStatus } from '@/lib/auto-send-order';
import { TONE_MAP, type PastelTone } from '@/components/PastelShell';

interface CountsResp {
  byStatus: Record<string, { name: string; total: number }>;
  grand: number;
}

type Module = {
  href: string;
  label: string;
  icon: LucideIcon;
  tone: PastelTone;
  kpiKey?: string;
  subtitle?: string;
};

// BLOCO 1 — OPERAÇÃO: 3 botões GRANDES, fluxo crítico do dia
const OPERATION: Module[] = [
  { href: '/separacao',           label: 'Pedidos',     icon: ClipboardList, tone: 'rose',  kpiKey: 'processing', subtitle: 'Separação e envio' },
  { href: '/retaguarda',          label: 'Retaguarda',  icon: Boxes,         tone: 'peach',                       subtitle: 'Baixas, ERP, materiais' },
  { href: '/retaguarda/whatsapp', label: 'WhatsApp',    icon: MessageCircle, tone: 'mint',                        subtitle: 'Conexão + bulk' },
];

// BLOCO 2 — CRESCIMENTO: 4 botões médios, importam mas não são minuto-a-minuto
const GROWTH: Module[] = [
  { href: '/marketing',            label: 'Marketing',  icon: Megaphone,   tone: 'sky',      subtitle: 'CRM + recuperação' },
  { href: '/crediario',            label: 'Crediário',  icon: CreditCard,  tone: 'coral',    subtitle: 'Cobrança + parcelas' },
  { href: '/retaguarda/materiais', label: 'Materiais',  icon: Inbox,       tone: 'yellow',   subtitle: 'Pedidos das filiais' },
  { href: '/gestao',               label: 'Gestão',     icon: TrendingUp,  tone: 'lavender', subtitle: 'Financeiro · CRM' },
];

// BLOCO 3 — SISTEMA: 3 botões pequenos, acessos eventuais
const SYSTEM: Module[] = [
  { href: '/sistema',              label: 'Sistema',    icon: Settings,     tone: 'lavender' },
  { href: '/retaguarda/vendedoras', label: 'Vendedoras', icon: Users,       tone: 'rose' },
  { href: '/vitrine',              label: 'Vitrine',    icon: ShoppingBag, tone: 'cream' },
];

export default function DashboardHome() {
  const router = useRouter();
  const [counts, setCounts] = useState<Record<string, { name: string; total: number }>>({});
  const [enviadosHoje, setEnviadosHoje] = useState<number>(0);
  const [userName, setUserName] = useState<string>('');
  const [pilot, setPilot] = useState(false);
  const [pilotStatus, setPilotStatus] = useState<PilotStatus | null>(null);
  const [pilotBusy, setPilotBusy] = useState(false);

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
          'radial-gradient(1100px 600px at 50% -10%, #f0e6cf 0%, transparent 55%), linear-gradient(180deg, #fdfaf3 0%, #f3e9d8 100%)',
      }}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 sm:py-12">

        {/* Header ------------------------------------------------------- */}
        <header className="flex items-center justify-between flex-wrap gap-6 mb-8 fade-up">
          <div>
            <div className="text-[11px] uppercase tracking-[0.3em] font-bold mb-2" style={{ color: '#8b4f55' }}>
              Lurds Order One
            </div>
            <h1 className="font-display text-4xl sm:text-5xl text-slate-800 leading-tight">
              {userName ? <>Olá, <span className="italic" style={{ color: '#8b4f55' }}>{userName.split(' ')[0]}</span></> : 'Bem-vinda'}
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

        {/* KPIs vibrantes ------------------------------------------------ */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-10 fade-up" style={{ animationDelay: '0.05s' }}>
          <MiniKpi label="Pendentes" value={totalPending} tone="rose" />
          <MiniKpi label="Processando" value={counts['processing']?.total ?? 0} tone="peach" />
          <MiniKpi label="Em separação" value={counts['separacao']?.total ?? 0} tone="lavender" />
          <MiniKpi label="Enviados hoje" value={enviadosHoje} tone="mint" />
        </section>

        {/* BLOCO 1: OPERAÇÃO — 3 grandes ------------------------------- */}
        <SectionHeader
          eyebrow="Operação do dia"
          title="O que importa agora"
          accent="#e11d48"
        />
        <section
          className="panel-pastel p-6 sm:p-10 mb-6 fade-up"
          style={{ animationDelay: '0.1s' }}
        >
          <div className="grid grid-cols-3 gap-4 sm:gap-8 justify-items-center">
            {OPERATION.map((mod, idx) => {
              const kpi = mod.kpiKey ? counts[mod.kpiKey]?.total : undefined;
              return (
                <BigCircle
                  key={mod.href}
                  module={mod}
                  badge={kpi}
                  index={idx}
                />
              );
            })}
          </div>
        </section>

        {/* BLOCO 2: CRESCIMENTO — 4 médios ------------------------------ */}
        <SectionHeader
          eyebrow="Crescimento"
          title="Vendas, marketing e operação interna"
          accent="#0ea5e9"
        />
        <section
          className="panel-pastel p-5 sm:p-8 mb-6 fade-up"
          style={{ animationDelay: '0.15s' }}
        >
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-y-6 gap-x-4 justify-items-center">
            {GROWTH.map((mod, idx) => (
              <MidCircle key={mod.href} module={mod} index={idx} />
            ))}
          </div>
        </section>

        {/* BLOCO 3: SISTEMA — 3 pequenos -------------------------------- */}
        <SectionHeader
          eyebrow="Sistema"
          title="Configurações e atalhos"
          accent="#7c3aed"
        />
        <section
          className="panel-pastel p-4 sm:p-6 mb-6 fade-up"
          style={{ animationDelay: '0.2s' }}
        >
          <div className="grid grid-cols-3 gap-4 justify-items-center">
            {SYSTEM.map((mod, idx) => (
              <SmallCircle key={mod.href} module={mod} index={idx} />
            ))}
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-8 flex items-center justify-between text-xs text-slate-400">
          <span>Lurds · Plus Size</span>
          <span className="text-pink-500 font-semibold">Launchpad v8</span>
        </footer>
      </div>
    </div>
  );
}

// ============================================================================
// Section Header — eyebrow + título + linha colorida
// ============================================================================
function SectionHeader({ eyebrow, title, accent }: { eyebrow: string; title: string; accent: string }) {
  return (
    <div className="flex items-center gap-3 mb-3 fade-up">
      <div className="h-2 w-2 rounded-full" style={{ background: accent, boxShadow: `0 0 0 4px ${accent}22` }} />
      <div>
        <div className="text-[10px] uppercase tracking-[0.3em] font-bold" style={{ color: accent }}>
          {eyebrow}
        </div>
        <div className="font-display text-xl sm:text-2xl text-slate-700 leading-tight">{title}</div>
      </div>
    </div>
  );
}

// ============================================================================
// BigCircle — botão circular GRANDE (operação)
// ============================================================================
function BigCircle({ module: mod, badge, index }: { module: Module; badge?: number; index: number }) {
  const Icon = mod.icon;
  const t = TONE_MAP[mod.tone];
  return (
    <Link
      href={mod.href}
      className="group flex flex-col items-center gap-3 fade-up"
      style={{ animationDelay: `${0.15 + index * 0.06}s` }}
    >
      <div className="relative">
        <div
          className="circle-ring flex items-center justify-center w-[120px] h-[120px] sm:w-[140px] sm:h-[140px]"
          style={{
            border: `5px solid ${t.ring}`,
            background: t.bg,
            boxShadow: `0 8px 30px ${t.ring}40, 0 1px 0 rgba(255,255,255,0.95) inset`,
          }}
        >
          <Icon
            className="w-12 h-12 sm:w-14 sm:h-14 transition-transform duration-500 group-hover:scale-110"
            style={{ color: t.icon }}
            strokeWidth={1.6}
          />
        </div>
        {badge != null && badge > 0 && (
          <span
            className="circle-badge"
            style={{
              background: t.badge,
              minWidth: 30,
              height: 30,
              fontSize: 13,
              top: -6,
              right: -6,
            }}
          >
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </div>
      <div className="text-center">
        <div className="font-display text-lg sm:text-2xl font-medium text-slate-800 leading-tight">
          {mod.label}
        </div>
        {mod.subtitle && (
          <div className="text-[11px] sm:text-xs text-slate-500 mt-0.5">{mod.subtitle}</div>
        )}
      </div>
    </Link>
  );
}

// ============================================================================
// MidCircle — botão circular médio (crescimento)
// ============================================================================
function MidCircle({ module: mod, index }: { module: Module; index: number }) {
  const Icon = mod.icon;
  const t = TONE_MAP[mod.tone];
  return (
    <Link
      href={mod.href}
      className="group flex flex-col items-center gap-2 fade-up"
      style={{ animationDelay: `${0.2 + index * 0.05}s` }}
    >
      <div
        className="circle-ring flex items-center justify-center w-[80px] h-[80px] sm:w-[92px] sm:h-[92px]"
        style={{
          border: `4px solid ${t.ring}`,
          background: t.bg,
          boxShadow: `0 6px 20px ${t.ring}30, 0 1px 0 rgba(255,255,255,0.95) inset`,
        }}
      >
        <Icon
          className="w-8 h-8 sm:w-10 sm:h-10 transition-transform duration-500 group-hover:scale-110"
          style={{ color: t.icon }}
          strokeWidth={1.6}
        />
      </div>
      <div className="text-center">
        <div className="text-sm font-semibold text-slate-700 leading-tight">{mod.label}</div>
        {mod.subtitle && (
          <div className="text-[10px] text-slate-400 leading-tight">{mod.subtitle}</div>
        )}
      </div>
    </Link>
  );
}

// ============================================================================
// SmallCircle — botão circular pequeno (sistema)
// ============================================================================
function SmallCircle({ module: mod, index }: { module: Module; index: number }) {
  const Icon = mod.icon;
  const t = TONE_MAP[mod.tone];
  return (
    <Link
      href={mod.href}
      className="group flex flex-col items-center gap-1.5 fade-up"
      style={{ animationDelay: `${0.25 + index * 0.04}s` }}
    >
      <div
        className="circle-ring flex items-center justify-center w-14 h-14 sm:w-16 sm:h-16"
        style={{
          border: `3px solid ${t.ring}`,
          background: t.bg,
        }}
      >
        <Icon
          className="w-5 h-5 sm:w-6 sm:h-6 transition-transform duration-500 group-hover:scale-110"
          style={{ color: t.icon }}
          strokeWidth={1.7}
        />
      </div>
      <div className="text-[11px] sm:text-xs font-medium text-slate-600 leading-tight">{mod.label}</div>
    </Link>
  );
}

// ============================================================================
// MiniKpi — pílula pastel pequena no topo (cores vibrantes)
// ============================================================================
function MiniKpi({ label, value, tone }: { label: string; value: number; tone: PastelTone }) {
  const t = TONE_MAP[tone];
  return (
    <div
      className="rounded-2xl px-4 py-3 flex items-center justify-between transition hover:scale-[1.02]"
      style={{
        background: t.bg,
        border: `2px solid ${t.ring}`,
        boxShadow: `0 4px 12px ${t.ring}25`,
      }}
    >
      <div className="text-[11px] uppercase tracking-wider font-bold" style={{ color: t.text }}>
        {label}
      </div>
      <div className="font-display text-2xl tabular-nums font-semibold" style={{ color: t.icon }}>
        {value.toLocaleString('pt-BR')}
      </div>
    </div>
  );
}

// ============================================================================
// PilotPill — toggle pastel
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
      className="group flex items-center gap-3 px-5 py-3 rounded-full transition disabled:opacity-50 disabled:cursor-not-allowed shadow-md hover:shadow-lg"
      style={{
        background: pilot ? '#d1fae5' : 'white',
        border: `2.5px solid ${pilot ? '#34d399' : '#e2e8f0'}`,
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
        style={{ background: pilot ? '#10b981' : '#f1f5f9' }}
      >
        {pilot ? (
          <Zap className="w-4 h-4 text-white" strokeWidth={2.2} fill="white" />
        ) : (
          <Bot className="w-4 h-4 text-slate-400" strokeWidth={1.8} />
        )}
      </div>
      <div className="text-left">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
          Piloto {status?.killSwitch && '· bloqueado'}
        </div>
        <div className={`text-sm font-bold ${pilot ? 'text-emerald-700' : 'text-slate-600'}`}>
          {busy ? '…' : pilot ? 'Ligado' : 'Desligado'}
        </div>
      </div>
      {pilot && status && !status.whatsappConnected && (
        <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" title="WhatsApp desconectado" />
      )}
    </button>
  );
}
