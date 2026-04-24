'use client';

/**
 * / — Home/Launchpad da matriz (v4 — visual delicado).
 *
 * v3 era "shouty": gradientes saturados, shadows pesadas, shapes assimétricas,
 * tipografia black. Nada disso some agora — só ficou mais refinado:
 *   - Header claro (creme/off-white), tipografia serifada no saudar
 *   - KPIs com borda fininha + número tabular discreto
 *   - 4 cards MÃE em tom pastel (sky-50, amber-50, emerald-50, slate-100)
 *     com ícone em círculo colorido e typography peso médio
 *   - Piloto automático vira pill suave (em vez do botão berrante)
 *   - Hover com lift de 2px + ring colorido fino (sem scale agressivo)
 *
 * Mantém toda a lógica: guard de sessão, KPIs via polling + socket,
 * toggle do Piloto Automático server-side.
 *
 * Redireciona:
 *   - sem token → /login
 *   - role=store → /minha-loja (operador de filial tem UI dedicada)
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  LayoutDashboard, Boxes, TrendingUp, Settings, Zap, Bot, ArrowRight,
} from 'lucide-react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { isPilotOn, fetchPilotStatus, togglePilotServer, PilotStatus } from '@/lib/auto-send-order';

// ----------- Tipos dos fetches -----------
interface CountsResp {
  byStatus: Record<string, { name: string; total: number }>;
  grand: number;
}

// ----------- Botões MÃE (versão delicada) -----------
// Cada card usa bg pastel + accent color pro ícone/CTA. Sem gradiente saturado,
// sem shape assimétrico — só border-radius generoso (2xl) e ring suave no hover.
type MotherButton = {
  href: string;
  label: string;
  subtitle: string;
  icon: typeof LayoutDashboard;
  // Paleta: bg do card / cor do anel do ícone / cor do texto accent / ring hover
  bg: string;
  iconBg: string;
  iconColor: string;
  textAccent: string;
  hoverRing: string;
  kpiKey?: string;
};

const MOTHER_BUTTONS: MotherButton[] = [
  {
    href: '/separacao',
    label: 'Pedidos',
    subtitle: 'Separação, envio e impressão',
    icon: LayoutDashboard,
    bg: 'bg-sky-50/70',
    iconBg: 'bg-sky-100',
    iconColor: 'text-sky-600',
    textAccent: 'text-sky-900',
    hoverRing: 'hover:ring-sky-200',
    kpiKey: 'processing',
  },
  {
    href: '/retaguarda',
    label: 'Retaguarda',
    subtitle: 'Materiais, baixas, ERP e site',
    icon: Boxes,
    bg: 'bg-amber-50/70',
    iconBg: 'bg-amber-100',
    iconColor: 'text-amber-700',
    textAccent: 'text-amber-900',
    hoverRing: 'hover:ring-amber-200',
  },
  {
    href: '/gestao',
    label: 'Gestão',
    subtitle: 'Financeiro, produtos, CRM e marketing',
    icon: TrendingUp,
    bg: 'bg-emerald-50/70',
    iconBg: 'bg-emerald-100',
    iconColor: 'text-emerald-700',
    textAccent: 'text-emerald-900',
    hoverRing: 'hover:ring-emerald-200',
  },
  {
    href: '/sistema',
    label: 'Sistema',
    subtitle: 'Configurações, lojas e usuários',
    icon: Settings,
    bg: 'bg-slate-100/70',
    iconBg: 'bg-slate-200',
    iconColor: 'text-slate-700',
    textAccent: 'text-slate-900',
    hoverRing: 'hover:ring-slate-300',
  },
];

// KPI cards — paleta pastel, accent só num traço fino na esquerda
const KPI_CARDS: Array<{ slug: string; label: string; dot: string }> = [
  { slug: 'processing', label: 'Processando',   dot: 'bg-emerald-400' },
  { slug: 'separacao',  label: 'Em separação',  dot: 'bg-sky-400' },
  { slug: 'pending',    label: 'Pgto pendente', dot: 'bg-amber-400' },
  { slug: 'on-hold',    label: 'Aguardando',    dot: 'bg-yellow-400' },
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

  // Piloto Automático — flag server-side. Sincroniza no mount e a cada 30s.
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

  // KPIs — contadores por status + enviados hoje. Atualiza a cada 30s.
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
    <div className="min-h-screen bg-[#faf9f7]">
      {/* Header delicado — bg creme, sem gradiente escuro */}
      <div className="border-b border-slate-200/70 bg-white/60 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-8 pt-10 pb-8">
          <div className="flex items-start justify-between flex-wrap gap-6">
            <div>
              <div className="text-[10px] uppercase tracking-[0.25em] text-slate-400 mb-2 font-medium">
                Lurds Order One
              </div>
              <h1 className="text-3xl sm:text-4xl font-light text-slate-800 tracking-tight">
                {userName ? (
                  <>
                    Oi, <span className="font-medium text-slate-900">{userName.split(' ')[0]}</span>
                  </>
                ) : (
                  <span className="font-medium text-slate-900">Bem-vindo</span>
                )}
              </h1>
              <div className="text-sm text-slate-500 mt-2 capitalize font-light">{today}</div>
            </div>

            {/* Piloto automático — pill sutil em vez de botão berrante */}
            <button
              onClick={togglePilot}
              disabled={pilotBusy || pilotStatus?.killSwitch === true}
              className={`group relative rounded-full pl-3 pr-4 py-2 text-sm font-medium flex items-center gap-2.5 transition-all border disabled:opacity-50 disabled:cursor-not-allowed ${
                pilot
                  ? 'bg-white text-slate-800 border-slate-300 shadow-sm hover:shadow'
                  : 'bg-transparent text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-700'
              }`}
              title={
                pilotStatus?.killSwitch
                  ? 'Bloqueado via env PILOT_DISABLED=1 — só desbloqueia no servidor.'
                  : pilot
                  ? `Server-side. Pedidos novos caem na loja sozinhos. WA: ${pilotStatus?.whatsappConnected ? 'conectado' : 'DESCONECTADO ⚠️'}. Clique pra desligar.`
                  : 'Envio manual. Clique pra ligar (server-side).'
              }
            >
              {/* Indicador de estado — bolinha com pulso sutil */}
              <span className={`relative flex items-center justify-center w-6 h-6 rounded-full ${pilot ? 'bg-emerald-50' : 'bg-slate-100'}`}>
                {pilot ? <Zap className="w-3.5 h-3.5 text-emerald-600" /> : <Bot className="w-3.5 h-3.5 text-slate-400" />}
                {pilot && (
                  <span className="absolute inset-0 rounded-full ring-2 ring-emerald-200 animate-ping opacity-40" />
                )}
              </span>
              <span className="leading-tight text-left">
                <span className="block text-[9px] uppercase tracking-widest text-slate-400">
                  Piloto {pilotStatus?.killSwitch && '· bloqueado'}
                </span>
                <span className={`block text-xs font-semibold ${pilot ? 'text-emerald-700' : 'text-slate-500'}`}>
                  {pilotBusy ? '…' : pilot ? 'Ligado' : 'Desligado'}
                </span>
              </span>
              {pilot && pilotStatus && !pilotStatus.whatsappConnected && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-amber-400"
                  title="WhatsApp desconectado"
                />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* KPIs — delicados, com bolinha de cor em vez de border-left grossa */}
      <div className="max-w-6xl mx-auto px-4 sm:px-8 pt-8">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {KPI_CARDS.map((c) => (
            <div
              key={c.slug}
              className="bg-white rounded-xl border border-slate-200/70 px-4 py-3 hover:border-slate-300 transition"
            >
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                <div className="text-[11px] text-slate-500 font-medium tracking-wide">{c.label}</div>
              </div>
              <div className="text-2xl font-light text-slate-900 tabular-nums leading-none">
                {(counts[c.slug]?.total ?? 0).toLocaleString('pt-BR')}
              </div>
            </div>
          ))}
          <div className="bg-white rounded-xl border border-slate-200/70 px-4 py-3 hover:border-slate-300 transition">
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-pink-400" />
              <div className="text-[11px] text-slate-500 font-medium tracking-wide">Enviados hoje</div>
            </div>
            <div className="text-2xl font-light text-slate-900 tabular-nums leading-none">
              {enviadosHoje.toLocaleString('pt-BR')}
            </div>
          </div>
        </div>
      </div>

      {/* 4 cards MÃE — grid 2x2 em tons pastel */}
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-10 sm:py-14">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-5">
          {MOTHER_BUTTONS.map((btn) => (
            <MotherButtonCard
              key={btn.href}
              btn={btn}
              kpi={btn.kpiKey ? counts[btn.kpiKey]?.total : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function MotherButtonCard({ btn, kpi }: { btn: MotherButton; kpi?: number }) {
  const Icon = btn.icon;
  return (
    <Link
      href={btn.href}
      className={`group relative overflow-hidden ${btn.bg} rounded-3xl border border-slate-200/70 ring-1 ring-transparent ${btn.hoverRing} hover:-translate-y-0.5 hover:shadow-md transition-all duration-300 min-h-[180px] sm:min-h-[210px] flex flex-col justify-between p-6 sm:p-8`}
    >
      {/* Topo — ícone em círculo pastel + counter se houver */}
      <div className="flex items-start justify-between">
        <div className={`w-14 h-14 sm:w-16 sm:h-16 rounded-2xl ${btn.iconBg} flex items-center justify-center transition-transform duration-300 group-hover:scale-105`}>
          <Icon className={`w-7 h-7 sm:w-8 sm:h-8 ${btn.iconColor}`} strokeWidth={1.5} />
        </div>
        {kpi != null && kpi > 0 && (
          <div className={`text-xs font-medium ${btn.textAccent} bg-white/70 rounded-full px-3 py-1 tabular-nums border border-white`}>
            {kpi.toLocaleString('pt-BR')} agora
          </div>
        )}
      </div>

      {/* Base — nome + subtítulo + seta discreta */}
      <div className="mt-5">
        <div className={`text-2xl sm:text-3xl font-medium tracking-tight ${btn.textAccent}`}>
          {btn.label}
        </div>
        <div className="text-sm text-slate-600 mt-1.5 font-light">
          {btn.subtitle}
        </div>
        <div className={`mt-4 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider ${btn.textAccent} opacity-70 group-hover:opacity-100 transition`}>
          Abrir
          <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition" />
        </div>
      </div>
    </Link>
  );
}
