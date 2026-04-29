'use client';

/**
 * / — Home/Launchpad LURDS (v10 — 4 HUBS PRINCIPAIS · REORG-F2).
 *
 * Reorganizado em 4 grandes hubs por CONTEXTO DE USO:
 *
 *   1. SITE   — e-commerce (pedidos WC, marketing, publicar, vitrine, trocas).
 *   2. LOJA   — operação física + ERP (realinhamento exec, crediário receber,
 *               materiais, venda certa, juros crediário).
 *   3. GESTÃO — estratégico (dashboard, inteligência, financeiro, vendas
 *               vendedora, cobrança, clientes). Continua em URL /retaguarda
 *               por compatibilidade — só o LABEL mudou.
 *   4. CONFIG — setup técnico (lojas, usuários, NFC-e, pagamentos, WhatsApp).
 *
 * Filial (role=store) é redirecionada pro PDV automaticamente — esses 4 hubs
 * são só pra matriz.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Globe2, Store, Shield, Zap, Bot, BarChart3, Settings, type LucideIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { isPilotOn, fetchPilotStatus, togglePilotServer, PilotStatus } from '@/lib/auto-send-order';
import { TONE_MAP, type PastelTone } from '@/components/PastelShell';

interface CountsResp {
  byStatus: Record<string, { name: string; total: number }>;
  grand: number;
}

type Hub = {
  href: string;
  label: string;
  icon: LucideIcon;
  tone: PastelTone;
  subtitle: string;
  description: string;
};

// 4 HUBS principais — botões GIGANTES (REORG-F2)
const HUBS: Hub[] = [
  {
    href: '/site',
    label: 'Site',
    icon: Globe2,
    tone: 'sky',
    subtitle: 'E-commerce',
    description: 'Pedidos · Marketing · Vitrine · Trocas',
  },
  {
    href: '/loja',
    label: 'Loja',
    icon: Store,
    tone: 'peach',
    subtitle: 'Operação física',
    description: 'Estoque · Crediário · Materiais · Juros',
  },
  {
    href: '/retaguarda',
    label: 'Gestão',
    icon: BarChart3,
    tone: 'mint',
    subtitle: 'Estratégico',
    description: 'Dashboard · Inteligência · Financeiro · Cobrança',
  },
  {
    href: '/config',
    label: 'Config',
    icon: Settings,
    tone: 'lavender',
    subtitle: 'Setup técnico',
    description: 'Lojas · Usuários · NFC-e · Pagamentos · WhatsApp',
  },
];

export default function DashboardHome() {
  const router = useRouter();
  const [counts, setCounts] = useState<Record<string, { name: string; total: number }>>({});
  const [concluidosHoje, setConcluidosHoje] = useState<number>(0);
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
        // store sempre cai no PDV; admin/operator ficam no hub raiz
        if (me.role === 'store') router.push('/minha-loja/pdv');
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
      // Concluídos hoje: pedidos do WC com status=completed e modified_after=hoje 00:00
      try {
        const done = await api<{ total: number; since: string }>('/orders/wc/completed-today');
        if (!cancelled && done?.total != null) setConcluidosHoje(done.total);
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

        {/* KPIs ---------------------------------------------------------- */}
        <section
          className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-12 fade-up"
          style={{ animationDelay: '0.05s' }}
        >
          <MiniKpi label="Pendentes" value={totalPending} tone="rose" />
          <MiniKpi label="Processando" value={counts['processing']?.total ?? 0} tone="peach" />
          <MiniKpi label="Em separação" value={counts['separacao']?.total ?? 0} tone="lavender" />
          <MiniKpi label="Concluídos hoje" value={concluidosHoje} tone="mint" />
        </section>

        {/* 4 HUBS GIGANTES --------------------------------------------- */}
        <section
          className="panel-pastel p-6 sm:p-10 mb-6 fade-up"
          style={{ animationDelay: '0.1s' }}
        >
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 sm:gap-8 justify-items-center">
            {HUBS.map((hub, idx) => (
              <HubCircle key={hub.href} hub={hub} index={idx} />
            ))}
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-8 flex items-center justify-between text-xs text-slate-400">
          <span>Lurds · Plus Size</span>
          <span style={{ color: '#8b4f55' }} className="font-semibold">Launchpad v10</span>
        </footer>
      </div>
    </div>
  );
}

// ============================================================================
// HubCircle — botão circular GIGANTE pro hub principal
// ============================================================================
function HubCircle({ hub, index }: { hub: Hub; index: number }) {
  const Icon = hub.icon;
  const t = TONE_MAP[hub.tone];
  return (
    <Link
      href={hub.href}
      className="group flex flex-col items-center gap-4 fade-up"
      style={{ animationDelay: `${0.15 + index * 0.08}s` }}
    >
      <div className="relative">
        <div
          className="circle-ring flex items-center justify-center w-[150px] h-[150px] sm:w-[180px] sm:h-[180px] transition-transform duration-500 group-hover:scale-105"
          style={{
            border: `6px solid ${t.ring}`,
            background: t.bg,
            boxShadow: `0 14px 40px ${t.ring}40, 0 1px 0 rgba(255,255,255,0.95) inset`,
          }}
        >
          <Icon
            className="w-16 h-16 sm:w-20 sm:h-20 transition-transform duration-500 group-hover:scale-110"
            style={{ color: t.icon }}
            strokeWidth={1.4}
          />
        </div>
      </div>
      <div className="text-center max-w-[200px]">
        <div
          className="text-[10px] uppercase tracking-[0.3em] font-bold mb-1"
          style={{ color: t.text }}
        >
          {hub.subtitle}
        </div>
        <div className="font-display text-2xl sm:text-3xl text-slate-800 leading-tight">
          {hub.label}
        </div>
        <div className="text-xs text-slate-500 mt-1.5 leading-snug">
          {hub.description}
        </div>
      </div>
    </Link>
  );
}

// ============================================================================
// MiniKpi — pílula pastel pequena no topo
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
        background: pilot ? '#e3ebd9' : 'white',
        border: `2.5px solid ${pilot ? '#9caf88' : '#e2e8f0'}`,
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
        style={{ background: pilot ? '#5d7048' : '#f1f5f9' }}
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
        <div className="text-sm font-bold" style={{ color: pilot ? '#475636' : '#475569' }}>
          {busy ? '…' : pilot ? 'Ligado' : 'Desligado'}
        </div>
      </div>
      {pilot && status && !status.whatsappConnected && (
        <span
          className="w-2 h-2 rounded-full animate-pulse"
          style={{ background: '#c9a96e' }}
          title="WhatsApp desconectado"
        />
      )}
    </button>
  );
}
