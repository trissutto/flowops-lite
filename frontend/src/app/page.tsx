'use client';

/**
 * / — Home/Launchpad da matriz (v6 — ATELIER, preto & dourado minimalista).
 *
 * Brief: "mais sofisticado, fontes mais finas, botões menores com efeitos".
 *
 * Direção:
 *   - Fonte display: Cormorant Garamond 300 (fina e elegante)
 *   - Fonte UI: Inter 200/300 (thin / extralight)
 *   - Botões MÃE pequenos, dispostos em linha horizontal 4-col (não mais 2x2)
 *   - Cada card = strip minimal: ícone pequeno + título serif fino + subtítulo
 *     + arrow dourado que desliza no hover + underline animada
 *   - Hairlines douradas (opacity 0.12–0.25) em vez de borders sólidas
 *   - Muito espaço em branco. Preto profundo (#07070a).
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  LayoutDashboard, Boxes, TrendingUp, Settings, Zap, Bot, ArrowUpRight,
} from 'lucide-react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { isPilotOn, fetchPilotStatus, togglePilotServer, PilotStatus } from '@/lib/auto-send-order';

interface CountsResp {
  byStatus: Record<string, { name: string; total: number }>;
  grand: number;
}

type MotherButton = {
  href: string;
  label: string;
  subtitle: string;
  icon: typeof LayoutDashboard;
  kpiKey?: string;
};

const MOTHER_BUTTONS: MotherButton[] = [
  {
    href: '/separacao',
    label: 'Pedidos',
    subtitle: 'Separação e envio',
    icon: LayoutDashboard,
    kpiKey: 'processing',
  },
  {
    href: '/retaguarda',
    label: 'Retaguarda',
    subtitle: 'Baixas, ERP, site',
    icon: Boxes,
  },
  {
    href: '/gestao',
    label: 'Gestão',
    subtitle: 'Financeiro e CRM',
    icon: TrendingUp,
  },
  {
    href: '/sistema',
    label: 'Sistema',
    subtitle: 'Lojas e usuários',
    icon: Settings,
  },
];

const KPI_CARDS: Array<{ slug: string; label: string }> = [
  { slug: 'processing', label: 'Processando'   },
  { slug: 'separacao',  label: 'Em separação'  },
  { slug: 'pending',    label: 'Pgto pendente' },
  { slug: 'on-hold',    label: 'Aguardando'    },
];

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

  return (
    <div
      className="min-h-screen text-slate-200"
      style={{
        background:
          'radial-gradient(1200px 600px at 50% -10%, rgba(201,167,90,0.08), transparent 60%), #07070a',
      }}
    >
      {/* Ruído sutil — 2% opacity */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 opacity-[0.02]"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />

      {/* Header ---------- muito respiro ---------- */}
      <header className="relative max-w-6xl mx-auto px-6 sm:px-10 pt-16 sm:pt-20 pb-12 fade-up">
        <div className="flex items-start justify-between flex-wrap gap-8">
          <div>
            <div className="text-[10px] uppercase tracking-[0.4em] text-gold-gradient font-light mb-6">
              Lurds Order One
            </div>
            <h1 className="font-display text-6xl sm:text-7xl font-light text-white tracking-tight leading-[0.95]">
              {userName ? (
                <>
                  Bom te ver,
                  <br />
                  <span className="italic text-gold-gradient font-light">
                    {userName.split(' ')[0]}.
                  </span>
                </>
              ) : (
                <span className="italic text-gold-gradient font-light">Bem-vindo.</span>
              )}
            </h1>
            <div className="text-xs text-slate-500 mt-5 capitalize font-light tracking-[0.15em]">
              {today}
            </div>
          </div>

          {/* Piloto — versão mini e sofisticada */}
          <PilotPill
            pilot={pilot}
            busy={pilotBusy}
            status={pilotStatus}
            onToggle={togglePilot}
          />
        </div>
      </header>

      {/* Separador dourado fininho */}
      <div className="max-w-6xl mx-auto px-6 sm:px-10">
        <div className="divider-gold" />
      </div>

      {/* KPIs ---------- sem caixa, puramente tipográficos ---------- */}
      <section className="relative max-w-6xl mx-auto px-6 sm:px-10 py-10 fade-up" style={{ animationDelay: '0.1s' }}>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-x-2 gap-y-6">
          {KPI_CARDS.map((c) => (
            <KpiItem key={c.slug} label={c.label} value={counts[c.slug]?.total ?? 0} />
          ))}
          <KpiItem label="Enviados hoje" value={enviadosHoje} highlight />
        </div>
      </section>

      {/* Separador */}
      <div className="max-w-6xl mx-auto px-6 sm:px-10">
        <div className="divider-gold" />
      </div>

      {/* 4 botões MÃE ---------- linha horizontal, cards pequenos ---------- */}
      <section className="relative max-w-6xl mx-auto px-6 sm:px-10 py-14 fade-up" style={{ animationDelay: '0.2s' }}>
        <div className="flex items-center justify-between mb-8">
          <div className="text-[10px] uppercase tracking-[0.4em] text-slate-500 font-light">
            Acesso rápido
          </div>
          <div className="h-px flex-1 mx-6 bg-slate-800" />
          <div className="text-[10px] uppercase tracking-[0.4em] text-slate-500 font-light">
            04
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
          {MOTHER_BUTTONS.map((btn, idx) => (
            <MotherCard
              key={btn.href}
              btn={btn}
              kpi={btn.kpiKey ? counts[btn.kpiKey]?.total : undefined}
              index={idx}
            />
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="relative border-t border-slate-900 mt-8">
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-6 flex items-center justify-between text-[9px] text-slate-600 uppercase tracking-[0.4em] font-light">
          <span>Lurds · Plus Size</span>
          <span className="text-gold-gradient">Atelier v1</span>
        </div>
      </footer>
    </div>
  );
}

// ============================================================================
// Piloto Pill
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
      className="group relative flex items-center gap-3 py-2 px-1 transition disabled:opacity-40 disabled:cursor-not-allowed"
      title={
        status?.killSwitch
          ? 'Bloqueado via env PILOT_DISABLED=1 — só desbloqueia no servidor.'
          : pilot
          ? `Pedidos caem na loja sozinhos. WA: ${status?.whatsappConnected ? 'conectado' : 'DESCONECTADO ⚠️'}. Clique pra desligar.`
          : 'Envio manual. Clique pra ligar.'
      }
    >
      {/* Marcador vertical fino */}
      <span
        className={`h-10 w-px transition-all duration-500 ${
          pilot ? 'bg-gradient-to-b from-transparent via-[#c9a75a] to-transparent' : 'bg-slate-700'
        }`}
      />

      <span className="relative flex items-center justify-center w-7 h-7">
        {pilot ? (
          <Zap className="w-3.5 h-3.5" strokeWidth={1.5} style={{ color: '#c9a75a' }} />
        ) : (
          <Bot className="w-3.5 h-3.5 text-slate-500" strokeWidth={1.5} />
        )}
        {pilot && (
          <span
            className="absolute inset-0 rounded-full animate-ping opacity-30"
            style={{ boxShadow: 'inset 0 0 0 1px rgba(201,167,90,0.5)' }}
          />
        )}
      </span>

      <span className="text-left">
        <span className="block text-[9px] uppercase tracking-[0.3em] text-slate-500 font-light">
          Piloto {status?.killSwitch && '· bloqueado'}
        </span>
        <span
          className={`block text-xs tracking-wider underline-grow ${
            pilot ? 'text-gold-gradient font-medium' : 'text-slate-400 font-light'
          }`}
        >
          {busy ? '…' : pilot ? 'Ligado' : 'Desligado'}
        </span>
      </span>

      {pilot && status && !status.whatsappConnected && (
        <span
          className="w-1.5 h-1.5 rounded-full bg-amber-400"
          title="WhatsApp desconectado"
        />
      )}
    </button>
  );
}

