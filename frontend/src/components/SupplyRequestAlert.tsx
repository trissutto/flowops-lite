'use client';

/**
 * SupplyRequestAlert — sino/toast global de "novo pedido de materiais".
 *
 * Avisa a RETAGUARDA (admin/operator) toda vez que uma filial cria um pedido
 * no módulo Materiais/Inbox. Fonte: WebSocket `supplies:new-request` (sala
 * 'admin'). Mostra um toast discreto no canto (empilha), 2 beeps e uma
 * Notification do SO. Some sozinho em 12s ou no clique. Push (app fechado)
 * vem pelo backend (PushService.sendToAdmins).
 *
 * Montado no layout raiz, ao lado do NewOrderAlert. Oculto em /login e pra
 * usuário de loja (role=store).
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getSocket } from '@/lib/socket';
import { Package, X } from 'lucide-react';

interface Incoming {
  id?: string;
  storeCode?: string | null;
  storeName?: string | null;
  itens?: number;
  note?: string | null;
}
interface Entry { key: string; loja: string; itens: number; note: string | null; at: number; }

export default function SupplyRequestAlert() {
  const pathname = usePathname();
  const [stack, setStack] = useState<Entry[]>([]);
  const audioRef = useRef<AudioContext | null>(null);

  const isLogin = pathname === '/login' || pathname?.startsWith('/login');

  // role do JWT — só retaguarda (admin/operator) recebe.
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    try {
      const token = window.localStorage?.getItem('flowops_token');
      if (!token) return;
      const parts = token.split('.');
      if (parts.length !== 3) return;
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      setRole(payload?.role || null);
    } catch { /* ignora */ }
  }, []);
  const isRetaguarda = role === 'admin' || role === 'operator';

  useEffect(() => {
    if (isLogin || !isRetaguarda) return;
    const token = window.localStorage?.getItem('flowops_token');
    if (!token) return;

    const socket = getSocket();
    const onNew = (p: Incoming) => {
      const entry: Entry = {
        key: `${p.id || ''}-${Date.now()}`,
        loja: p.storeName || p.storeCode || 'Filial',
        itens: Number(p.itens || 0),
        note: p.note || null,
        at: Date.now(),
      };
      setStack((prev) => {
        // dedup 5s pelo id
        if (prev.some((x) => x.key.startsWith(`${p.id}-`) && Date.now() - x.at < 5000)) return prev;
        return [...prev, entry];
      });
      beep();
      desktopNotif(entry.loja, entry.itens);
      // auto-dismiss em 12s
      setTimeout(() => setStack((prev) => prev.filter((x) => x.key !== entry.key)), 12_000);
    };
    socket.on('supplies:new-request', onNew);
    return () => { socket.off('supplies:new-request', onNew); };
  }, [isLogin, isRetaguarda]);

  function beep() {
    try {
      if (!audioRef.current) {
        const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctx) return;
        audioRef.current = new Ctx();
      }
      const ctx = audioRef.current!;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      [0, 0.16].forEach((t) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 660;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0, ctx.currentTime + t);
        gain.gain.linearRampToValueAtTime(0.35, ctx.currentTime + t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.14);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(ctx.currentTime + t); osc.stop(ctx.currentTime + t + 0.15);
      });
    } catch { /* ignora */ }
  }

  function desktopNotif(loja: string, itens: number) {
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('📦 Novo pedido de materiais', {
          body: `${loja} pediu ${itens} item(ns).`,
          tag: 'flowops-supply',
        });
      }
    } catch { /* ignora */ }
  }

  if (isLogin || !isRetaguarda || stack.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9998] flex flex-col gap-2 w-[320px] max-w-[92vw]">
      {stack.slice(-4).map((e) => (
        <div key={e.key} className="rounded-xl border border-amber-300 bg-white shadow-lg overflow-hidden animate-[slideIn_.3s_ease-out]">
          <div className="flex items-start gap-2 p-3">
            <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
              <Package className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-bold uppercase tracking-wide text-amber-700">Novo pedido de materiais</div>
              <div className="text-sm font-bold text-slate-800 truncate">{e.loja} · {e.itens} item(ns)</div>
              {e.note && <div className="text-[11px] text-slate-500 truncate">“{e.note}”</div>}
              <Link
                href="/retaguarda/inbox"
                onClick={() => setStack((prev) => prev.filter((x) => x.key !== e.key))}
                className="mt-1 inline-block text-xs font-bold text-amber-700 hover:underline"
              >
                Abrir Inbox →
              </Link>
            </div>
            <button
              onClick={() => setStack((prev) => prev.filter((x) => x.key !== e.key))}
              className="text-slate-300 hover:text-slate-600 shrink-0"
              aria-label="Fechar"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}
      <style jsx global>{`
        @keyframes slideIn { from { transform: translateX(110%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      `}</style>
    </div>
  );
}
