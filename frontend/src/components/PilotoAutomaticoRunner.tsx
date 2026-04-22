'use client';

/**
 * PilotoAutomaticoRunner — Roda em background no layout raiz.
 *
 * Se PILOTO AUTOMÁTICO tá LIGADO (flag `lurds_pilot_automatic_on`), qualquer
 * pedido novo detectado via socket `order:new` é AUTO-ENVIADO pra loja:
 *   1. Chama `autoSendOrderToStore(wcId, { noteSuffix: '[Piloto Automático]' })`
 *   2. Mostra um flash verde (ou vermelho em caso de erro) no topo direito
 *   3. Toca um beep diferente do alerta manual (pra user saber que automático agiu)
 *
 * Por que separado do NewOrderAlert:
 *   - NewOrderAlert sempre mostra popup (manual) — é o alerta humano.
 *   - PilotoAutomaticoRunner roda EM PARALELO e tenta mandar sozinho se flag on.
 *   - Se o auto-envio dá certo, o popup do NewOrderAlert ainda mostra que chegou
 *     pedido, mas aqui o user ganha um feedback ADICIONAL de que já foi enviado
 *     automaticamente.
 *
 * Proteções:
 *   - Deduplica por wcOrderId (evita duplo envio se socket + poll coincidir).
 *   - Skip'a `/whatsapp/status` em cada disparo pra acelerar — mas se o envio
 *     falhar por WA desconectado, mostra feedback pro user.
 *   - Só monta em usuários com token (não em /login, não em /minha-loja).
 */

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { CheckCircle2, AlertCircle, Zap, X } from 'lucide-react';
import { getSocket } from '@/lib/socket';
import { autoSendOrderToStore, isPilotOn } from '@/lib/auto-send-order';

interface AutoFlash {
  key: string;
  wcOrderId: number;
  wcOrderNumber: string;
  ok: boolean;
  message: string;
  storeSummary?: string;
}

export default function PilotoAutomaticoRunner() {
  const pathname = usePathname();
  const [flashes, setFlashes] = useState<AutoFlash[]>([]);
  const [pilot, setPilot] = useState(false);
  const sentRef = useRef<Set<number>>(new Set());

  const isLogin = pathname === '/login' || pathname?.startsWith('/login');
  const isStore = !!pathname?.startsWith('/minha-loja');

  // Sincroniza flag de Piloto Automático
  useEffect(() => {
    setPilot(isPilotOn());
    const onChange = (e: Event) => {
      const det = (e as CustomEvent).detail;
      setPilot(!!det?.on);
    };
    window.addEventListener('lurds:pilot-changed', onChange);
    return () => window.removeEventListener('lurds:pilot-changed', onChange);
  }, []);

  // Listener socket — só quando piloto tá on E tem sessão
  useEffect(() => {
    if (isLogin || isStore) return;
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) return;

    const socket = getSocket();
    const onOrder = async (o: any) => {
      if (!isPilotOn()) return; // re-check no momento do evento (flag pode ter mudado)

      const wcId = Number(o?.id ?? o?.wcOrderId);
      const wcNum = String(o?.wcOrderNumber ?? o?.number ?? o?.id ?? '—');
      if (!wcId || Number.isNaN(wcId)) return;

      // Dedup
      if (sentRef.current.has(wcId)) return;
      sentRef.current.add(wcId);

      playAutoBeep();

      const outcome = await autoSendOrderToStore(wcId, {
        skipWaStatusCheck: false,
        noteSuffix: '[Piloto Automático]',
      });

      if (outcome.ok) {
        const storeSummary = outcome.groups.map((g) => g.storeCode).join(', ');
        pushFlash({
          key: `ok-${wcId}-${Date.now()}`,
          wcOrderId: wcId,
          wcOrderNumber: wcNum,
          ok: true,
          message: `Enviado pra ${storeSummary}`,
          storeSummary,
        });
      } else {
        pushFlash({
          key: `err-${wcId}-${Date.now()}`,
          wcOrderId: wcId,
          wcOrderNumber: wcNum,
          ok: false,
          message: outcome.message,
        });
        // Deixa re-tentar manual: tira do dedup
        sentRef.current.delete(wcId);
      }
    };

    socket.on('order:new', onOrder);
    return () => {
      socket.off('order:new', onOrder);
    };
  }, [isLogin, isStore]);

  function pushFlash(f: AutoFlash) {
    setFlashes((prev) => [...prev, f]);
    // Auto-dismiss sucesso em 6s, erro em 15s (user precisa de tempo pra ler)
    const ttl = f.ok ? 6000 : 15000;
    setTimeout(() => dismiss(f.key), ttl);
  }

  function dismiss(key: string) {
    setFlashes((prev) => prev.filter((x) => x.key !== key));
  }

  function playAutoBeep() {
    // Beep duplo suave, diferente do alerta manual (que é 3 beeps agudos)
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      [0, 0.14].forEach((t, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = i === 0 ? 660 : 880;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0, ctx.currentTime + t);
        gain.gain.linearRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + t);
        osc.stop(ctx.currentTime + t + 0.13);
      });
    } catch {}
  }

  // Não renderiza nada se piloto off e não tem flashes pendentes
  if (!pilot && flashes.length === 0) return null;
  if (isLogin || isStore) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9998] flex flex-col gap-2 max-w-sm pointer-events-none">
      {flashes.map((f) => (
        <div
          key={f.key}
          className={`pointer-events-auto rounded-lg shadow-xl border-2 px-4 py-3 flex items-start gap-3 ${
            f.ok
              ? 'bg-emerald-50 border-emerald-500 text-emerald-900'
              : 'bg-red-50 border-red-500 text-red-900'
          }`}
          style={{ animation: 'lurdsSlideIn 0.35s ease-out' }}
        >
          <div className="shrink-0 mt-0.5">
            {f.ok ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-600" />
            ) : (
              <AlertCircle className="w-5 h-5 text-red-600" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-sm flex items-center gap-1">
              <Zap className="w-3.5 h-3.5" />
              {f.ok ? 'Auto-enviado' : 'Falha ao auto-enviar'}
              <span className="font-mono font-normal opacity-70">· #{f.wcOrderNumber}</span>
            </div>
            <div className="text-xs mt-0.5 break-words">{f.message}</div>
          </div>
          <button
            onClick={() => dismiss(f.key)}
            className="shrink-0 opacity-60 hover:opacity-100"
            title="Fechar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}

      <style jsx global>{`
        @keyframes lurdsSlideIn {
          0%   { transform: translateX(120%); opacity: 0; }
          100% { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
