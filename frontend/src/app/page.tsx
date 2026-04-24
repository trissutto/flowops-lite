'use client';

/**
 * / — Home/Launchpad da matriz (v3 — 4 botões MÃE).
 *
 * MUDANÇA: antes a home jogava 15+ cards em 4 seções (Operação / Retaguarda /
 * Gestão / Sistema). Ficou visualmente pesado pra quem só quer chegar em um
 * módulo. Agora a home mostra APENAS 4 botões MÃE gigantes (PEDIDOS,
 * RETAGUARDA, GESTÃO, SISTEMA), cada um com uma forma geométrica diferente,
 * e cada um leva pra uma tela hub com os sub-módulos.
 *
 * Mantém:
 *   - Header de boas-vindas + Piloto Automático (é o switch mais crítico)
 *   - KPIs (Processando / Em separação / Pgto pendente / Aguardando / Enviados)
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

// ----------- Botões MÃE -----------
// Cada botão usa uma combinação diferente de border-radius pra criar a
// sensação de "formas variadas" sem sair do Tailwind. Combinado com blobs
// decorativos SVG internos o visual fica moderno e único por botão.
type MotherButton = {
  href: string;
  label: string;
  subtitle: string;
  icon: typeof LayoutDashboard;
  gradient: string;
  shape: string;      // classes tailwind de border-radius assimétrico
  blob: string;       // cor do blob decorativo interno
  kpiKey?: string;    // opcional — pra mostrar contador no card
};

const MOTHER_BUTTONS: MotherButton[] = [
  {
    href: '/separacao',
    label: 'PEDIDOS',
    subtitle: 'Separação · envio · impressão',
    icon: LayoutDashboard,
    gradient: 'from-sky-500 via-blue-600 to-indigo-700',
    shape: 'rounded-tl-[5rem] rounded-br-[5rem] rounded-tr-3xl rounded-bl-3xl',
    blob: 'bg-cyan-300/30',
    kpiKey: 'processing',
  },
  {
    href: '/retaguarda',
    label: 'RETAGUARDA',
    subtitle: 'Materiais · baixas · ERP · site',
    icon: Boxes,
    gradient: 'from-amber-500 via-orange-600 to-red-600',
    shape: 'rounded-tr-[5rem] rounded-bl-[5rem] rounded-tl-3xl rounded-br-3xl',
    blob: 'bg-yellow-300/30',
  },
  {
    href: '/gestao',
    label: 'GESTÃO',
    subtitle: 'Financeiro · produtos · CRM · marketing',
    icon: TrendingUp,
    gradient: 'from-emerald-500 via-teal-600 to-cyan-700',
    shape: 'rounded-bl-[5rem] rounded-tr-[5rem] rounded-br-3xl rounded-tl-3xl',
    blob: 'bg-lime-300/30',
  },
  {
    href: '/sistema',
    label: 'SISTEMA',
    subtitle: 'Configurações · lojas · usuários',
    icon: Settings,
    gradient: 'from-slate-700 via-slate-800 to-slate-950',
    shape: 'rounded-br-[5rem] rounded-tl-[5rem] rounded-bl-3xl rounded-tr-3xl',
    blob: 'bg-fuchsia-400/20',
  },
];

// KPI cards visíveis no topo
const KPI_CARDS: Array<{ slug: string; label: string; color: string }> = [
  { slug: 'processing', label: 'Processando',    color: 'border-emerald-500' },
  { slug: 'separacao',  label: 'Em separação',   color: 'border-blue-500' },
  { slug: 'pending',    label: 'Pgto pendente',  color: 'border-amber-500' },
  { slug: 'on-hold',    label: 'Aguardando',     color: 'border-yellow-500' },
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

  // KPIs — contadores por status + enviados hoje (total). Atualiza a cada 30s.
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
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-slate-100 to-slate-50">
      {/* Header */}
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-6 pb-10">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <div className="text-xs uppercase tracking-widest text-slate-400 mb-1">Lurds Order One</div>
              <h1 className="text-2xl sm:text-3xl font-bold">
                {userName ? `Oi, ${userName.split(' ')[0]}` : 'Bem-vindo'} 👋
              </h1>
              <div className="text-sm text-slate-300 mt-1 capitalize">{today}</div>
            </div>
            <button
              onClick={togglePilot}
              disabled={pilotBusy || pilotStatus?.killSwitch === true}
              className={`relative rounded-xl px-4 py-2.5 text-sm font-bold flex items-center gap-2 transition shadow-lg ring-2 disabled:opacity-50 disabled:cursor-not-allowed ${
                pilot
                  ? 'bg-gradient-to-br from-fuchsia-500 to-purple-600 text-white ring-fuchsia-300/60 hover:from-fuchsia-600 hover:to-purple-700'
                  : 'bg-white/10 text-white ring-white/20 hover:bg-white/15'
              }`}
              title={
                pilotStatus?.killSwitch
                  ? 'Bloqueado via env PILOT_DISABLED=1 — só desbloqueia no servidor.'
                  : pilot
                  ? `Server-side. Pedidos novos caem na loja sozinhos. WA: ${pilotStatus?.whatsappConnected ? 'conectado' : 'DESCONECTADO ⚠️'}. Clique pra desligar.`
                  : 'Envio manual. Clique pra ligar (server-side).'
              }
            >
              {pilot ? <Zap className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
              <span className="leading-tight text-left">
                <span className="block text-[10px] uppercase opacity-80 tracking-wider">
                  Piloto automático {pilotStatus?.killSwitch && '· BLOQUEADO'}
                </span>
                <span className="block text-sm">
                  {pilotBusy ? '...' : pilot ? 'LIGADO' : 'DESLIGADO'}
                </span>
              </span>
              {pilot && pilotStatus?.whatsappConnected && (
                <span className="ml-1 w-2 h-2 rounded-full bg-green-300 animate-pulse" title="WhatsApp conectado" />
              )}
              {pilot && pilotStatus && !pilotStatus.whatsappConnected && (
                <span className="ml-1 w-2 h-2 rounded-full bg-amber-400 animate-pulse" title="WhatsApp desconectado" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* KPIs flutuantes */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 -mt-6 relative">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 sm:gap-3">
          {KPI_CARDS.map((c) => (
            <div
              key={c.slug}
              className={`bg-white rounded-xl shadow-md border-l-4 ${c.color} px-3 py-2.5`}
            >
              <div className="text-[11px] sm:text-xs text-slate-500 leading-none mb-1">{c.label}</div>
              <div className="text-xl sm:text-2xl font-bold text-slate-900 leading-tight tabular-nums">
                {(counts[c.slug]?.total ?? 0).toLocaleString('pt-BR')}
              </div>
            </div>
          ))}
          <div className="bg-white rounded-xl shadow-md border-l-4 border-pink-500 px-3 py-2.5">
            <div className="text-[11px] sm:text-xs text-slate-500 leading-none mb-1 flex items-center gap-1">
              <TrendingUp className="w-3 h-3" /> Enviados hoje
            </div>
            <div className="text-xl sm:text-2xl font-bold text-slate-900 leading-tight tabular-nums">
              {enviadosHoje.toLocaleString('pt-BR')}
            </div>
          </div>
        </div>
      </div>

      {/* 4 BOTÕES MÃE — grid 2x2 gigante */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
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
      className={`group relative overflow-hidden bg-gradient-to-br ${btn.gradient} ${btn.shape} text-white shadow-2xl hover:shadow-[0_25px_60px_-15px_rgba(0,0,0,0.45)] hover:scale-[1.02] transition-all duration-300 min-h-[220px] sm:min-h-[280px] flex flex-col justify-between p-7 sm:p-10`}
    >
      {/* Blobs decorativos pra criar profundidade e diferenciar cada shape */}
      <div className={`absolute -top-24 -right-24 w-72 h-72 rounded-full ${btn.blob} blur-3xl pointer-events-none`} />
      <div className={`absolute -bottom-32 -left-20 w-80 h-80 rounded-full ${btn.blob} blur-3xl pointer-events-none opacity-60`} />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,white_0%,transparent_70%)] opacity-5 pointer-events-none" />

      {/* Top — ícone gigante */}
      <div className="relative flex items-start justify-between">
        <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-3xl bg-white/15 backdrop-blur-md ring-1 ring-white/25 flex items-center justify-center shadow-xl group-hover:scale-110 group-hover:rotate-3 transition-transform duration-300">
          <Icon className="w-10 h-10 sm:w-12 sm:h-12 drop-shadow-lg" />
        </div>
        {kpi != null && kpi > 0 && (
          <div className="bg-white/25 backdrop-blur-md ring-1 ring-white/30 rounded-full px-4 py-1.5 text-sm font-black tabular-nums shadow-lg">
            {kpi.toLocaleString('pt-BR')} agora
          </div>
        )}
      </div>

      {/* Bottom — nome enorme + subtítulo + CTA */}
      <div className="relative mt-6">
        <div className="text-4xl sm:text-6xl font-black tracking-tight leading-none drop-shadow-md">
          {btn.label}
        </div>
        <div className="text-sm sm:text-base opacity-90 mt-3 font-medium">
          {btn.subtitle}
        </div>
        <div className="mt-5 inline-flex items-center gap-2 bg-white text-slate-900 font-black text-sm px-5 py-2.5 rounded-2xl shadow-xl group-hover:shadow-2xl group-hover:-translate-y-1 transition">
          ABRIR
          <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition" />
        </div>
      </div>
    </Link>
  );
}
