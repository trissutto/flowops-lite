'use client';

/**
 * StorePickOrderAlert — Alerta proeminente de NOVO PEDIDO no PDV da loja.
 *
 * Pra que serve: substitui (ou reforça) a notificação por WhatsApp.
 * Quando o backend cria um PickOrder pra essa loja, esse componente:
 *  1. Mostra um modal GIGANTE bloqueante (impossível ignorar)
 *  2. Toca beeps em LOOP até o usuário marcar "VI"
 *  3. Persiste em localStorage — sobrevive a reload da página
 *  4. Mostra TODOS os dados úteis do pedido (cliente, itens, valor, endereço)
 *
 * Redundância (não perder pedido se whatsapp/socket falhar):
 *  - WebSocket `pick-order:new` (sala store:<storeId>) — instantâneo
 *  - Polling de /pick-orders/mine a cada 20s — fallback
 *
 * Onde plugar: dentro do layout do PDV (frontend/src/app/minha-loja/pdv/page.tsx)
 *
 * Persistência:
 *  - localStorage["lurd_pdv_pending_orders"] = JSON de pedidos pendentes
 *  - Pedido só sai dali quando user clica VI ou Ir pra Separação
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { getSocket } from '@/lib/socket';
import { api } from '@/lib/api';
import { Bell, BellOff, X, AlertTriangle, Package, MapPin, User, DollarSign } from 'lucide-react';

const LS_KEY = 'lurd_pdv_pending_orders';
const LOG = (...a: any[]) => console.log('[StorePickOrderAlert]', ...a);

interface ItemIncoming {
  sku?: string;
  ref?: string | null;
  cor?: string | null;
  tamanho?: string | null;
  desc?: string;
  description?: string;
  qty?: number;
  quantity?: number;
}

interface PickOrderIncoming {
  id?: string;
  orderId?: string;
  status?: string;
  storeCode?: string;
  storeName?: string;
  isTransfer?: boolean;
  transferToStoreCode?: string | null;
  transferToStoreName?: string | null;
  order?: {
    id?: string;
    wcOrderNumber?: number | string | null;
    number?: number | string | null;
    customerName?: string | null;
    customerPhone?: string | null;
    totalAmount?: number | string | null;
    total?: number | string | null;
    shippingAddress?: string | null;
    notes?: string | null;
    items?: ItemIncoming[];
  };
  items?: ItemIncoming[];
  // tolerância: payload pode vir achatado
  customerName?: string | null;
  totalAmount?: number | string | null;
  shippingAddress?: string | null;
}

interface PendingEntry {
  pickOrderId: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  total: string;
  totalNum: number;
  address: string;
  notes: string;
  items: Array<{ ref: string; cor: string; tamanho: string; qty: number; desc: string }>;
  isTransfer: boolean;
  transferTo: string;
  receivedAt: number;
}

function fmtBRL(n: number | string | null | undefined) {
  const v = Number(n ?? 0) || 0;
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function normalize(po: PickOrderIncoming): PendingEntry | null {
  const pickOrderId = String(po.id || po.orderId || '');
  if (!pickOrderId) return null;
  const orderObj = po.order || {};
  const orderNumber = String(
    orderObj.wcOrderNumber ?? orderObj.number ?? orderObj.id ?? po.orderId ?? pickOrderId,
  );
  const customerName = String(orderObj.customerName ?? po.customerName ?? '—').trim();
  const customerPhone = String(orderObj.customerPhone ?? '').trim();
  const totalNum = Number(orderObj.totalAmount ?? orderObj.total ?? po.totalAmount ?? 0) || 0;
  const address = String(orderObj.shippingAddress ?? po.shippingAddress ?? '').trim();
  const notes = String(orderObj.notes ?? '').trim();
  const rawItems = orderObj.items || po.items || [];
  const items = rawItems.map((it) => ({
    ref: String(it.ref ?? it.sku ?? '').trim(),
    cor: String(it.cor ?? '').trim(),
    tamanho: String(it.tamanho ?? '').trim(),
    qty: Number(it.qty ?? it.quantity ?? 1) || 1,
    desc: String(it.desc ?? it.description ?? '').trim(),
  }));

  return {
    pickOrderId,
    orderNumber,
    customerName,
    customerPhone,
    total: fmtBRL(totalNum),
    totalNum,
    address,
    notes,
    items,
    isTransfer: !!po.isTransfer,
    transferTo: po.transferToStoreName || po.transferToStoreCode || '',
    receivedAt: Date.now(),
  };
}

function loadPending(): PendingEntry[] {
  try {
    const raw = window.localStorage?.getItem(LS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as PendingEntry[];
  } catch {
    return [];
  }
}
function savePending(arr: PendingEntry[]) {
  try {
    window.localStorage?.setItem(LS_KEY, JSON.stringify(arr));
  } catch {}
}

export default function StorePickOrderAlert() {
  const [stack, setStack] = useState<PendingEntry[]>([]);
  const [soundOn, setSoundOn] = useState(true);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const loopTimerRef = useRef<any>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());

  // ─── Carrega pendentes do localStorage no mount ───
  useEffect(() => {
    const initial = loadPending();
    setStack(initial);
    for (const p of initial) seenIdsRef.current.add(p.pickOrderId);
    try {
      const pref = window.localStorage?.getItem('lurd_pdv_alert_sound');
      if (pref === '0') setSoundOn(false);
    } catch {}
    // permissão pra Notification API
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    // desbloqueia AudioContext no primeiro click
    const unlock = () => {
      try {
        if (!audioCtxRef.current) {
          const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
          if (Ctx) audioCtxRef.current = new Ctx();
        }
        if (audioCtxRef.current?.state === 'suspended') {
          audioCtxRef.current.resume().catch(() => {});
        }
      } catch {}
      document.removeEventListener('click', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('click', unlock);
    document.addEventListener('keydown', unlock);
    return () => {
      document.removeEventListener('click', unlock);
      document.removeEventListener('keydown', unlock);
    };
  }, []);

  // Persiste sempre que stack muda
  useEffect(() => {
    savePending(stack);
  }, [stack]);

  const playBeepLoop = useCallback(() => {
    if (!soundOn) return;
    const fire = () => {
      try {
        if (!audioCtxRef.current) {
          const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
          if (!Ctx) return;
          audioCtxRef.current = new Ctx();
        }
        const ctx = audioCtxRef.current!;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        [0, 0.18, 0.36].forEach((t) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.frequency.value = 980;
          osc.type = 'sine';
          gain.gain.setValueAtTime(0, ctx.currentTime + t);
          gain.gain.linearRampToValueAtTime(0.55, ctx.currentTime + t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.16);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(ctx.currentTime + t);
          osc.stop(ctx.currentTime + t + 0.17);
        });
      } catch (e) {
        LOG('beep falhou:', e);
      }
    };
    fire();
    // Re-toca a cada 8s enquanto houver pedidos pendentes
    loopTimerRef.current = setInterval(fire, 8000);
  }, [soundOn]);

  const stopBeepLoop = useCallback(() => {
    if (loopTimerRef.current) {
      clearInterval(loopTimerRef.current);
      loopTimerRef.current = null;
    }
  }, []);

  // ─── Liga/desliga beep loop conforme stack ───
  useEffect(() => {
    if (stack.length > 0 && soundOn) {
      stopBeepLoop();
      playBeepLoop();
    } else {
      stopBeepLoop();
    }
    return () => stopBeepLoop();
  }, [stack.length, soundOn, playBeepLoop, stopBeepLoop]);

  // ─── Push helper ───
  const push = useCallback((po: PickOrderIncoming) => {
    const entry = normalize(po);
    if (!entry) return;
    if (seenIdsRef.current.has(entry.pickOrderId)) {
      LOG('Já visto, ignora:', entry.pickOrderId);
      return;
    }
    seenIdsRef.current.add(entry.pickOrderId);
    setStack((prev) => {
      if (prev.some((p) => p.pickOrderId === entry.pickOrderId)) return prev;
      return [entry, ...prev]; // novo no topo
    });
    // Notification API
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(`📦 PEDIDO NOVO #${entry.orderNumber}`, {
          body: `${entry.customerName} · ${entry.total}`,
          tag: `pdv-pick-${entry.pickOrderId}`,
          requireInteraction: true,
        });
      }
    } catch {}
    LOG('Empilhou pedido:', entry.pickOrderId);
  }, []);

  // ─── WEBSOCKET ───
  useEffect(() => {
    const token =
      typeof window !== 'undefined' ? window.localStorage?.getItem('flowops_token') : null;
    if (!token) return;
    const socket = getSocket();
    const onNew = (po: PickOrderIncoming) => {
      LOG('🔔 pick-order:new recebido', po);
      push(po);
    };
    const onRemoved = (po: { id?: string }) => {
      // Se a loja removeu/cancelou em outro device, tira da fila
      if (po?.id) dismiss(po.id, false);
    };
    socket.on('pick-order:new', onNew);
    socket.on('pick-order:removed', onRemoved);
    return () => {
      socket.off('pick-order:new', onNew);
      socket.off('pick-order:removed', onRemoved);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push]);

  // ─── POLLING FALLBACK — a cada 20s, busca pedidos pendentes da loja ───
  useEffect(() => {
    const token =
      typeof window !== 'undefined' ? window.localStorage?.getItem('flowops_token') : null;
    if (!token) return;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const items = await api<any[]>('/pick-orders/mine');
        if (!Array.isArray(items)) return;
        // só status "new" que ainda não vimos
        for (const it of items) {
          if (it?.status === 'new' && !seenIdsRef.current.has(String(it.id))) {
            LOG('Polling encontrou novo pick-order:', it.id);
            push(it);
          }
        }
      } catch (e: any) {
        LOG('Polling falhou:', e?.message);
      }
    };

    const kickoff = setTimeout(tick, 2000);
    const interval = setInterval(tick, 20_000);
    return () => {
      stopped = true;
      clearTimeout(kickoff);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push]);

  function dismiss(pickOrderId: string, alsoRemoveSeen = false) {
    setStack((prev) => prev.filter((p) => p.pickOrderId !== pickOrderId));
    if (alsoRemoveSeen) seenIdsRef.current.delete(pickOrderId);
  }

  function dismissAll() {
    setStack([]);
  }

  function toggleSound() {
    const next = !soundOn;
    setSoundOn(next);
    try {
      window.localStorage?.setItem('lurd_pdv_alert_sound', next ? '1' : '0');
    } catch {}
  }

  if (stack.length === 0) return null;

  const top = stack[0];

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-start justify-center pt-6 px-4 bg-black/40 backdrop-blur-sm"
      aria-live="assertive"
      role="alert"
    >
      <div className="w-full max-w-3xl">
        <div
          className="bg-amber-50 border-4 border-amber-500 rounded-2xl shadow-2xl overflow-hidden"
          style={{ animation: 'flowopsPopupIn 0.4s ease-out' }}
        >
          {/* Header gigante */}
          <div className="bg-amber-500 px-5 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-9 h-9 text-amber-900 animate-pulse" />
              <div>
                <div className="text-2xl font-black text-amber-950 leading-none">
                  🛒 CHEGOU PEDIDO DO SITE!
                </div>
                <div className="text-sm font-bold text-amber-900 mt-0.5">
                  {stack.length > 1 ? `${stack.length} pedidos aguardando · vendo #1` : '1 pedido aguardando'}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={toggleSound}
                className="p-2 hover:bg-amber-400 rounded-lg text-amber-900"
                title={soundOn ? 'Silenciar' : 'Ativar som'}
              >
                {soundOn ? <Bell className="w-5 h-5" /> : <BellOff className="w-5 h-5" />}
              </button>
            </div>
          </div>

          {/* Conteúdo do pedido */}
          <div className="p-5 space-y-4 bg-white">
            {/* Linha 1: número + valor */}
            <div className="flex items-baseline justify-between gap-3 border-b border-slate-200 pb-3">
              <div>
                <div className="text-xs uppercase font-bold text-slate-500 tracking-wide">Pedido</div>
                <div className="text-3xl font-black text-slate-800 font-mono">#{top.orderNumber}</div>
              </div>
              <div className="text-right">
                <div className="text-xs uppercase font-bold text-slate-500 tracking-wide">Valor</div>
                <div className="text-3xl font-black text-emerald-700">{top.total}</div>
              </div>
            </div>

            {/* Cliente */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="flex items-center gap-1.5 text-xs uppercase font-bold text-slate-500 tracking-wide mb-1">
                  <User className="w-3.5 h-3.5" /> Cliente
                </div>
                <div className="font-bold text-slate-800 text-lg">{top.customerName}</div>
                {top.customerPhone && (
                  <div className="text-sm text-slate-600 font-mono">{top.customerPhone}</div>
                )}
              </div>
              {top.address && (
                <div className="bg-slate-50 rounded-lg p-3">
                  <div className="flex items-center gap-1.5 text-xs uppercase font-bold text-slate-500 tracking-wide mb-1">
                    <MapPin className="w-3.5 h-3.5" /> Entrega
                  </div>
                  <div className="text-sm text-slate-700 leading-snug">{top.address}</div>
                </div>
              )}
            </div>

            {/* Transferência (se for) */}
            {top.isTransfer && top.transferTo && (
              <div className="bg-violet-100 border border-violet-300 rounded-lg p-3 text-sm">
                <span className="font-bold text-violet-800">⇨ TRANSFERÊNCIA:</span>{' '}
                <span className="text-violet-900">depois de separar, envia pra <b>{top.transferTo}</b></span>
              </div>
            )}

            {/* Itens */}
            <div>
              <div className="flex items-center gap-1.5 text-xs uppercase font-bold text-slate-500 tracking-wide mb-2">
                <Package className="w-3.5 h-3.5" /> Itens ({top.items.length})
              </div>
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-bold text-slate-600 text-xs uppercase">Descrição</th>
                      <th className="px-2 py-1.5 text-center font-bold text-slate-600 text-xs uppercase">Ref</th>
                      <th className="px-2 py-1.5 text-center font-bold text-slate-600 text-xs uppercase">Cor</th>
                      <th className="px-2 py-1.5 text-center font-bold text-slate-600 text-xs uppercase">Tam</th>
                      <th className="px-2 py-1.5 text-center font-bold text-slate-600 text-xs uppercase">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {top.items.map((it, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="px-2 py-1.5 text-slate-800 font-medium">{it.desc || '—'}</td>
                        <td className="px-2 py-1.5 text-center font-mono text-slate-700">{it.ref || '—'}</td>
                        <td className="px-2 py-1.5 text-center text-slate-700">{it.cor || '—'}</td>
                        <td className="px-2 py-1.5 text-center font-bold text-slate-800">{it.tamanho || '—'}</td>
                        <td className="px-2 py-1.5 text-center font-bold text-rose-700 text-base">
                          {it.qty}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Observações */}
            {top.notes && (
              <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-3 text-sm">
                <div className="text-xs uppercase font-bold text-yellow-800 tracking-wide mb-1">Observações</div>
                <div className="text-yellow-900">{top.notes}</div>
              </div>
            )}
          </div>

          {/* Ações */}
          <div className="bg-slate-100 px-5 py-3 flex items-center justify-between gap-3">
            <button
              onClick={() => dismiss(top.pickOrderId)}
              className="px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg font-bold hover:bg-slate-50"
            >
              VI, vou separar
            </button>
            <Link
              href="/minha-loja/realinhamento"
              onClick={() => dismiss(top.pickOrderId)}
              className="flex-1 sm:flex-none px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold text-center"
            >
              📋 Abrir lista de pedidos
            </Link>
          </div>

          {/* Stack indicator: outros pedidos pendentes */}
          {stack.length > 1 && (
            <div className="bg-amber-100 border-t border-amber-200 px-4 py-2 text-xs text-amber-900">
              <b>{stack.length - 1}</b> outro(s) pedido(s) atrás desse. Marque "VI" pra avançar.
              <button
                onClick={dismissAll}
                className="ml-2 underline font-bold"
                title="Marca todos os pendentes como vistos"
              >
                Marcar todos como vistos
              </button>
            </div>
          )}
        </div>
      </div>

      {/* keyframe da animação (reaproveita o do NewOrderAlert) */}
      <style jsx>{`
        @keyframes flowopsPopupIn {
          0%   { transform: translateY(-20px) scale(0.95); opacity: 0; }
          100% { transform: translateY(0) scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
