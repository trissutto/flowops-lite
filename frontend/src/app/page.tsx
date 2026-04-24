'use client';

/**
 * / — Home/Launchpad da matriz (v5 — PREMIUM preto & dourado).
 *
 * Troca do visual pastel pra preto/dourado com tipografia serif (Playfair
 * Display). Referência: boutique de luxo / hotel 5★. Ideia:
 *   - Fundo preto carvão (#0b0b0d) com textura noise sutil
 *   - Linhas douradas fininhas (rgba gold 0.35) delimitando seções
 *   - Títulos em serif (Playfair) com pesos 400-500
 *   - Números em Inter tabular-nums
 *   - CTAs com gradiente dourado brilhante
 *   - Cards MÃE em glass escuro com shine dourado diagonal no hover
 *
 * Mantém toda a lógica: guard de sessão, KPIs via polling + socket,
 * toggle do Piloto Automático server-side.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  LayoutDashboard, Boxes, TrendingUp, Settings, Zap, Bot, ArrowRight, Sparkles,
} from 'lucide-react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { isPilotOn, fetchPilotStatus, togglePilotServer, PilotStatus } from '@/lib/auto-send-order';

interface CountsResp {
  byStatus: Record<string, { name: string; total: number }>;
  grand: number;
}

// ----------- Botões MÃE (versão premium) -----------
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
    subtitle: 'Separação · envio · impressão',
    icon: LayoutDashboard,
    kpiKey: 'processing',
  },
  {
    href: '/retaguarda',
    label: 'Retaguarda',
    subtitle: 'Materiais · baixas · ERP · site',
    icon: Boxes,
  },
  {
    href: '/gestao',
    label: 'Gestão',
    subtitle: 'Financeiro · produtos · CRM · marketing',
    icon: TrendingUp,
  },
  {
    href: '/sistema',
    label: 'Sistema',
    subtitle: 'Configurações · lojas · usuários',
    icon: Settings,
  },
];

// KPI cards — dourado sutil em cima da cor de tema
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

  // Piloto Automático — flag server-side.
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
    <div
      className="min-h-screen text-slate-100"
      style={{
        background:
          'radial-gradient(ellipse at top, #1c1c22 0%, #0b0b0d 55%, #000 100%)',
      }}
    >
      {/* Ruído sutil (overlay SVG data-uri) + vinheta dourada no topo */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 opacity-[0.035]"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 h-96"
        style={{
          background:
            'radial-gradient(ellipse at center top, rgba(201,150,45,0.12), transparent 70%)',
        }}
      />

      {/* Header — headline serif, pill dourada pra piloto */}
      <div className="relative border-b border-gold-hairline">
        <div className="max-w-6xl mx-auto px-4 sm:px-8 pt-12 pb-10">
          <div className="flex items-start justify-between flex-wrap gap-6">
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="w-3.5 h-3.5 text-gold-400" style={{ color: '#d4a84a' }} />
                <div className="text-[10px] uppercase tracking-[0.35em] text-gold-gradient font-medium">
                  Lurds Order One
                </div>
              </div>
              <h1 className="font-display text-5xl sm:text-6xl font-normal text-white tracking-tight leading-none">
                {userName ? (
                  <>
                    Oi,{' '}
                    <span className="italic text-gold-gradient">
                      {userName.split(' ')[0]}
                    </span>
                  </>
                ) : (
                  <span className="italic text-gold-gradient">Bem-vindo</span>
                )}
              </h1>
              <div className="text-sm text-slate-400 mt-4 capitalize font-light tracking-wide">
                {today}
              </div>
            </div>

            {/* Piloto automático — pill dourada premium */}
            <button
              onClick={togglePilot}
              disabled={pilotBusy || pilotStatus?.killSwitch === true}
              className={`group relative rounded-full pl-2.5 pr-5 py-2.5 text-sm flex items-center gap-3 transition-all border disabled:opacity-50 disabled:cursor-not-allowed ${
                pilot
                  ? 'border-transparent shadow-[0_0_24px_rgba(201,150,45,0.25)]'
                  : 'bg-black/30 text-slate-300 border-slate-700 hover:border-slate-500'
              }`}
              style={
                pilot
                  ? {
                      background:
                        'linear-gradient(135deg, rgba(201,150,45,0.18) 0%, rgba(20,20,24,0.6) 100%)',
                      borderColor: 'rgba(201,150,45,0.55)',
                    }
                  : undefined
              }
              title={
                pilotStatus?.killSwitch
                  ? 'Bloqueado via env PILOT_DISABLED=1 — só desbloqueia no servidor.'
                  : pilot
                  ? `Server-side. Pedidos novos caem na loja sozinhos. WA: ${pilotStatus?.whatsappConnected ? 'conectado' : 'DESCONECTADO ⚠️'}. Clique pra desligar.`
                  : 'Envio manual. Clique pra ligar (server-side).'
              }
            >
              <span
                className={`relative flex items-center justify-center w-8 h-8 rounded-full ${
                  pilot ? '' : 'bg-slate-800'
                }`}
                style={
                  pilot
                    ? {
                        background:
                          'linear-gradient(135deg, #f3d989 0%, #c9962d 100%)',
                      }
                    : undefined
                }
              >
                {pilot ? (
                  <Zap className="w-4 h-4 text-slate-900" strokeWidth={2.5} />
                ) : (
                  <Bot className="w-4 h-4 text-slate-500" strokeWidth={1.8} />
                )}
                {pilot && (
                  <span
                    className="absolute inset-0 rounded-full animate-ping opacity-30"
                    style={{ boxShadow: '0 0 0 2px rgba(243,217,137,0.6)' }}
                  />
                )}
              </span>
              <span className="leading-tight text-left">
                <span className="block text-[9px] uppercase tracking-[0.2em] text-slate-400 font-medium">
                  Piloto {pilotStatus?.killSwitch && '· bloqueado'}
                </span>
                <span
                  className={`block text-xs font-semibold ${
                    pilot ? 'text-gold-gradient' : 'text-slate-400'
                  }`}
                >
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

      {/* KPIs — cards glass escuro com borda dourada fininha */}
      <div className="relative max-w-6xl mx-auto px-4 sm:px-8 pt-10">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {KPI_CARDS.map((c) => (
            <div
              key={c.slug}
              className="relative rounded-xl px-4 py-3.5 backdrop-blur-sm hover:border-gold-hairline transition-all"
              style={{
                background:
                  'linear-gradient(180deg, rgba(28,28,34,0.7) 0%, rgba(11,11,13,0.7) 100%)',
                border: '1px solid rgba(201,150,45,0.18)',
              }}
            >
              <div className="flex items-center gap-1.5 mb-2">
                <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                <div className="text-[10px] text-slate-400 font-medium uppercase tracking-[0.12em]">
                  {c.label}
                </div>
              </div>
              <div className="font-display text-3xl font-normal text-white tabular-nums leading-none">
                {(counts[c.slug]?.total ?? 0).toLocaleString('pt-BR')}
              </div>
            </div>
          ))}
          <div
            className="relative rounded-xl px-4 py-3.5 backdrop-blur-sm hover:border-gold-hairline transition-all"
            style={{
              background:
                'linear-gradient(180deg, rgba(28,28,34,0.7) 0%, rgba(11,11,13,0.7) 100%)',
              border: '1px solid rgba(201,150,45,0.18)',
            }}
          >
            <div className="flex items-center gap-1.5 mb-2">
              <span className="w-1.5 h-1.5 rounded-full bg-pink-400" />
              <div className="text-[10px] text-slate-400 font-medium uppercase tracking-[0.12em]">
                Enviados hoje
              </div>
            </div>
            <div className="font-display text-3xl font-normal text-gold-gradient tabular-nums leading-none">
              {enviadosHoje.toLocaleString('pt-BR')}
            </div>
          </div>
        </div>
      </div>

      {/* 4 cards MÃE — grid 2x2 premium */}
      <div className="relative max-w-6xl mx-auto px-4 sm:px-8 py-12 sm:py-16">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 sm:gap-6">
          {MOTHER_BUTTONS.map((btn) => (
            <MotherButtonCard
              key={btn.href}
              btn={btn}
              kpi={btn.kpiKey ? counts[btn.kpiKey]?.total : undefined}
            />
          ))}
        </div>
      </div>

      {/* Footer sutil */}
      <div className="relative border-t border-gold-hairline mt-8">
        <div className="max-w-6xl mx-auto px-4 sm:px-8 py-5 flex items-center justify-between text-[10px] text-slate-500 uppercase tracking-[0.3em]">
          <span>Lurds · Plus Size</span>
          <span className="text-gold-gradient">v1</span>
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
      className="group relative overflow-hidden rounded-2xl p-7 sm:p-9 min-h-[220px] flex flex-col justify-between transition-all duration-500 hover:-translate-y-1 gold-shine"
      style={{
        background:
          'linear-gradient(145deg, rgba(28,28,34,0.95) 0%, rgba(11,11,13,0.95) 100%)',
        border: '1px solid rgba(201,150,45,0.25)',
        boxShadow:
          'inset 0 1px 0 0 rgba(243,217,137,0.08), 0 8px 40px rgba(0,0,0,0.45)',
      }}
    >
      {/* Glow dourado no canto superior direito, intensifica no hover */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-20 -right-20 w-60 h-60 rounded-full blur-3xl opacity-40 group-hover:opacity-70 transition-opacity duration-500"
        style={{
          background:
            'radial-gradient(circle, rgba(201,150,45,0.35) 0%, transparent 70%)',
        }}
      />
      {/* Linha dourada fina no topo do card */}
      <div
        aria-hidden
        className="absolute inset-x-8 top-0 h-px"
        style={{
          background:
            'linear-gradient(90deg, transparent, rgba(201,150,45,0.6), transparent)',
        }}
      />

      {/* Topo — ícone em moldura dourada + counter */}
      <div className="relative flex items-start justify-between">
        <div
          className="w-16 h-16 rounded-xl flex items-center justify-center transition-all duration-500 group-hover:scale-105"
          style={{
            background:
              'linear-gradient(135deg, rgba(201,150,45,0.15) 0%, rgba(20,20,24,0.6) 100%)',
            border: '1px solid rgba(201,150,45,0.35)',
          }}
        >
          <Icon className="w-7 h-7" strokeWidth={1.5} style={{ color: '#d4a84a' }} />
        </div>
        {kpi != null && kpi > 0 && (
          <div
            className="text-[11px] font-semibold tabular-nums rounded-full px-3 py-1.5 text-gold-gradient uppercase tracking-wider"
            style={{
              background: 'rgba(201,150,45,0.08)',
              border: '1px solid rgba(201,150,45,0.35)',
            }}
          >
            {kpi.toLocaleString('pt-BR')} agora
          </div>
        )}
      </div>

      {/* Base — nome em serif + subtítulo + CTA dourada */}
      <div className="relative mt-6">
        <div className="font-display text-4xl sm:text-5xl font-normal tracking-tight text-white leading-none">
          {btn.label}
        </div>
        <div className="text-sm text-slate-400 mt-3 font-light tracking-wide">
          {btn.subtitle}
        </div>

        <div className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-xs font-bold uppercase tracking-[0.2em] text-slate-900 shadow-lg transition-all group-hover:shadow-[0_8px_24px_rgba(201,150,45,0.35)] group-hover:-translate-y-0.5"
          style={{
            background:
              'linear-gradient(135deg, #f3d989 0%, #d4a84a 50%, #a77a1c 100%)',
          }}
        >
          Abrir
          <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition" />
        </div>
      </div>
    </Link>
  );
}
