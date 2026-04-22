'use client';

/**
 * / — Hub unificado de Operação.
 *
 * ANTES: 3 abas (Visão Geral · Pedidos · Separação) — virou redundante.
 * AGORA: tela ÚNICA. A "operação do dia" é a lista de Separação (1 clique envia
 * pra loja e dispara o WhatsApp). Em cima, uma faixa compacta mostra:
 *   - KPIs por status (Separação / Processando / Pgto pendente / Aguardando)
 *   - Toggle PILOTO AUTOMÁTICO — se ligado, pedidos NOVOS caem pra loja sozinhos
 *
 * O componente <PilotoAutomaticoRunner /> (montado no layout.tsx) é quem faz o
 * envio automático em si — essa página só renderiza o toggle.
 *
 * Responsabilidades do HUB:
 *  1. Redirect pra /login se não tem token, ou pra /minha-loja se role=store.
 *  2. Faixa KPI + toggle Piloto Automático.
 *  3. Renderiza <SeparacaoPage />. Pronto.
 *
 * Rotas antigas (/visao-geral, /pedidos, /separacao) seguem funcionando —
 * mas a "porta da frente" do operador virou essa.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Zap, Bot } from 'lucide-react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { isPilotOn, setPilotOn } from '@/lib/auto-send-order';
import SeparacaoPage from './separacao/page';

interface CountsResp {
  byStatus: Record<string, { name: string; total: number }>;
  grand: number;
}

const KPI_CARDS: Array<{ slug: string; label: string; color: string }> = [
  { slug: 'processing', label: 'Processando',    color: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  { slug: 'separacao',  label: 'Em separação',   color: 'bg-blue-50 text-blue-800 border-blue-200' },
  { slug: 'pending',    label: 'Pgto pendente',  color: 'bg-amber-50 text-amber-800 border-amber-200' },
  { slug: 'on-hold',    label: 'Aguardando',     color: 'bg-yellow-50 text-yellow-800 border-yellow-200' },
];

export default function OperacaoHub() {
  const router = useRouter();
  const [counts, setCounts] = useState<Record<string, { name: string; total: number }>>({});
  const [pilot, setPilot] = useState(false);

  // Guard de sessão + role
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    api<{ role: string }>('/auth/me')
      .then((me) => { if (me.role === 'store') router.push('/minha-loja'); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Estado do Piloto Automático — sincroniza via CustomEvent
  useEffect(() => {
    setPilot(isPilotOn());
    const onChange = (e: Event) => {
      const det = (e as CustomEvent).detail;
      setPilot(!!det?.on);
    };
    window.addEventListener('lurds:pilot-changed', onChange);
    return () => window.removeEventListener('lurds:pilot-changed', onChange);
  }, []);

  // KPIs — carrega + atualiza a cada 30s + on socket events
  useEffect(() => {
    let cancelled = false;

    async function loadCounts() {
      try {
        const cnt = await api<CountsResp>('/orders/wc/counts');
        if (!cancelled) setCounts(cnt.byStatus);
      } catch {}
    }

    loadCounts();
    const timer = setInterval(loadCounts, 30_000);

    const sock = getSocket();
    const onAny = () => loadCounts();
    sock.on('order:new', onAny);
    sock.on('order:status-changed', onAny);

    return () => {
      cancelled = true;
      clearInterval(timer);
      sock.off('order:new', onAny);
      sock.off('order:status-changed', onAny);
    };
  }, []);

  function togglePilot() {
    const next = !pilot;
    setPilotOn(next);
    setPilot(next);
  }

  return (
    <div>
      {/* Faixa compacta: KPIs + Piloto Automático — fica sticky logo abaixo do topnav */}
      <div className="bg-white border-b shadow-sm sticky top-14 z-30">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3 flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-2 flex-1">
            {KPI_CARDS.map((c) => (
              <div
                key={c.slug}
                className={`px-3 py-1.5 rounded-lg border text-sm font-semibold flex items-baseline gap-2 ${c.color}`}
                title={c.label}
              >
                <span className="text-lg leading-none">
                  {(counts[c.slug]?.total ?? 0).toLocaleString('pt-BR')}
                </span>
                <span className="text-xs font-medium opacity-80">{c.label}</span>
              </div>
            ))}
          </div>

          {/* Toggle Piloto Automático — grande e visível pra o user saber que tá ON */}
          <button
            onClick={togglePilot}
            className={`relative overflow-hidden rounded-xl px-4 py-2 text-sm font-bold flex items-center gap-2 transition shadow-md ring-2 ${
              pilot
                ? 'bg-gradient-to-br from-fuchsia-500 to-purple-600 text-white ring-fuchsia-300 ring-opacity-60 hover:from-fuchsia-600 hover:to-purple-700'
                : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50'
            }`}
            title={
              pilot
                ? 'PILOTO AUTOMÁTICO LIGADO — pedidos novos caem pra loja sozinhos (WhatsApp + status). Clique pra DESLIGAR.'
                : 'PILOTO AUTOMÁTICO DESLIGADO — você envia manual. Clique pra LIGAR.'
            }
          >
            {pilot ? <Zap className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
            <span className="leading-tight">
              <span className="block text-[10px] uppercase opacity-80 tracking-wider">Piloto automático</span>
              <span className="block text-sm">{pilot ? 'LIGADO' : 'DESLIGADO'}</span>
            </span>
            {pilot && (
              <span className="ml-1 w-2 h-2 rounded-full bg-green-300 animate-pulse" />
            )}
          </button>
        </div>
      </div>

      {/* Conteúdo: Separação é a operação do dia */}
      <SeparacaoPage />
    </div>
  );
}