// ============================================================================
// KPI Item — só tipografia, sem card
// ============================================================================
function KpiItem({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="group relative">
      <div className="text-[9px] uppercase tracking-[0.25em] text-slate-500 font-light mb-2">
        {label}
      </div>
      <div
        className={`font-display font-light tabular-nums leading-none text-4xl ${
          highlight ? 'text-gold-gradient' : 'text-white'
        }`}
      >
        {value.toLocaleString('pt-BR')}
      </div>
      {/* Linha dourada que aparece no hover */}
      <div className="mt-3 h-px w-8 bg-slate-800 group-hover:bg-[#c9a75a] transition-colors duration-500" />
    </div>
  );
}

// ============================================================================
// Mother Card — strip compacta com efeitos
// ============================================================================
function MotherCard({ btn, kpi, index }: { btn: MotherButton; kpi?: number; index: number }) {
  const Icon = btn.icon;
  return (
    <Link
      href={btn.href}
      className="group relative overflow-hidden rounded-xl p-6 flex flex-col justify-between min-h-[170px] transition-all duration-500 hover:-translate-y-0.5 gold-shine fade-up"
      style={{
        background:
          'linear-gradient(180deg, rgba(21,21,26,0.9) 0%, rgba(13,13,17,0.9) 100%)',
        border: '1px solid rgba(201,167,90,0.15)',
        animationDelay: `${0.3 + index * 0.08}s`,
      }}
    >
      {/* Hairline dourada que aparece na base no hover */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-px opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{
          background:
            'linear-gradient(90deg, transparent, #c9a75a, transparent)',
        }}
      />

      {/* Halo dourado muito sutil no canto */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-24 w-48 h-48 rounded-full blur-3xl opacity-0 group-hover:opacity-60 transition-opacity duration-700"
        style={{
          background:
            'radial-gradient(circle, rgba(201,167,90,0.25) 0%, transparent 70%)',
        }}
      />

      {/* Topo: ícone + KPI */}
      <div className="relative flex items-start justify-between">
        <Icon
          className="w-5 h-5 text-slate-400 group-hover:text-[#c9a75a] transition-colors duration-500"
          strokeWidth={1.25}
        />
        {kpi != null && kpi > 0 && (
          <span className="text-[9px] uppercase tracking-[0.2em] text-gold-gradient font-medium">
            {kpi.toLocaleString('pt-BR')} agora
          </span>
        )}
      </div>

      {/* Base: título fino serif + subtítulo + arrow */}
      <div className="relative">
        <div className="font-display text-3xl font-light text-white leading-none tracking-tight">
          {btn.label}
        </div>
        <div className="text-[11px] text-slate-500 mt-2 font-light tracking-wide">
          {btn.subtitle}
        </div>

        {/* Arrow que desliza da esquerda no hover — substitui o botão "ABRIR" */}
        <div className="mt-4 flex items-center gap-2 text-[10px] uppercase tracking-[0.3em] font-medium text-slate-500 group-hover:text-[#c9a75a] transition-colors duration-500">
          <span className="underline-grow">Abrir</span>
          <ArrowUpRight
            className="w-3 h-3 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-500"
            strokeWidth={1.5}
          />
        </div>
      </div>
    </Link>
  );
}
