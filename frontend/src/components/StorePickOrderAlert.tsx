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
  productName?: string;
  qty?: number;
  quantity?: number;
  unitPrice?: number;
}

/**
 * Parse shipping_address que vem como JSON do WooCommerce.
 * Formato típico: {"first_name":"X","last_name":"Y","address_1":"...",
 *                  "address_2":"...","city":"...","state":"...","postcode":"...",
 *                  "number":"...","neighborhood":"..."}
 * Retorna string formatada bonita pra exibir.
 */
function parseAddress(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  // Se não parece JSON, retorna como veio
  if (!s.startsWith('{')) return s;
  try {
    const o = JSON.parse(s);
    const partes: string[] = [];
    // Logradouro + número + complemento
    const rua = [o.address_1, o.number].filter(Boolean).join(', ');
    if (rua) partes.push(rua);
    if (o.address_2) partes.push(o.address_2);
    if (o.neighborhood) partes.push(o.neighborhood);
    // Cidade/UF/CEP
    const cidadeUf = [o.city, o.state].filter(Boolean).join('/');
    if (cidadeUf) partes.push(cidadeUf);
    if (o.postcode) partes.push(`CEP ${o.postcode}`);
    return partes.join(' · ');
  } catch {
    return s; // se falhar parse, mostra cru
  }
}

/**
 * Extrai REF/COR/TAM do productName quando os campos individuais não vêm.
 * Padrão Lurd's: "BLUSA FEMININA PLUS SIZE 13014 BEGE 46 PREDILECTS"
 *                "VESTIDO MIDI VLM-222 PRETO 48"
 * Heurística: pega últimos tokens, achando número (tamanho) e palavra antes (cor).
 */
function parseProductName(name: string): { ref: string; cor: string; tamanho: string } {
  const out = { ref: '', cor: '', tamanho: '' };
  if (!name) return out;
  const tokens = name.trim().split(/\s+/);
  if (tokens.length < 2) return out;
  // Procura tamanho: token que é número 2-3 dígitos OU padrão "46/48"
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i].toUpperCase();
    if (/^\d{2,3}$/.test(t) || /^\d{2}\/\d{2}$/.test(t)) {
      out.tamanho = t;
      // Cor é o token anterior se for palavra
      if (i > 0 && /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{3,}$/i.test(tokens[i - 1])) {
        out.cor = tokens[i - 1].toUpperCase();
      }
      // REF é o token antes da cor (ou antes do tamanho se não tem cor)
      const refIdx = out.cor ? i - 2 : i - 1;
      if (refIdx >= 0) {
        const candidate = tokens[refIdx];
        if (/^[A-Z0-9-]{3,}$/i.test(candidate)) out.ref = candidate.toUpperCase();
      }
      break;
    }
  }
  return out;
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
  items: Array<{ ref: string; cor: string; tamanho: string; qty: number; desc: string; sku: string }>;
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
  // Parse endereço (vem como JSON do WC)
  const addressRaw = String(orderObj.shippingAddress ?? po.shippingAddress ?? '').trim();
  const address = parseAddress(addressRaw);
  const notes = String(orderObj.notes ?? '').trim();
  const rawItems = orderObj.items || po.items || [];
  const items = rawItems.map((it) => {
    // Campos do schema Order/OrderItem: sku, productName, quantity, unitPrice
    // Tenta primeiro os campos diretos; se vazios, extrai do productName
    const name = String(it.productName ?? it.desc ?? it.description ?? '').trim();
    let ref = String(it.ref ?? '').trim();
    let cor = String(it.cor ?? '').trim();
    let tamanho = String(it.tamanho ?? '').trim();
    if (!ref || !cor || !tamanho) {
      const parsed = parseProductName(name);
      if (!ref) ref = parsed.ref;
      if (!cor) cor = parsed.cor;
      if (!tamanho) tamanho = parsed.tamanho;
    }
    // Se ainda não tem REF, usa SKU/CODIGO como fallback
    if (!ref) ref = String(it.sku ?? '').trim();
    return {
      ref,
      cor,
      tamanho,
      qty: Number(it.qty ?? it.quantity ?? 1) || 1,
      desc: name,
      sku: String(it.sku ?? '').trim(),
    };
  });

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

            {/* Itens — cards verticais (mais legível com descrições longas) */}
            <div>
              <div className="flex items-center gap-1.5 text-xs uppercase font-bold text-slate-500 tracking-wide mb-2">
                <Package className="w-3.5 h-3.5" /> Itens ({top.items.length})
              </div>
              <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                {top.items.map((it, i) => (
                  <div key={i} className="p-3 flex items-start gap-3">
                    {/* Qty grande */}
                    <div className="flex-shrink-0 w-12 h-12 bg-rose-100 text-rose-700 rounded-lg flex items-center justify-center font-black text-2xl">
                      {it.qty}
                    </div>
                    <div className="flex-1 min-w-0">
                      {/* Linha 1: descrição completa do produto */}
                      <div className="font-bold text-slate-800 text-sm leading-snug">
                        {it.desc || '— sem descrição —'}
                      </div>
                      {/* Linha 2: chips com REF, COR, TAM, SKU */}
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        {it.ref && (
                          <span className="inline-flex items-center px-1.5 py-0.5 bg-violet-100 text-violet-800 rounded text-[11px] font-mono font-bold">
                            REF {it.ref}
                          </span>
                        )}
                        {it.cor && (
                          <span className="inline-flex items-center px-1.5 py-0.5 bg-slate-100 text-slate-700 rounded text-[11px] font-bold">
                            {it.cor}
                          </span>
                        )}
                        {it.tamanho && (
                          <span className="inline-flex items-center px-1.5 py-0.5 bg-amber-100 text-amber-900 rounded text-[11px] font-bold">
                            TAM {it.tamanho}
                          </span>
                        )}
                        {it.sku && it.sku !== it.ref && (
                          <span className="inline-flex items-center px-1.5 py-0.5 bg-slate-50 text-slate-500 rounded text-[10px] font-mono">
                            SKU {it.sku}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
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
            {/*
              IMPORTANTE: pedido do SITE vai pra /minha-loja (hub da loja, que
              lista pick-orders do site). NÃO confundir com /realinhamento
              que é transferência entre lojas — outro fluxo completamente.
            */}
            <Link
              href="/minha-loja"
              onClick={() => dismiss(top.pickOrderId)}
              className="flex-1 sm:flex-none px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold text-center"
            >
              📋 Abrir lista de pedidos do site
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
