'use client';

/**
 * / — Hub de Operação (Visão Geral + Pedidos + Separação).
 *
 * Antes essas 3 telas viviam como links separados no TopNav. Agora ficam
 * unificadas em /?tab=visao-geral|pedidos|separacao. Cada aba renderiza o
 * componente default da tela original (sem refatoração).
 *
 * URLs antigas (/visao-geral, /pedidos, /separacao) continuam funcionando —
 * só o ponto de entrada padrão virou este hub.
 *
 * Responsabilidades do HUB (não das abas):
 *  1. Redirect pra /login se não tem token, ou pra /minha-loja se role=store.
 *  2. Socket listener GLOBAL de order:new → dispara alerta sonoro + Notification
 *     desktop. Fica aqui pra tocar em qualquer aba ativa (se ficasse só na
 *     Visão Geral, perdia o alerta quando o user estivesse em Pedidos/Separação).
 *
 * As abas continuam fazendo seu próprio fetch e auto-refresh.
 */

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { LayoutDashboard, ListOrdered, Truck, Bell } from 'lucide-react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';

// Reaproveita os componentes default das telas existentes.
import VisaoGeralPage from './visao-geral/page';
import PedidosPage from './pedidos/page';
import SeparacaoPage from './separacao/page';

type TabKey = 'visao-geral' | 'pedidos' | 'separacao';

const TABS: {
  key: TabKey;
  label: string;
  subtitle: string;
  icon: typeof LayoutDashboard;
  gradient: string;     // cor do botão quando ATIVO (gradiente cheio)
  activeRing: string;   // cor do ring/glow do ativo
}[] = [
  {
    key: 'visao-geral',
    label: 'Visão Geral',
    subtitle: 'KPIs e últimos pedidos',
    icon: LayoutDashboard,
    gradient: 'from-sky-500 to-blue-600',
    activeRing: 'ring-blue-300',
  },
  {
    key: 'pedidos',
    label: 'Pedidos',
    subtitle: 'Lista + filtros WooCommerce',
    icon: ListOrdered,
    gradient: 'from-violet-500 to-purple-600',
    activeRing: 'ring-purple-300',
  },
  {
    key: 'separacao',
    label: 'Separação',
    subtitle: 'Enviar pedido pra loja',
    icon: Truck,
    gradient: 'from-emerald-500 to-teal-600',
    activeRing: 'ring-emerald-300',
  },
];

function OperacaoHubInner() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const raw = params?.get('tab') ?? 'visao-geral';
  const active: TabKey = useMemo(() => {
    return (TABS.find((t) => t.key === raw)?.key ?? 'visao-geral') as TabKey;
  }, [raw]);

  const [flash, setFlash] = useState<string | null>(null);

  // Guard + listener global (ver header do arquivo)
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    api<{ role: string }>('/auth/me')
      .then((me) => { if (me.role === 'store') router.push('/minha-loja'); })
      .catch(() => {});

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    const socket = getSocket();
    const onNewOrder = (o: any) => {
      setFlash(`Novo pedido: #${o.wcOrderNumber ?? o.number}`);
      playAlert();
      notifyDesktop(o);
      setTimeout(() => setFlash(null), 4000);
    };
    socket.on('order:new', onNewOrder);

    return () => {
      socket.off('order:new', onNewOrder);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function go(tab: TabKey) {
    const qs = new URLSearchParams(params?.toString() ?? '');
    qs.set('tab', tab);
    router.replace(`${pathname}?${qs.toString()}`);
  }

  function playAlert() {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.start(); osc.stop(ctx.currentTime + 0.5);
    } catch {}
  }

  function notifyDesktop(o: any) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const num = o.wcOrderNumber ?? o.number ?? o.id;
      const total = o.totalAmount ?? o.total ?? 0;
      const n = new Notification('🛍 Novo pedido LURDS', {
        body: `#${num} — ${o.customerName}\nR$ ${Number(total || 0).toFixed(2)}`,
        tag: `order-${o.id}`,
        requireInteraction: true,
      });
      n.onclick = () => {
        window.focus();
        window.location.href = `/?tab=pedidos`;
        n.close();
      };
    } catch {}
  }

  return (
    <div>
      {flash && (
        <div className="bg-green-500 text-white px-6 py-3 flex items-center gap-3 animate-pulse">
          <Bell className="w-5 h-5" />
          <span className="font-medium">{flash}</span>
        </div>
      )}

      {/* Botões de navegação — estilo cards coloridos, não abas sublinhadas */}
      <div className="bg-white border-b shadow-sm sticky top-[72px] z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4">
          <div className="grid grid-cols-3 gap-3">
            {TABS.map((t) => {
              const Icon = t.icon;
              const isActive = active === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => go(t.key)}
                  className={
                    isActive
                      ? `group relative overflow-hidden rounded-xl bg-gradient-to-br ${t.gradient} p-4 text-white shadow-lg ring-4 ${t.activeRing} ring-opacity-40 scale-[1.02] transition-all text-left`
                      : `group relative overflow-hidden rounded-xl bg-slate-50 hover:bg-white border-2 border-slate-200 hover:border-slate-300 p-4 text-slate-700 hover:shadow-md transition-all text-left`
                  }
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-11 h-11 rounded-lg flex items-center justify-center shrink-0 transition ${
                        isActive
                          ? 'bg-white/25 backdrop-blur'
                          : `bg-gradient-to-br ${t.gradient} text-white`
                      }`}
                    >
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={`font-bold text-base leading-tight ${isActive ? '' : 'text-slate-900'}`}>
                        {t.label}
                      </div>
                      <div className={`text-xs leading-snug mt-0.5 line-clamp-1 ${isActive ? 'opacity-90' : 'text-slate-500'}`}>
                        {t.subtitle}
                      </div>
                    </div>
                  </div>
                  {isActive && (
                    <div className="absolute -bottom-6 -right-6 w-20 h-20 rounded-full bg-white/15 blur-xl" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Conteúdo da aba */}
      <div>
        {active === 'visao-geral' && <VisaoGeralPage />}
        {active === 'pedidos'     && <PedidosPage />}
        {active === 'separacao'   && <SeparacaoPage />}
      </div>
    </div>
  );
}

export default function OperacaoHub() {
  return (
    <Suspense fallback={<div className="p-8 text-slate-400">Carregando…</div>}>
      <OperacaoHubInner />
    </Suspense>
  );
}
