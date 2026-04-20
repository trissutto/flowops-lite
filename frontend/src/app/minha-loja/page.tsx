'use client';

/**
 * /minha-loja — Tela do operador de loja (role=store).
 *
 * Fluxo:
 *  1. Carrega perfil do user logado (GET /auth/me). Se não for role=store, redireciona.
 *  2. Lista pick-orders da loja dele (GET /pick-orders/mine) — só ativos por default.
 *  3. Conecta socket na sala `store:{storeId}` e escuta:
 *      - pick-order:new     → adiciona card + dispara notificação + auto-maximize em 5min
 *      - pick-order:status  → atualiza status do card (eco das próprias ações)
 *  4. Botões por status:
 *      - new         → "Iniciar Separação"        → separating
 *      - separating  → "Marcar como Pronto"       → ready
 *      - ready       → "Enviar (rastreio)"        → abre modal → shipped
 *  5. Sem som de alerta. Só notificação visual + title flash + (electron) maximize.
 *
 * Mobile-first: cards grandes, botões grossos, sem menu lateral.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { parseShippingAddress, formatPhone } from '@/lib/format-address';
import Logo from '@/components/Logo';
import BipModal from './BipModal';
import {
  Clock, PlayCircle, CheckCircle2, Truck, Printer, RefreshCw,
  Wifi, WifiOff, X, LogOut, AlertCircle, Barcode, Hourglass,
} from 'lucide-react';

type PickStatus = 'new' | 'separating' | 'separated' | 'ready' | 'shipped';

interface PickOrderItem {
  id?: string;
  sku: string;
  quantity: number;
  productName?: string | null;
  variant?: string | null;
  assignedStoreId?: string | null;
}

interface PickOrderRow {
  id: string;
  status: PickStatus;
  trackingCode: string | null;
  carrier: string | null;
  createdAt: string;
  updatedAt?: string;
  isTransfer?: boolean;
  transferToStoreCode?: string | null;
  transferToStoreName?: string | null;
  transferToStoreCity?: string | null;
  customerSnapshot?: {
    name?: string | null;
    cpf?: string | null;
    email?: string | null;
    phone?: string | null;
    pickupStoreCode?: string | null;
    pickupStoreName?: string | null;
    shippingMethod?: string | null;
    wcOrderNumber?: string | null;
    wcOrderId?: number | null;
  } | null;
  order: {
    id: string;
    wcOrderId: number | null;
    wcOrderNumber: string | null;
    customerName: string | null;
    customerPhone: string | null;
    customerCpf?: string | null;
    customerEmail?: string | null;
    shippingCep: string | null;
    shippingAddress: string | null;
    totalAmount: number | null;
    wcDateCreated?: string | null;
    isPickup?: boolean;
    pickupStoreCode?: string | null;
    shippingMethod?: string | null;
    items?: PickOrderItem[];
  };
}

interface MeProfile {
  userId: string;
  email: string;
  role: 'admin' | 'operator' | 'store';
  storeId: string | null;
  storeCode: string | null;
  storeName: string | null;
}

const STATUS_LABEL: Record<PickStatus, string> = {
  new: 'Novo',
  separating: 'Separando',
  separated: 'Pronto p/ postar',
  ready: 'Pronto',
  shipped: 'Enviado',
};
const STATUS_COLOR: Record<PickStatus, string> = {
  new: 'bg-amber-100 text-amber-900 border-amber-300',
  separating: 'bg-blue-100 text-blue-900 border-blue-300',
  separated: 'bg-emerald-100 text-emerald-900 border-emerald-300',
  ready: 'bg-emerald-100 text-emerald-900 border-emerald-300',
  shipped: 'bg-slate-200 text-slate-700 border-slate-300',
};

const CARRIERS = ['Correios', 'Loggi', 'Jadlog', 'Azul Cargo', 'Total Express', 'Retirada', 'Outra'];

export default function MinhaLojaPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeProfile | null>(null);
  const [rows, setRows] = useState<PickOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [showShippedModal, setShowShippedModal] = useState<PickOrderRow | null>(null);
  const [showBipModal, setShowBipModal] = useState<PickOrderRow | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: string; msg: string }>>([]);
  const autoMaximizeTimers = useRef<Map<string, number>>(new Map());
  const originalTitleRef = useRef<string>('LURDS ORDER ONE');

  // Set de IDs de pick-orders já "vistos" nessa sessão — usado pra evitar
  // que o popup de PEDIDO NOVO apareça de novo pro mesmo pedido em caso de
  // reconexão do socket, eco duplicado, 2ª aba aberta, ou emit repetido do
  // backend. Persistido em localStorage por loja+dia pra sobreviver a
  // reload/restart do Electron (reseta toda manhã — então se o pedido ficar
  // aberto virando o dia, no máximo notifica 1x por dia).
  const seenPickIdsRef = useRef<Set<string>>(new Set());
  const seenStorageKeyRef = useRef<string>('');

  const loadSeenFromStorage = useCallback((storeId: string) => {
    try {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const key = `flowops_seen_${storeId}_${today}`;
      seenStorageKeyRef.current = key;
      const raw = localStorage.getItem(key);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) seenPickIdsRef.current = new Set(arr);
      }
      // Limpa chaves de dias anteriores pra não vazar localStorage
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(`flowops_seen_${storeId}_`) && k !== key) {
          localStorage.removeItem(k);
        }
      }
    } catch {}
  }, []);

  const persistSeen = useCallback(() => {
    try {
      if (!seenStorageKeyRef.current) return;
      localStorage.setItem(
        seenStorageKeyRef.current,
        JSON.stringify(Array.from(seenPickIdsRef.current)),
      );
    } catch {}
  }, []);

  // ---------- Auth + initial load ----------
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    (async () => {
      try {
        const profile = await api<MeProfile>('/auth/me');
        if (profile.role !== 'store' || !profile.storeId) {
          // Não é operador de loja → manda pra raiz (admin/operator views)
          router.push('/');
          return;
        }
        setMe(profile);
        // Atualiza document.title com "LURDS ORDER ONE [NOME DA LOJA]"
        // Aparece na aba do browser E na barra da janela Electron.
        if (typeof document !== 'undefined') {
          const fullTitle = profile.storeName
            ? `LURDS ORDER ONE ${profile.storeName}`
            : 'LURDS ORDER ONE';
          document.title = fullTitle;
          originalTitleRef.current = fullTitle;
        }
        // Carrega IDs já notificados hoje — protege contra reload do Electron
        if (profile.storeId) loadSeenFromStorage(profile.storeId);
        await loadRows();
      } catch (err: any) {
        setError(err?.message ?? 'Erro ao carregar perfil');
        if (String(err?.message ?? '').startsWith('401')) {
          router.push('/login');
        }
      } finally {
        setLoading(false);
      }
    })();
    if (typeof document !== 'undefined') {
      originalTitleRef.current = document.title;
    }
  }, [router]);

  const loadRows = useCallback(async () => {
    try {
      const data = await api<PickOrderRow[]>('/pick-orders/mine');
      setRows(data);
      // Tudo que vem no carregamento inicial é considerado "já visto" pra
      // fins de popup — não dispara notificação sonora/title-flash pra pedido
      // que o operador ABRE o app e já encontra na lista. Popup só pra evento
      // socket REALMENTE novo (pick-order criado AGORA).
      for (const r of data) seenPickIdsRef.current.add(r.id);
      persistSeen();
    } catch (err: any) {
      setError(err?.message ?? 'Erro ao carregar pedidos');
    }
  }, [persistSeen]);

  // ---------- Socket ----------
  useEffect(() => {
    if (!me) return;
    const socket = getSocket();

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onNew = (pickOrder: any) => {
      if (!pickOrder?.id) return;

      // Guard anti-popup-fantasma: se esse pick-order JÁ foi visto
      // nessa sessão (ou carregado pela lista inicial, ou notificado antes),
      // não dispara popup de novo. Isso cobre:
      //  - reconexão do socket reemitindo evento
      //  - 2ª instância do Electron/aba aberta com mesmo JWT
      //  - retry interno do socket.io
      //  - qualquer reenvio do backend
      if (seenPickIdsRef.current.has(pickOrder.id)) {
        // Ainda sim garante que a lista está atualizada (caso status tenha mudado)
        setRows((prev) =>
          prev.map((r) =>
            r.id === pickOrder.id
              ? {
                  ...r,
                  status: (pickOrder.status as PickStatus) ?? r.status,
                  trackingCode: pickOrder.trackingCode ?? r.trackingCode,
                  carrier: pickOrder.carrier ?? r.carrier,
                }
              : r,
          ),
        );
        return;
      }

      // Guard anti-pedido-antigo: se o pick-order foi criado há mais de 10 min,
      // não faz sentido tocar alarme de "pedido novo" — provavelmente é eco.
      // Ainda coloca na lista mas sem flash/notificação.
      const createdAt = pickOrder.createdAt
        ? new Date(pickOrder.createdAt).getTime()
        : Date.now();
      const isRecent = Date.now() - createdAt < 10 * 60 * 1000;

      seenPickIdsRef.current.add(pickOrder.id);
      persistSeen();

      setRows((prev) => {
        if (prev.some((r) => r.id === pickOrder.id)) return prev;
        const row: PickOrderRow = {
          id: pickOrder.id,
          status: (pickOrder.status as PickStatus) ?? 'new',
          trackingCode: pickOrder.trackingCode ?? null,
          carrier: pickOrder.carrier ?? null,
          createdAt: pickOrder.createdAt ?? new Date().toISOString(),
          order: pickOrder.order ?? {
            id: pickOrder.orderId,
            wcOrderId: null,
            wcOrderNumber: null,
            customerName: null,
            customerPhone: null,
            shippingCep: null,
            shippingAddress: null,
            totalAmount: null,
            items: [],
          },
        };
        return [row, ...prev];
      });

      if (isRecent) {
        triggerNewOrderAlert(pickOrder);
      } else {
        // Pedido antigo chegando via socket (eco): só toast discreto, sem barulho
        pushToast(`Pedido adicionado (eco): #${pickOrder?.order?.wcOrderNumber ?? '—'}`);
      }
    };
    const onStatus = (pickOrder: any) => {
      if (!pickOrder?.id) return;
      setRows((prev) =>
        prev.map((r) =>
          r.id === pickOrder.id
            ? {
                ...r,
                status: pickOrder.status ?? r.status,
                trackingCode: pickOrder.trackingCode ?? r.trackingCode,
                carrier: pickOrder.carrier ?? r.carrier,
              }
            : r,
        ),
      );
    };

    // Impressão remota disparada pela matriz: abre hidden window (Electron)
    // ou janela pop-up (browser) apontando pro cupom com ?autoprint=1.
    // A página de impressão se auto-imprime e se fecha.
    const onPrintRequest = (payload: { pickOrderId: string; url: string }) => {
      if (!payload?.url) return;
      const absolute = payload.url.startsWith('http')
        ? payload.url
        : window.location.origin + payload.url;
      // Se estiver no Electron, usa o IPC que abre hidden window silenciosa
      const electron = (window as any).electronAPI;
      if (electron?.silentPrintUrl) {
        electron.silentPrintUrl(absolute).catch((e: any) => {
          console.warn('silentPrintUrl falhou:', e);
          window.open(absolute, 'flowops-print', 'width=400,height=600');
        });
      } else {
        // Browser normal: abre janela popup (vai mostrar preview do browser)
        window.open(absolute, 'flowops-print', 'width=400,height=600');
      }
      pushToast(`🖨️ Imprimindo pedido #${payload.pickOrderId.slice(0, 6)}...`);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('pick-order:new', onNew);
    socket.on('pick-order:status', onStatus);
    socket.on('pick-order:print', onPrintRequest);
    if (socket.connected) setConnected(true);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('pick-order:new', onNew);
      socket.off('pick-order:status', onStatus);
      socket.off('pick-order:print', onPrintRequest);
    };
  }, [me]);

  // ---------- Notificação + auto-maximize em 5min ----------
  const triggerNewOrderAlert = useCallback((pickOrder: any) => {
    const orderNumber = pickOrder?.order?.wcOrderNumber ?? pickOrder?.order?.wcOrderId ?? '—';
    pushToast(`Pedido novo #${orderNumber} chegou!`);

    // Title flash
    if (typeof document !== 'undefined') {
      let on = true;
      const original = originalTitleRef.current;
      const flashId = window.setInterval(() => {
        document.title = on ? `🔔 PEDIDO NOVO #${orderNumber}` : original;
        on = !on;
      }, 700);
      // Para o flash assim que o usuário interage (focus)
      const stop = () => {
        window.clearInterval(flashId);
        document.title = original;
        window.removeEventListener('focus', stop);
        window.removeEventListener('click', stop);
      };
      window.addEventListener('focus', stop);
      window.addEventListener('click', stop);
      window.setTimeout(stop, 60000);
    }

    // Notificação do SO
    if (typeof Notification !== 'undefined') {
      const show = () =>
        new Notification('LURDS ORDER ONE — Pedido Novo', {
          body: `Pedido #${orderNumber} chegou pra separar`,
          silent: true,
        });
      if (Notification.permission === 'granted') show();
      else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then((p) => { if (p === 'granted') show(); });
      }
    }

    // Auto-maximize: se em 5min ninguém clicar, chama window.focus() +
    // (em Electron) IPC pra forçar restore + focus. Se não for Electron, o focus()
    // basta pra piscar o ícone na taskbar.
    const tid = window.setTimeout(() => {
      try {
        window.focus();
        // Electron expõe window.electronAPI?.focusWindow() (ver preload)
        (window as any).electronAPI?.focusWindow?.();
      } catch {}
    }, 5 * 60 * 1000);
    autoMaximizeTimers.current.set(pickOrder.id, tid);
  }, []);

  // Cancela auto-maximize quando o card é visto/atualizado
  const cancelAutoMaximize = useCallback((pickOrderId: string) => {
    const tid = autoMaximizeTimers.current.get(pickOrderId);
    if (tid) {
      clearTimeout(tid);
      autoMaximizeTimers.current.delete(pickOrderId);
    }
  }, []);

  // ---------- Toasts ----------
  const pushToast = useCallback((msg: string) => {
    const id = String(Date.now() + Math.random());
    setToasts((prev) => [...prev, { id, msg }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
  }, []);

  // ---------- Ações ----------
  async function transitionStatus(row: PickOrderRow, to: PickStatus) {
    cancelAutoMaximize(row.id);
    try {
      const updated = await api(`/pick-orders/${row.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: to }),
      });
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...updated } : r)));
      pushToast(`Pedido #${row.order.wcOrderNumber ?? '—'}${STATUS_LABEL[to].toLowerCase()}`);
      if (updated?.wcSyncApplied) {
        pushToast(`🌐 Site: ${updated.wcSyncApplied}`);
      }
      if (updated?.wcSyncWarning) {
        pushToast(`⚠️ ${updated.wcSyncWarning}`);
      }
    } catch (err: any) {
      pushToast(`Erro: ${err?.message ?? 'falha ao atualizar'}`);
    }
  }

  async function submitShipped(row: PickOrderRow, trackingCode: string, carrier: string) {
    cancelAutoMaximize(row.id);
    try {
      const updated = await api(`/pick-orders/${row.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'shipped', trackingCode, carrier }),
      });
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...updated } : r)));
      setShowShippedModal(null);
      pushToast(`Pedido #${row.order.wcOrderNumber ?? '—'} enviado (${carrier})`);
      if (updated?.wcSyncApplied) {
        pushToast(`🌐 Site: ${updated.wcSyncApplied}`);
      }
      if (updated?.wcSyncWarning) {
        pushToast(`⚠️ ${updated.wcSyncWarning}`);
      }
    } catch (err: any) {
      pushToast(`Erro: ${err?.message ?? 'falha ao enviar'}`);
    }
  }

  function logout() {
    try { localStorage.removeItem('flowops_token'); } catch {}
    router.push('/login');
  }

  // ---------- Helpers UI ----------
  const activeRows = useMemo(
    () => rows.filter((r) => r.status !== 'shipped'),
    [rows],
  );
  const countByStatus = useMemo(() => {
    const c: Record<PickStatus, number> = { new: 0, separating: 0, separated: 0, ready: 0, shipped: 0 };
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader />
      </div>
    );
  }
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="bg-red-50 border border-red-300 rounded p-6 max-w-sm text-center">
          <AlertCircle className="w-10 h-10 text-red-600 mx-auto mb-2" />
          <p className="text-red-800 font-medium">{error}</p>
          <button onClick={() => location.reload()} className="mt-4 px-4 py-2 bg-red-600 text-white rounded">
            Recarregar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      {/* Header fixo */}
      <header className="bg-brand text-white sticky top-0 z-30 shadow">
        <div className="px-4 py-3 flex items-center justify-between max-w-3xl mx-auto">
          <div className="flex items-center gap-2">
            <Logo height={32} className="brightness-0 invert" />
            <div>
              <div className="font-bold leading-tight tracking-wide">ORDER ONE</div>
              <div className="text-xs opacity-90">
                {me?.storeName ? me.storeName : 'Minha Loja'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${
                connected ? 'bg-emerald-500/20' : 'bg-red-500/30'
              }`}
              title={connected ? 'Conectado em tempo real' : 'Desconectado — sem tempo real'}
            >
              {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              {connected ? 'Online' : 'Offline'}
            </span>
            <button onClick={loadRows} className="p-2 hover:bg-white/10 rounded" title="Atualizar">
              <RefreshCw className="w-4 h-4" />
            </button>
            <button onClick={logout} className="p-2 hover:bg-white/10 rounded" title="Sair">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
        {/* Contadores */}
        <div className="px-4 pb-3 max-w-3xl mx-auto flex gap-2 text-xs">
          <Counter label="Novos" count={countByStatus.new} color="bg-amber-400 text-amber-950" />
          <Counter label="Separando" count={countByStatus.separating} color="bg-blue-400 text-blue-950" />
          <Counter label="Prontos" count={countByStatus.ready} color="bg-emerald-400 text-emerald-950" />
        </div>
      </header>

      {/* Lista */}
      <main className="max-w-3xl mx-auto p-3 space-y-3 pb-10">
        {activeRows.length === 0 ? (
          <EmptyState />
        ) : (
          activeRows.map((row) => (
            <PickOrderCard
              key={row.id}
              row={row}
              onStart={() => transitionStatus(row, 'separating')}
              onBip={() => setShowBipModal(row)}
              onShip={() => setShowShippedModal(row)}
              onPrint={() => openPrintWindow(row.id)}
              onSeen={() => cancelAutoMaximize(row.id)}
            />
          ))
        )}
      </main>

      {/* Modal enviar */}
      {showShippedModal && (
        <ShippedModal
          row={showShippedModal}
          onClose={() => setShowShippedModal(null)}
          onSubmit={submitShipped}
        />
      )}

      {/* Modal bipagem (EAN13) */}
      {showBipModal && (
        <BipModal
          pickOrderId={showBipModal.id}
          wcOrderNumber={showBipModal.order.wcOrderNumber ?? String(showBipModal.order.wcOrderId ?? '')}
          customerName={showBipModal.order.customerName}
          onClose={() => setShowBipModal(null)}
          onFinished={() => {
            // Atualiza status local pra 'separated' imediatamente (UX ágil)
            setRows((prev) =>
              prev.map((r) =>
                r.id === showBipModal.id ? { ...r, status: 'separated' as PickStatus } : r,
              ),
            );
            setShowBipModal(null);
            pushToast(`Pedido enviado pra matriz pra aprovação da baixa`);
          }}
        />
      )}

      {/* Toasts */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 space-y-2 z-50">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="bg-slate-900 text-white px-4 py-2 rounded shadow-lg text-sm"
          >
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Componentes internos
// ============================================================

function Loader() {
  return (
    <div className="flex items-center gap-2 text-slate-600">
      <RefreshCw className="w-5 h-5 animate-spin" />
      <span>Carregando...</span>
    </div>
  );
}

/**
 * Abre /minha-loja/imprimir/{id} em popup estreito.
 * A página destino dispara window.print() automático e fecha sozinha.
 * Compatível com impressora térmica 80mm (papel de cupom).
 */
function openPrintWindow(pickOrderId: string) {
  const url = `/minha-loja/imprimir/${pickOrderId}`;
  const w = window.open(url, `print-${pickOrderId}`, 'width=400,height=700,noopener=no');
  if (!w) {
    // Popup bloqueado — abre na mesma aba como fallback
    window.location.href = url;
  }
}

function Counter({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className={`flex-1 rounded px-2 py-1 font-medium ${color}`}>
      <span className="text-base font-bold">{count}</span>{' '}
      <span className="opacity-80">{label}</span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-8 text-center text-slate-500">
      <CheckCircle2 className="w-12 h-12 mx-auto text-emerald-400 mb-2" />
      <p className="font-medium">Nenhum pedido pendente</p>
      <p className="text-sm mt-1">Quando o escritório confirmar um pedido, ele aparece aqui.</p>
    </div>
  );
}

function PickOrderCard({
  row, onStart, onBip, onShip, onPrint, onSeen,
}: {
  row: PickOrderRow;
  onStart: () => void;
  onBip: () => void;
  onShip: () => void;
  onPrint: () => void;
  onSeen: () => void;
}) {
  const { order, status } = row;
  const items = order.items ?? [];

  const isTransfer = !!row.isTransfer;
  const snap = row.customerSnapshot ?? null;
  // Na transferência os dados-chave vêm do snapshot (cliente final), não do order.customerName
  const customerName = isTransfer ? snap?.name ?? order.customerName : order.customerName;
  const customerCpf = isTransfer ? snap?.cpf : order.customerCpf ?? null;
  const customerEmail = isTransfer ? snap?.email : order.customerEmail ?? null;
  const customerPhone = isTransfer ? snap?.phone : order.customerPhone;

  return (
    <article
      className={`bg-white rounded-lg border shadow-sm ${
        isTransfer ? 'border-orange-400 ring-2 ring-orange-200' : 'border-slate-200'
      }`}
      onClick={onSeen}
    >
      {/* Banner TRANSFERÊNCIA — alerta visual forte quando não é venda direta */}
      {isTransfer && (
        <div className="bg-orange-500 text-white px-3 py-2 rounded-t-lg">
          <div className="font-bold text-sm flex items-center gap-2">
            🚚 TRANSFERÊNCIA PRA LOJA {row.transferToStoreName ?? row.transferToStoreCode}
          </div>
          <div className="text-xs opacity-95 mt-0.5">
            Separar e enviar pra essa loja — cliente vai retirar lá. Não é venda direta.
          </div>
        </div>
      )}

      {/* Header do card */}
      <header className="flex items-center justify-between p-3 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-slate-900">#{order.wcOrderNumber ?? order.wcOrderId ?? '—'}</span>
            <span
              className={`text-xs px-2 py-0.5 rounded border ${STATUS_COLOR[status]}`}
            >
              {STATUS_LABEL[status]}
            </span>
            {isTransfer && (
              <span className="text-xs px-2 py-0.5 rounded bg-orange-100 text-orange-800 border border-orange-300 font-semibold">
                Transferência
              </span>
            )}
          </div>
          <div className="text-sm text-slate-600 truncate">{customerName ?? '—'}</div>
        </div>
        <div className="text-right text-xs text-slate-500">
          {order.totalAmount != null && (
            <div className="font-semibold text-slate-800">
              R$ {Number(order.totalAmount).toFixed(2)}
            </div>
          )}
          <div className="flex items-center gap-1 mt-1">
            <Clock className="w-3 h-3" />
            <span>{formatRelativeTime(row.createdAt)}</span>
          </div>
        </div>
      </header>

      {/* Itens */}
      <section className="p-3 space-y-1 text-sm">
        {items.length === 0 ? (
          <div className="text-slate-400 italic">Sem itens atribuídos</div>
        ) : (
          items.map((it, idx) => (
            <div key={it.id ?? `${it.sku}-${idx}`} className="flex gap-2">
              <span className="font-mono text-xs bg-slate-100 px-1 rounded shrink-0 self-start mt-0.5">
                {it.quantity}x
              </span>
              <div className="flex-1">
                <div className="text-slate-800">{it.productName ?? it.sku}</div>
                {it.variant && <div className="text-xs text-slate-500">{it.variant}</div>}
                <div className="text-xs text-slate-400">SKU: {it.sku}</div>
              </div>
            </div>
          ))
        )}
      </section>

      {/* Dados do cliente (quando transferência — bloco em destaque com tudo que a loja precisa) */}
      {isTransfer && (
        <section className="px-3 pb-2 text-xs text-slate-700 leading-relaxed border-t border-orange-100 bg-orange-50/40 pt-2">
          <div className="font-semibold text-orange-900 mb-1">
            🧾 Dados do cliente final (quem vai retirar na LOJA {row.transferToStoreName ?? row.transferToStoreCode})
          </div>
          {customerName && <div className="text-slate-900 font-medium">{customerName}</div>}
          {customerCpf && (
            <div className="font-mono">🪪 CPF {customerCpf}</div>
          )}
          {customerEmail && <div>✉️ {customerEmail}</div>}
          {customerPhone && <div>📱 {formatPhone(customerPhone)}</div>}
          <div className="mt-1 text-orange-900 font-medium">
            ⚠ Cliente vai retirar na loja {row.transferToStoreName ?? row.transferToStoreCode}
            {row.transferToStoreCity ? ` (${row.transferToStoreCity})` : ''}.
          </div>
        </section>
      )}

      {/* Endereço / envio ao cliente — só em pedido de ENTREGA normal */}
      {!isTransfer && (() => {
        const addr = parseShippingAddress(order.shippingAddress);
        if (!addr && !order.shippingCep && !customerPhone) return null;
        return (
          <section className="px-3 pb-2 text-xs text-slate-600 leading-relaxed">
            <div className="font-medium text-slate-700 mb-0.5">Envio</div>
            {addr?.recipientName && <div className="text-slate-800">{addr.recipientName}</div>}
            {addr?.streetLine && <div>{addr.streetLine}</div>}
            {addr?.complement && <div>{addr.complement}</div>}
            {addr?.neighborhood && <div>Bairro: {addr.neighborhood}</div>}
            {addr?.cityState && <div>{addr.cityState}</div>}
            {(addr?.cep || order.shippingCep) && (
              <div>CEP: {addr?.cep ?? order.shippingCep}</div>
            )}
            {/* Fallback: texto cru se não deu pra parsear */}
            {!addr?.streetLine && !addr?.recipientName && addr?.oneLiner && (
              <div className="text-slate-500 break-words">{addr.oneLiner}</div>
            )}
            {customerCpf && (
              <div className="mt-1 font-mono text-slate-700">CPF {customerCpf}</div>
            )}
            {customerPhone && (
              <div className="mt-1">Tel: {formatPhone(customerPhone)}</div>
            )}
          </section>
        );
      })()}

      {/* Rastreio (se já enviado) */}
      {status === 'shipped' && row.trackingCode && (
        <section className="px-3 pb-2 text-sm bg-slate-50">
          <div className="font-medium text-slate-700">Rastreio</div>
          <div className="font-mono text-slate-900">{row.trackingCode}</div>
          <div className="text-xs text-slate-500">{row.carrier}</div>
        </section>
      )}

      {/* Ações */}
      <footer className="p-3 border-t border-slate-100 flex flex-col sm:flex-row gap-2">
        {status === 'new' && (
          <button
            onClick={(e) => { e.stopPropagation(); onStart(); }}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded flex items-center justify-center gap-2"
          >
            <PlayCircle className="w-5 h-5" /> Iniciar Separação
          </button>
        )}
        {status === 'separating' && (
          <button
            onClick={(e) => { e.stopPropagation(); onBip(); }}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded flex items-center justify-center gap-2"
          >
            <Barcode className="w-5 h-5" /> Bipar peças
          </button>
        )}
        {(status === 'separated' || status === 'ready') && (
          <button
            onClick={(e) => { e.stopPropagation(); onShip(); }}
            className="flex-1 bg-slate-900 hover:bg-black text-white font-semibold py-3 rounded flex items-center justify-center gap-2"
          >
            <Truck className="w-5 h-5" /> Enviar (rastreio)
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onPrint(); }}
          className="sm:w-auto bg-slate-200 hover:bg-slate-300 text-slate-800 font-medium py-3 px-4 rounded flex items-center justify-center gap-2"
          title="Imprimir"
        >
          <Printer className="w-4 h-4" /> Imprimir
        </button>
      </footer>
    </article>
  );
}

function ShippedModal({
  row, onClose, onSubmit,
}: {
  row: PickOrderRow;
  onClose: () => void;
  onSubmit: (row: PickOrderRow, trackingCode: string, carrier: string) => void;
}) {
  const [tracking, setTracking] = useState('');
  const [carrier, setCarrier] = useState(CARRIERS[0]);
  const [customCarrier, setCustomCarrier] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const effectiveCarrier = carrier === 'Outra' ? customCarrier.trim() : carrier;
  const canSubmit = tracking.trim().length >= 5 && effectiveCarrier.length >= 2;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(row, tracking.trim(), effectiveCarrier);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full sm:max-w-md shadow-xl">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-bold text-lg">
            Enviar pedido #{row.order.wcOrderNumber ?? '—'}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Código de rastreio</label>
            <input
              type="text"
              autoFocus
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              placeholder="Ex: BR123456789BR"
              className="w-full px-3 py-3 border rounded text-base font-mono uppercase"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Transportadora</label>
            <select
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
              className="w-full px-3 py-3 border rounded text-base"
            >
              {CARRIERS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            {carrier === 'Outra' && (
              <input
                type="text"
                value={customCarrier}
                onChange={(e) => setCustomCarrier(e.target.value)}
                placeholder="Nome da transportadora"
                className="mt-2 w-full px-3 py-3 border rounded text-base"
              />
            )}
          </div>
        </div>
        <div className="p-4 border-t flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-3 bg-slate-200 hover:bg-slate-300 rounded font-medium"
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit || submitting}
            className="flex-1 px-4 py-3 bg-slate-900 text-white rounded font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {submitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />}
            Confirmar envio
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
