'use client';

/**
 * NewOrderAlert — Popup global de "CHEGOU PEDIDO".
 *
 * DUAS fontes de detecção (redundantes, pra não perder):
 *  1. WebSocket `order:new` (instantâneo, vindo do backend)
 *  2. Polling HTTP de /orders/wc?status=processing a cada 30s (fallback)
 *
 * Quando dispara:
 *  - Banner AMARELO gigante no topo (animação entrada)
 *  - 3 beeps (WebAudio)
 *  - Atualiza <title> do browser
 *  - Dispara Notification do SO se permissão concedida
 *
 * Diagnóstico:
 *  - Logs detalhados no console (prefixo [NewOrderAlert])
 *  - `?testpopup=1` na URL força um popup de teste pra validar a UI
 *
 * Sempre ativo — plugado no layout.tsx raiz. Oculto em /login.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getSocket } from '@/lib/socket';
import { api } from '@/lib/api';
import { X, Bell, BellOff } from 'lucide-react';

interface IncomingOrder {
  id?: string | number;
  wcOrderNumber?: string | number;
  number?: string | number;
  customerName?: string | null;
  totalAmount?: number | string | null;
  total?: number | string | null;
  status?: string;
}

interface StackEntry {
  key: string;
  orderNumber: string;
  customerName: string;
  total: string;
  receivedAt: number;
  source: 'socket' | 'poll' | 'test';
}

const LOG = (...args: any[]) => console.log('[NewOrderAlert]', ...args);

export default function NewOrderAlert() {
  const pathname = usePathname();
  const [stack, setStack] = useState<StackEntry[]>([]);
  const [soundOn, setSoundOn] = useState(true);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const originalTitleRef = useRef<string>('');

  // Poll fallback state
  const knownWcIdsRef = useRef<Set<string>>(new Set());
  const isFirstPollRef = useRef(true);

  useEffect(() => {
    originalTitleRef.current = document.title || 'LURDS ORDER ONE';
    try {
      const pref = window.localStorage?.getItem('flowops.alertSoundOn');
      if (pref === '0') setSoundOn(false);
    } catch {}

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    // Liberar AudioContext no 1º clique do usuário (política autoplay)
    const unlock = () => {
      try {
        if (!audioCtxRef.current) {
          const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
          if (Ctx) audioCtxRef.current = new Ctx();
        }
        if (audioCtxRef.current?.state === 'suspended') {
          audioCtxRef.current.resume().catch(() => {});
        }
        LOG('AudioContext desbloqueado');
      } catch {}
      document.removeEventListener('click', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('click', unlock);
    document.addEventListener('keydown', unlock);

    // ?testpopup=1 → dispara um popup fake pra validar UI/som
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search);
      if (sp.get('testpopup')) {
        setTimeout(() => {
          LOG('Disparo de TESTE via ?testpopup=1');
          pushOrder({
            number: '9999',
            customerName: 'CLIENTE TESTE',
            total: '199.90',
          }, 'test');
        }, 500);
      }
    }

    return () => {
      document.removeEventListener('click', unlock);
      document.removeEventListener('keydown', unlock);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isLoginPage = pathname === '/login' || pathname?.startsWith('/login');
  const isStorePage = !!pathname?.startsWith('/minha-loja');

  // ───── WEBSOCKET ─────
  useEffect(() => {
    if (isLoginPage || isStorePage) return;
    const token =
      typeof window !== 'undefined' ? window.localStorage?.getItem('flowops_token') : null;
    if (!token) {
      LOG('Sem token, não conecta socket.');
      return;
    }

    const socket = getSocket();
    LOG('Conectando ao socket…', socket.connected ? 'já conectado' : 'pendente');

    const onConnect = () => LOG('✅ Socket CONECTADO', socket.id);
    const onDisconnect = (reason: string) => LOG('❌ Socket desconectado:', reason);
    const onError = (err: any) => LOG('⚠️ Erro de conexão:', err?.message || err);
    const onNew = (o: IncomingOrder) => {
      LOG('📦 Evento order:new recebido:', o);
      pushOrder(o, 'socket');
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onError);
    socket.on('order:new', onNew);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onError);
      socket.off('order:new', onNew);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoginPage, isStorePage]);

  // ───── POLLING FALLBACK ─────
  // Compara lista de pedidos em "processing" do WC a cada 30s.
  // Se apareceu ID que não estava antes → dispara popup.
  useEffect(() => {
    if (isLoginPage || isStorePage) return;
    const token =
      typeof window !== 'undefined' ? window.localStorage?.getItem('flowops_token') : null;
    if (!token) return;

    let stopped = false;

    async function check() {
      if (stopped) return;
      try {
        const res = await api<{ data: IncomingOrder[] }>(
          '/orders/wc?status=processing&per_page=20',
        );
        const incoming = res.data ?? [];
        const incomingIds = new Set(
          incoming.map((o) => String(o.id ?? o.number ?? '')).filter(Boolean),
        );

        if (isFirstPollRef.current) {
          knownWcIdsRef.current = incomingIds;
          isFirstPollRef.current = false;
          LOG(`Poll inicial: ${incomingIds.size} pedido(s) processing conhecidos.`);
          return;
        }

        const novos = incoming.filter(
          (o) => !knownWcIdsRef.current.has(String(o.id ?? o.number ?? '')),
        );
        if (novos.length > 0) {
          LOG(`🆕 Polling detectou ${novos.length} pedido(s) novo(s):`, novos);
          novos.forEach((o) => pushOrder(o, 'poll'));
        }
        knownWcIdsRef.current = incomingIds;
      } catch (e: any) {
        LOG('Polling falhou:', e?.message);
      }
    }

    // primeira chamada com delay pra não bater no login inicial
    const kickoff = setTimeout(check, 2000);
    const interval = setInterval(check, 30_000);
    return () => {
      stopped = true;
      clearTimeout(kickoff);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoginPage]);

  function pushOrder(o: IncomingOrder, source: 'socket' | 'poll' | 'test') {
    const num = String(o.wcOrderNumber ?? o.number ?? o.id ?? '—');
    const name = o.customerName ?? '—';
    const totalNum = Number(o.totalAmount ?? o.total ?? 0);
    const total = `R$ ${totalNum.toFixed(2).replace('.', ',')}`;
    const entry: StackEntry = {
      key: `${num}-${Date.now()}`,
      orderNumber: num,
      customerName: name,
      total,
      receivedAt: Date.now(),
      source,
    };

    setStack((prev) => {
      // dedup: mesmo número nos últimos 5s → ignora (socket + poll podem
      // detectar o mesmo pedido simultaneamente)
      const dup = prev.find(
        (x) => x.orderNumber === num && Date.now() - x.receivedAt < 5000,
      );
      if (dup) {
        LOG(`Duplicado ignorado (#${num} de ${dup.source} vs ${source})`);
        return prev;
      }
      const next = [...prev, entry];
      try {
        document.title = `🔔 ${next.length} novo(s) · ${originalTitleRef.current}`;
      } catch {}
      return next;
    });

    playBeep();
    fireDesktopNotification(num, name, total);
  }

  function toggleSound() {
    const next = !soundOn;
    setSoundOn(next);
    try {
      window.localStorage?.setItem('flowops.alertSoundOn', next ? '1' : '0');
    } catch {}
  }

  function playBeep() {
    if (!soundOn) return;
    try {
      if (!audioCtxRef.current) {
        const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctx) return;
        audioCtxRef.current = new Ctx();
      }
      const ctx = audioCtxRef.current!;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      [0, 0.18, 0.36].forEach((t) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0, ctx.currentTime + t);
        gain.gain.linearRampToValueAtTime(0.45, ctx.currentTime + t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.16);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + t);
        osc.stop(ctx.currentTime + t + 0.17);
      });
    } catch (e) {
      LOG('beep falhou:', e);
    }
  }

  function fireDesktopNotification(num: string, name: string, total: string) {
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(`🔔 CHEGOU PEDIDO #${num}`, {
          body: `${name} · ${total}`,
          tag: `flowops-order-${num}`,
          requireInteraction: false,
        });
      }
    } catch {}
  }

  function dismiss(key: string) {
    setStack((prev) => {
      const next = prev.filter((x) => x.key !== key);
      if (next.length === 0) {
        try { document.title = originalTitleRef.current; } catch {}
      } else {
        try { document.title = `🔔 ${next.length} novo(s) · ${originalTitleRef.current}`; } catch {}
      }
      return next;
    });
  }

  function dismissAll() {
    setStack([]);
    try { document.title = originalTitleRef.current; } catch {}
  }

  if (stack.length === 0) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] overflow-y-auto p-2 sm:p-4 pointer-events-none"
      aria-live="assertive"
      role="alert"
      style={{ WebkitOverflowScrolling: 'touch' }}
    >
      {/* Botao FECHAR FLUTUANTE — sempre visivel no canto, FORA do card,
          garante que da pra fechar mesmo se o conteudo for gigante */}
      <button
        onClick={dismissAll}
        className="pointer-events-auto fixed top-2 right-2 z-[10000] bg-red-600 hover:bg-red-700 text-white font-black rounded-full w-12 h-12 flex items-center justify-center shadow-2xl border-2 border-white text-2xl active:scale-95"
        aria-label="Fechar alerta"
        title="Fechar (Esc)"
      >
        ✕
      </button>

      <div className="pointer-events-auto max-w-2xl w-full mx-auto my-2 sm:my-4">
        <div
          key={stack[0].key}
          className="bg-yellow-400 border-4 border-yellow-600 rounded-xl shadow-2xl"
          style={{ animation: 'flowopsPopupIn 0.55s ease-out' }}
        >
          {/* HEADER */}
          <div className="p-3 sm:p-5 flex items-start gap-3 sm:gap-4">
            <div
              className="text-4xl sm:text-7xl leading-none flex-shrink-0"
              style={{ animation: 'flowopsWiggle 1s ease-in-out infinite' }}
            >
              ⚠️
            </div>
            <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
              <div className="text-lg sm:text-3xl font-black text-yellow-900 tracking-tight">
                CHEGOU {stack.length > 1 ? `${stack.length} PEDIDOS` : 'PEDIDO'}!
              </div>
              <button
                onClick={toggleSound}
                className="p-2 hover:bg-yellow-500 rounded-lg text-yellow-900 flex-shrink-0"
                title={soundOn ? 'Silenciar alerta' : 'Ativar som'}
              >
                {soundOn ? <Bell className="w-5 h-5" /> : <BellOff className="w-5 h-5" />}
              </button>
            </div>
          </div>

          {/* LISTA — sem max-h, deixa fluir, container externo rola */}
          <div className="px-3 sm:px-5 space-y-1.5">
            {stack.slice(0, 5).map((o) => (
              <div
                key={o.key}
                className="flex items-center justify-between gap-2 bg-yellow-300/60 rounded-lg px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="font-mono font-bold text-lg text-yellow-900">
                    #{o.orderNumber}
                    {o.source !== 'socket' && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide bg-yellow-900 text-yellow-100 rounded px-1.5 py-0.5">
                        {o.source === 'poll' ? 'poll' : 'teste'}
                      </span>
                    )}
                  </div>
                  <div className="text-yellow-900 text-sm truncate">
                    {o.customerName} · <span className="font-semibold">{o.total}</span>
                  </div>
                </div>
                <button
                  onClick={() => dismiss(o.key)}
                  className="text-yellow-900 hover:text-yellow-950 text-xs underline shrink-0"
                >
                  OK
                </button>
              </div>
            ))}
            {stack.length > 5 && (
              <div className="text-yellow-900 font-semibold text-sm pl-1">
                + {stack.length - 5} outro(s)
              </div>
            )}
          </div>

          {/* FOOTER — botoes empilhados em mobile, sempre dentro do fluxo */}
          <div className="p-3 sm:p-5 flex flex-col-reverse sm:flex-row gap-2 sm:justify-end border-t border-yellow-500/40 mt-2">
            <Link
              href="/separacao"
              onClick={dismissAll}
              className="px-4 py-3 bg-yellow-900 text-yellow-100 rounded-lg font-bold hover:bg-yellow-950 transition text-base text-center active:scale-95"
            >
              Abrir Separação →
            </Link>
            <button
              onClick={dismissAll}
              className="px-4 py-4 bg-yellow-100 text-yellow-900 rounded-lg font-black hover:bg-yellow-50 transition text-base border-2 border-yellow-700 active:scale-95"
            >
              ✓ OK, VI
            </button>
          </div>
        </div>
      </div>

      <style jsx global>{`
        @keyframes flowopsPopupIn {
          0%   { transform: translateY(-120%) scale(0.85); opacity: 0; }
          55%  { transform: translateY(0) scale(1.06); opacity: 1; }
          72%  { transform: translateY(0) scale(0.98) rotate(-1.5deg); }
          86%  { transform: translateY(0) scale(1.01) rotate(1deg); }
          100% { transform: translateY(0) scale(1) rotate(0); }
        }
        @keyframes flowopsWiggle {
          0%, 100% { transform: rotate(-8deg) scale(1); }
          25%      { transform: rotate(8deg)  scale(1.1); }
          50%      { transform: rotate(-5deg) scale(1);   }
          75%      { transform: rotate(5deg)  scale(1.05);}
        }
      `}</style>
    </div>
  );
}
