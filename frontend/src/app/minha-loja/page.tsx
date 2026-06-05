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
import Link from 'next/link';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { parseShippingAddress, formatPhone } from '@/lib/format-address';
import { classifyShipping } from '@/lib/shipping-method';
import Logo from '@/components/Logo';
import TrackingTimeline from '@/components/TrackingTimeline';
import ProductThumb from '@/components/ProductThumb';
import PushActivateButton from '@/components/PushActivateButton';
import BipModal from './BipModal';
import {
  Clock, PlayCircle, CheckCircle2, Truck, Printer, RefreshCw,
  Wifi, WifiOff, X, LogOut, AlertCircle, Barcode, Search, History,
  Package2, ClipboardList, Shuffle, Inbox, Package, ShoppingCart,
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
  const [showIssueModal, setShowIssueModal] = useState<PickOrderRow | null>(null);
  // Filtro de aba: null = todos | 'new' | 'separating' | 'ready' (separados+ready)
  const [filterTab, setFilterTab] = useState<'new' | 'separating' | 'ready' | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: string; msg: string }>>([]);
  // Badge de realinhamento: qtd de ordens pendentes (filial origem). Atualiza
  // via load inicial + socket 'realignment:new' e 'realignment:sent'.
  const [realignmentPending, setRealignmentPending] = useState(0);
  // Badge de remessas chegando (filial destino). Mostra no card "Receber".
  const [shipmentsIncoming, setShipmentsIncoming] = useState(0);
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
        await Promise.all([loadRows(), loadRealignmentCount(), loadShipmentsIncoming()]);
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

  // Atalho global: F2 ou Ctrl+K → vai pra tela de consulta de produto.
  // Ajuda MUITO no balcão — vendedora não precisa tirar a mão do leitor.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isSearchShortcut =
        e.key === 'F2' ||
        ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K'));
      if (isSearchShortcut) {
        e.preventDefault();
        router.push('/minha-loja/consultar');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
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

  // Carrega count de realinhamento pendente (pra badge no card do launchpad).
  // Silencioso: se falhar, mostra 0 e segue a vida — não bloqueia a tela.
  const loadRealignmentCount = useCallback(async () => {
    try {
      const items = await api<Array<{ id: string }>>('/realignment/mine');
      setRealignmentPending(Array.isArray(items) ? items.length : 0);
    } catch {
      setRealignmentPending(0);
    }
  }, []);

  // Carrega contagem de remessas chegando (filial destino) — alimenta badge
  // no card "Receber". Silencioso em caso de erro.
  const loadShipmentsIncoming = useCallback(async () => {
    try {
      const items = await api<Array<{ id: string }>>('/realignment/shipments/incoming');
      setShipmentsIncoming(Array.isArray(items) ? items.length : 0);
    } catch {
      setShipmentsIncoming(0);
    }
  }, []);

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

    // Matriz cancelou esse pedido pra reatribuir loja → some o card.
    const onRemoved = (payload: { orderId: string; pickOrderId?: string }) => {
      if (!payload?.orderId) return;
      setRows((prev) => prev.filter((r) => r.order?.id !== payload.orderId));
      pushToast('Matriz reatribuiu este pedido a outra loja.');
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

    // Realinhamento: matriz despachou ordens pra essa loja origem separar.
    // Payload agregado: { items: [{id,refCode,cor,tamanho,qtyOrigem,...}] }
    // Soma o count no badge + toast pro operador ver que chegou.
    const onRealignmentNew = (payload: any) => {
      const count = Number(payload?.count || payload?.items?.length || 0);
      if (count > 0) {
        setRealignmentPending((prev) => prev + count);
        pushToast(`🔁 Realinhamento: ${count} peça(s) pra separar e enviar`);
      }
    };
    // Quando a própria loja marca enviado em outra aba — sincroniza badge.
    const onRealignmentSent = (_payload: any) => {
      setRealignmentPending((prev) => Math.max(0, prev - 1));
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('pick-order:new', onNew);
    socket.on('pick-order:status', onStatus);
    socket.on('pick-order:removed', onRemoved);
    socket.on('pick-order:print', onPrintRequest);
    socket.on('realignment:new', onRealignmentNew);
    socket.on('realignment:sent', onRealignmentSent);
    if (socket.connected) setConnected(true);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('pick-order:new', onNew);
      socket.off('pick-order:status', onStatus);
      socket.off('pick-order:removed', onRemoved);
      socket.off('pick-order:print', onPrintRequest);
      socket.off('realignment:new', onRealignmentNew);
      socket.off('realignment:sent', onRealignmentSent);
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

  async function submitReportIssue(row: PickOrderRow, reason: string, note: string) {
    cancelAutoMaximize(row.id);
    try {
      const res = await api(`/pick-orders/${row.id}/report-issue`, {
        method: 'POST',
        body: JSON.stringify({ reason, note }),
      });
      // Remove o card da fila da loja imediatamente (backend vai confirmar via socket)
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      setShowIssueModal(null);
      pushToast(
        `Problema reportado: ${res?.reasonLabel ?? reason}. A matriz foi avisada e vai reatribuir pra outra loja.`,
      );
    } catch (err: any) {
      pushToast(`Erro ao reportar: ${err?.message ?? 'falha'}`);
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
      // Auto-baixa no ERP Gigasistemas (dispara no shipped quando ERP_WRITE_ENABLED=true).
      // Mostra só se houve ação real — sucesso, shadow ou falha.
      const ad = updated?.autoDebit;
      if (ad?.applied) {
        pushToast(`📦 Estoque baixado no ERP Gigasistemas`);
      } else if (ad?.shadow) {
        pushToast(`⏳ Baixa em shadow — matriz vai liberar`);
      } else if (ad?.attempted && ad?.reason) {
        pushToast(`⚠️ Baixa ERP falhou: ${ad.reason}. Matriz reabre em /baixas-log.`);
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

  // Lista filtrada pela aba ativa (clique nos cards do topo).
  // null = mostra todos os ativos (default).
  const visibleRows = useMemo(() => {
    if (!filterTab) return activeRows;
    if (filterTab === 'new') return activeRows.filter((r) => r.status === 'new');
    if (filterTab === 'separating') return activeRows.filter((r) => r.status === 'separating');
    if (filterTab === 'ready') return activeRows.filter((r) => r.status === 'separated' || r.status === 'ready');
    return activeRows;
  }, [activeRows, filterTab]);

  // Imprime todos os pedidos visíveis (batch). Abre UMA única janela com TODOS
  // os cupons concatenados — assim o popup blocker bloqueia 0 ou 1 (não N).
  // Resolve o bug "só imprime o primeiro" (Chrome bloqueia janelas em loop).
  const printAllVisible = async () => {
    const targets = visibleRows.filter((r) => r.status === 'new' || r.status === 'separating');
    if (targets.length === 0) return;
    if (targets.length > 1 && !confirm(`Imprimir ${targets.length} pedidos de uma vez?`)) return;
    const ids = targets.map((t) => t.id).join(',');
    const url = `/minha-loja/imprimir-todos?ids=${encodeURIComponent(ids)}`;
    const w = window.open(url, 'imprimir-todos', 'width=420,height=720,noopener=no');
    if (!w) {
      // Se popup bloqueado, abre na MESMA aba (compromisso: usuário volta com back)
      window.location.href = url;
    }
  };

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
    <div className="min-h-screen bg-[#f4f1ec]">
      {/* Header unificado com a retaguarda — fundo branco, borda sutil */}
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-sm">
        <div className="px-4 py-3 flex items-center justify-between max-w-3xl mx-auto">
          <div className="flex items-center gap-3">
            <div
              className="circle-ring flex items-center justify-center w-11 h-11"
              style={{ border: '3px solid #c08081', background: '#f5e6e3' }}
            >
              <Logo height={22} />
            </div>
            <div>
              <div
                className="text-[10px] uppercase tracking-[0.2em] font-semibold leading-none"
                style={{ color: '#8b4f55' }}
              >
                Order One
              </div>
              <div
                className="font-display text-lg leading-tight"
                style={{ color: '#3a2a2c' }}
              >
                {me?.storeName ? me.storeName : 'Minha Loja'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Botão de Push: mostra status ('Notificações ativas' verde / 'Ativar
                notificações' violeta). Some quando browser não suporta. */}
            <PushActivateButton variant="sm" />
            <span
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-full font-medium"
              style={
                connected
                  ? { background: '#e3ebd9', color: '#475636' }
                  : { background: '#f5e6e3', color: '#8b4f55' }
              }
              title={connected ? 'Conectado em tempo real' : 'Desconectado — sem tempo real'}
            >
              {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              <span className="hidden sm:inline">{connected ? 'Online' : 'Offline'}</span>
            </span>
            <button
              onClick={loadRows}
              className="p-2 rounded-full transition"
              style={{ color: '#6e3a40' }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = '#f5e6e3';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
              }}
              title="Atualizar"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={logout}
              className="p-2 rounded-full transition"
              style={{ color: '#6e3a40' }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = '#f5e6e3';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
              }}
              title="Sair"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
        {/* Contadores pastel — 3 mini-pílulas (clicáveis pra filtrar a lista) */}
        <div className="px-4 pb-3 max-w-3xl mx-auto grid grid-cols-3 gap-2">
          <Counter label="Novos"            count={countByStatus.new}                              tone="rose"
            active={filterTab === 'new'}
            onClick={() => setFilterTab(filterTab === 'new' ? null : 'new')} />
          <Counter label="Separando"        count={countByStatus.separating}                       tone="sky"
            active={filterTab === 'separating'}
            onClick={() => setFilterTab(filterTab === 'separating' ? null : 'separating')} />
          <Counter label="Pronto p/ postar" count={countByStatus.separated + countByStatus.ready}  tone="mint"
            active={filterTab === 'ready'}
            onClick={() => setFilterTab(filterTab === 'ready' ? null : 'ready')} />
        </div>
        {filterTab && (
          <div className="px-4 pb-2 max-w-3xl mx-auto flex items-center justify-between gap-2">
            <span className="text-[11px] text-slate-500">
              Filtrando: <strong>{filterTab === 'new' ? 'Novos' : filterTab === 'separating' ? 'Separando' : 'Pronto p/ postar'}</strong>
              {' · '}{visibleRows.length} {visibleRows.length === 1 ? 'pedido' : 'pedidos'}
            </span>
            <button
              type="button"
              onClick={() => setFilterTab(null)}
              className="text-[11px] text-slate-600 underline hover:text-slate-900"
            >
              ver todos
            </button>
          </div>
        )}
      </header>

      {/* Quick-action grid — acesso rápido às funções da filial */}
      <div className="max-w-3xl mx-auto px-3 pt-3">
        <QuickActionGrid realignmentPending={realignmentPending} shipmentsIncoming={shipmentsIncoming} />
      </div>

      {/* Lista */}
      <main className="max-w-3xl mx-auto p-3 space-y-3 pb-10">
        {/* Botões "Imprimir TODOS" + "RESUMO ESTOQUE" — quando filtra Novos/Separando */}
        {(filterTab === 'new' || filterTab === 'separating') && visibleRows.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              onClick={printAllVisible}
              className="w-full px-4 py-3 bg-violet-600 hover:bg-violet-700 text-white font-bold rounded-xl shadow-md flex items-center justify-center gap-2 transition active:scale-95"
            >
              <Printer className="w-5 h-5" />
              Imprimir TODOS ({visibleRows.length})
            </button>
            <button
              type="button"
              onClick={() => {
                const url = '/minha-loja/imprimir-resumo';
                const w = window.open(url, 'resumo-estoque', 'width=420,height=720,noopener=no');
                if (!w) window.location.href = url;
              }}
              className="w-full px-4 py-3 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-xl shadow-md flex items-center justify-center gap-2 transition active:scale-95"
              title="Resumo consolidado pra picking no estoque (sem cupom individual)"
            >
              📋
              RESUMO ESTOQUE ({visibleRows.length})
            </button>
          </div>
        )}
        {visibleRows.length === 0 ? (
          <EmptyState />
        ) : (
          visibleRows.map((row) => (
            <PickOrderCard
              key={row.id}
              row={row}
              onStart={() => transitionStatus(row, 'separating')}
              onBip={() => setShowBipModal(row)}
              onShip={() => setShowShippedModal(row)}
              onPrint={() => openPrintWindow(row.id)}
              onReportIssue={() => setShowIssueModal(row)}
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

      {/* Modal reportar problema */}
      {showIssueModal && (
        <ReportIssueModal
          row={showIssueModal}
          onClose={() => setShowIssueModal(null)}
          onSubmit={submitReportIssue}
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

// ──────────────────────────────────────────────────────────────
// QuickActionGrid — grid de botões grandes pra ações rápidas
// ──────────────────────────────────────────────────────────────
// Cada botão é um gradiente colorido com ícone e label. Pensado pra click
// rápido no mobile (alvo grande) e pra destacar visualmente as funções
// importantes da filial. Quando há realinhamento pendente, destaca um
// card cheia-largura com badge pra ficar impossível de ignorar.
function QuickActionGrid({ realignmentPending = 0, shipmentsIncoming = 0 }: { realignmentPending?: number; shipmentsIncoming?: number }) {
  // 7 cards grandes coloridos — mesmo estilo da retaguarda (/site, /loja, etc.)
  type Tone = 'teal' | 'rose' | 'orange' | 'purple' | 'amber' | 'sky' | 'green';
  const items: Array<{
    href: string;
    icon: any;
    label: string;
    subtitle: string;
    description: string;
    tone: Tone;
    badge?: number;
  }> = [
    { href: '/minha-loja/pdv',           icon: ShoppingCart, label: 'PDV',            subtitle: 'Venda',       description: 'Frente de caixa',          tone: 'teal'   },
    { href: '/minha-loja/consultar',     icon: Search,       label: 'Consultar',      subtitle: 'Estoque',     description: 'Buscar na rede',           tone: 'rose'   },
    { href: '/minha-loja/historico',     icon: History,      label: 'Transferências', subtitle: 'Histórico',   description: 'Eu pedi · me pediram',     tone: 'orange' },
    { href: '/minha-loja/triagem',       icon: Package,      label: 'Triagem',        subtitle: 'Bipar',       description: 'Distribuir mercadoria',    tone: 'purple' },
    { href: '/minha-loja/materiais',     icon: Package2,     label: 'Materiais',      subtitle: 'Suprimentos', description: 'Sacolas, etiquetas…',      tone: 'amber'  },
    { href: '/minha-loja/realinhamento', icon: Shuffle,      label: 'Realinhar',      subtitle: 'Inter-lojas', description: 'Separar pra outras lojas', tone: 'sky',     badge: realignmentPending },
    { href: '/minha-loja/recebimento',   icon: Inbox,        label: 'Receber',        subtitle: 'Mercadoria',  description: 'Dar entrada de remessa',   tone: 'green',   badge: shipmentsIncoming },
  ];

  const TONES: Record<Tone, { from: string; to: string }> = {
    teal:   { from: '#0e7e87', to: '#0a5a62' },
    rose:   { from: '#c95a78', to: '#9a3f59' },
    orange: { from: '#d68a3c', to: '#b66a1f' },
    purple: { from: '#8a5cb6', to: '#5f3e8a' },
    amber:  { from: '#c9a96e', to: '#8a7340' },
    sky:    { from: '#3b82a8', to: '#1f5f80' },
    green:  { from: '#5b9b3e', to: '#3f7029' },
  };

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 fade-up">
      {items.map((a) => {
        const t = TONES[a.tone];
        const Icon = a.icon;
        const hasBadge = a.badge != null && a.badge > 0;
        return (
          <Link
            key={a.href}
            href={a.href}
            className={`relative overflow-hidden rounded-2xl px-4 py-4 text-white shadow-sm hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 transition flex flex-col gap-1.5 ${
              hasBadge ? 'ring-2 ring-rose-300 ring-offset-2 ring-offset-[#f4f1ec]' : ''
            }`}
            style={{ background: `linear-gradient(135deg, ${t.from} 0%, ${t.to} 100%)` }}
          >
            {/* Glow decorativo */}
            <div
              className="absolute -top-8 -right-8 w-32 h-32 rounded-full opacity-15"
              style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }}
            />
            <div className="relative flex items-center justify-between">
              <Icon className="w-6 h-6 opacity-90" strokeWidth={1.7} />
              {hasBadge && (
                <span className="text-[11px] font-black px-2 py-0.5 rounded-full bg-white text-rose-700 shadow animate-pulse">
                  {a.badge}
                </span>
              )}
            </div>
            <div className="relative">
              <div className="text-[10px] font-bold tracking-wider uppercase opacity-90">{a.subtitle}</div>
              <div className="text-xl font-bold leading-tight mt-0.5">{a.label}</div>
              <div className="text-[11px] opacity-80 mt-1 leading-snug">{a.description}</div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function Counter({
  label,
  count,
  tone,
  active,
  onClick,
}: {
  label: string;
  count: number;
  tone: 'rose' | 'sky' | 'mint' | 'peach';
  active?: boolean;
  onClick?: () => void;
}) {
  // Boutique sofisticado — alinhado com TONE_MAP do PastelShell
  const TONES: Record<string, { ring: string; bg: string; text: string; bgActive: string }> = {
    rose:  { ring: '#c08081', bg: '#f5e6e3', text: '#6e3a40', bgActive: '#e8c5c0' },
    sky:   { ring: '#6b8a92', bg: '#dde7ea', text: '#2e4750', bgActive: '#b8ccd2' },
    mint:  { ring: '#9caf88', bg: '#e3ebd9', text: '#475636', bgActive: '#c4d4a8' },
    peach: { ring: '#c87f5e', bg: '#f3e2d6', text: '#6f3b25', bgActive: '#e3c0a3' },
  };
  const t = TONES[tone];
  const hasCount = count > 0;
  const clickable = !!onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`flex-1 rounded-2xl px-3 py-2 transition-all text-left ${hasCount ? '' : 'opacity-60'} ${clickable ? 'cursor-pointer hover:shadow-md active:scale-95' : 'cursor-default'} ${active ? 'ring-2 ring-offset-1 shadow-md' : ''}`}
      style={{
        background: active ? t.bgActive : t.bg,
        border: `${active ? '2.5' : '1.5'}px solid ${t.ring}`,
        outlineColor: t.ring,
      }}
    >
      <div className="font-display text-2xl tabular-nums leading-none" style={{ color: t.text }}>
        {count}
      </div>
      <div className="text-[10px] uppercase tracking-wider mt-1 font-semibold" style={{ color: t.text }}>
        {label}
      </div>
    </button>
  );
}

function EmptyState() {
  return (
    <div className="bg-white rounded-xl border-2 border-dashed border-slate-300 p-10 text-center">
      <div className="w-20 h-20 mx-auto rounded-full bg-emerald-50 flex items-center justify-center mb-3">
        <CheckCircle2 className="w-10 h-10 text-emerald-500" />
      </div>
      <p className="font-bold text-lg text-slate-800">Tudo em dia por aqui!</p>
      <p className="text-sm mt-1 text-slate-500">
        Assim que um novo pedido chegar da matriz, ele aparece automaticamente.
      </p>
    </div>
  );
}

/** Barrinha lateral colorida do card conforme status — tipo "semáforo". */
function statusAccent(s: PickStatus): string {
  switch (s) {
    case 'new': return 'bg-amber-500';
    case 'separating': return 'bg-blue-500';
    case 'separated':
    case 'ready': return 'bg-emerald-500';
    case 'shipped': return 'bg-slate-400';
  }
}

/** Passos visuais do pipeline — mostra o progresso mesmo sem texto. */
function PipelineSteps({ status }: { status: PickStatus }) {
  const steps = [
    { key: 'new', label: 'Recebido' },
    { key: 'separating', label: 'Separando' },
    { key: 'separated', label: 'Pronto' },
    { key: 'shipped', label: 'Enviado' },
  ] as const;
  const order = ['new', 'separating', 'separated', 'ready', 'shipped'];
  const currentIdx = order.indexOf(status);
  const stepIdx = (k: string) => {
    if (k === 'separated') {
      return status === 'separated' || status === 'ready' || status === 'shipped' ? 2 : -1;
    }
    return order.indexOf(k);
  };
  return (
    <div className="flex items-center gap-1 px-3 pt-2 pb-1">
      {steps.map((s, i) => {
        const reachedIdx = s.key === 'separated'
          ? (status === 'separated' || status === 'ready' || status === 'shipped' ? 99 : -1)
          : order.indexOf(s.key);
        const done = reachedIdx !== -1 && reachedIdx <= currentIdx
          || (s.key === 'separated' && (status === 'separated' || status === 'ready' || status === 'shipped'))
          || (s.key === 'shipped' && status === 'shipped');
        const isCurrent =
          (s.key === status) ||
          (s.key === 'separated' && status === 'ready');
        return (
          <div key={s.key} className="flex-1 flex flex-col items-center gap-0.5">
            <div
              className={`w-full h-1.5 rounded-full transition-colors ${
                done ? 'bg-emerald-500' : 'bg-slate-200'
              }`}
            />
            <span
              className={`text-[10px] uppercase tracking-wide ${
                isCurrent ? 'text-emerald-700 font-bold' : done ? 'text-emerald-600' : 'text-slate-400'
              }`}
            >
              {s.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function PickOrderCard({
  row, onStart, onBip, onShip, onPrint, onReportIssue, onSeen,
}: {
  row: PickOrderRow;
  onStart: () => void;
  onBip: () => void;
  onShip: () => void;
  onPrint: () => void;
  onReportIssue: () => void;
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
      className={`bg-white rounded-xl border shadow-md overflow-hidden flex ${
        isTransfer ? 'border-orange-400 ring-2 ring-orange-200' : 'border-slate-200'
      }`}
      onClick={onSeen}
    >
      {/* Faixa lateral colorida conforme status — semáforo visual de 6px */}
      <div className={`w-1.5 flex-shrink-0 ${statusAccent(status)}`} />

      <div className="flex-1 min-w-0">
      {/* Banner TRANSFERÊNCIA — alerta visual forte quando não é venda direta */}
      {isTransfer && (
        <div className="bg-orange-500 text-white px-4 py-2.5">
          <div className="font-bold text-sm flex items-center gap-2">
            🚚 TRANSFERÊNCIA PRA LOJA {row.transferToStoreName ?? row.transferToStoreCode}
          </div>
          <div className="text-xs opacity-95 mt-0.5">
            Separar e enviar pra essa loja — cliente vai retirar lá. Não é venda direta.
          </div>
        </div>
      )}

      {/* Pipeline steps — mostra o progresso visualmente */}
      <PipelineSteps status={status} />

      {/* Header do card — número do pedido BEM grande */}
      <header className="flex items-start justify-between px-4 pt-2 pb-3 border-b border-slate-100">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-2xl font-black text-slate-900 tracking-tight">
              #{order.wcOrderNumber ?? order.wcOrderId ?? '—'}
            </span>
            <span
              className={`text-xs font-bold uppercase tracking-wide px-2 py-1 rounded border ${STATUS_COLOR[status]}`}
            >
              {STATUS_LABEL[status]}
            </span>
            {isTransfer && (
              <span className="text-xs px-2 py-1 rounded bg-orange-100 text-orange-800 border border-orange-300 font-bold uppercase">
                Transferência
              </span>
            )}
          </div>
          <div className="text-sm text-slate-700 font-medium mt-1 truncate">
            {customerName ?? '—'}
          </div>
        </div>
        <div className="text-right text-xs text-slate-500 ml-2 flex-shrink-0">
          {order.totalAmount != null && (
            <div className="text-base font-bold text-slate-900">
              R$ {Number(order.totalAmount).toFixed(2)}
            </div>
          )}
          <div className="flex items-center gap-1 mt-1 justify-end">
            <Clock className="w-3 h-3" />
            <span>{formatRelativeTime(row.createdAt)}</span>
          </div>
        </div>
      </header>

      {/* ─── FAIXA DE MODALIDADE DE ENVIO ─── */}
      {/* Destaque MÁXIMO pra filial bater o olho e saber se é SEDEX/PAC/RETIRADA. */}
      {(() => {
        const raw = order.shippingMethod ?? null;
        if (!raw) return null;
        // UF do destinatário pra resolver PROMOCIONAL → SEDEX (SP) ou PAC
        const addrPar = parseShippingAddress(order.shippingAddress);
        const m = classifyShipping(raw, addrPar?.state ?? null);
        const Icon =
          m.kind === 'sedex'
            ? Truck
            : m.kind === 'pac'
            ? Package
            : m.kind === 'pickup'
            ? Package2
            : m.kind === 'transportadora'
            ? Truck
            : Package2;
        // Cores fortes inline pra garantir contraste alto
        const bg =
          m.kind === 'sedex'
            ? 'bg-red-600'
            : m.kind === 'pac'
            ? 'bg-blue-600'
            : m.kind === 'pickup'
            ? 'bg-amber-500'
            : m.kind === 'transportadora'
            ? 'bg-purple-600'
            : 'bg-slate-700';
        return (
          <div
            className={`${bg} text-white px-4 py-3 flex items-center gap-3 shadow-inner`}
            title={m.raw}
          >
            <Icon className="w-8 h-8 shrink-0" strokeWidth={2.5} />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-widest opacity-80 leading-none">
                Modalidade de Envio
              </div>
              <div className="text-2xl md:text-3xl font-black uppercase tracking-wide leading-tight truncate">
                {m.label}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Itens — qty em badge circular de destaque */}
      <section className="px-4 py-3 space-y-2 text-sm">
        <div className="text-[11px] uppercase tracking-wide font-bold text-slate-500 mb-1">
          Peças ({items.reduce((s, i) => s + (i.quantity ?? 0), 0)})
        </div>
        {items.length === 0 ? (
          <div className="text-slate-400 italic">Sem itens atribuídos</div>
        ) : (
          items.map((it, idx) => (
            <div key={it.id ?? `${it.sku}-${idx}`} className="flex gap-3 items-start">
              {/* Foto do produto — ajuda vendedora a encontrar a peça rápido na loja.
                  Click amplia em lightbox com nome+SKU pra conferir detalhes. */}
              <ProductThumb
                sku={it.sku}
                refCode={it.productName ?? it.sku}
                productName={it.productName ?? null}
                size={64}
              />
              <span className="inline-flex items-center justify-center min-w-[2.25rem] h-9 px-2 rounded-full bg-slate-900 text-white font-extrabold text-sm shrink-0">
                {it.quantity}x
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-slate-900 font-semibold leading-tight">
                  {it.productName ?? it.sku}
                </div>
                {it.variant && (
                  <div className="text-xs text-slate-500 mt-0.5">{it.variant}</div>
                )}
                <div className="text-xs text-slate-400 font-mono mt-0.5">SKU: {it.sku}</div>
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
            {customerEmail && (
              <div className="mt-1 break-all">✉️ {customerEmail}</div>
            )}
          </section>
        );
      })()}

      {/* Rastreio (se já enviado) — mostra código + timeline ao vivo (LinkeTrack) */}
      {status === 'shipped' && row.trackingCode && (
        <section className="mx-4 mb-3 space-y-2">
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3">
            <div className="text-[11px] uppercase tracking-wide font-bold text-emerald-800 flex items-center gap-1">
              <Truck className="w-3 h-3" /> Rastreio
            </div>
            <div className="font-mono text-lg font-bold text-emerald-900 mt-0.5">
              {row.trackingCode}
            </div>
            <div className="text-xs text-emerald-700">{row.carrier}</div>
          </div>
          {/* Timeline ao vivo: só carrega quando expandir (compact) pra não estourar chamadas */}
          <TrackingTimeline
            code={row.trackingCode}
            carrier={row.carrier}
            autoFetch={false}
            compact
          />
        </section>
      )}

      {/* Ações — botões gigantes, fáceis de acertar com dedo */}
      <footer className="p-3 border-t border-slate-100 bg-slate-50/60 flex flex-col sm:flex-row gap-2">
        {status === 'new' && (
          <button
            onClick={(e) => { e.stopPropagation(); onStart(); }}
            className="flex-1 bg-amber-500 hover:bg-amber-600 active:scale-[0.98] text-white font-bold py-4 rounded-lg flex items-center justify-center gap-2 text-base shadow-md transition"
          >
            <PlayCircle className="w-6 h-6" /> Iniciar Separação
          </button>
        )}
        {status === 'separating' && (
          <button
            onClick={(e) => { e.stopPropagation(); onBip(); }}
            className="flex-1 bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white font-bold py-4 rounded-lg flex items-center justify-center gap-2 text-base shadow-md transition"
          >
            <Barcode className="w-6 h-6" /> Bipar peças
          </button>
        )}
        {(status === 'separated' || status === 'ready') && (
          <button
            onClick={(e) => { e.stopPropagation(); onShip(); }}
            className="flex-1 bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-bold py-4 rounded-lg flex items-center justify-center gap-2 text-base shadow-md transition"
          >
            <Truck className="w-6 h-6" /> Enviar c/ rastreio
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onPrint(); }}
          className="sm:w-auto bg-white hover:bg-slate-100 active:scale-[0.98] text-slate-800 font-semibold py-4 px-5 rounded-lg flex items-center justify-center gap-2 border-2 border-slate-300 transition"
          title="Imprimir cupom"
        >
          <Printer className="w-5 h-5" /> Imprimir
        </button>
        {(status === 'new' || status === 'separating') && (
          <button
            onClick={(e) => { e.stopPropagation(); onReportIssue(); }}
            className="sm:w-auto bg-white hover:bg-red-50 active:scale-[0.98] text-red-700 font-semibold py-4 px-5 rounded-lg flex items-center justify-center gap-2 border-2 border-red-300 transition"
            title="Reportar problema (sem estoque, defeito, divergência)"
          >
            <AlertCircle className="w-5 h-5" /> Reportar
          </button>
        )}
      </footer>
      </div>
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
// ReportIssueModal — loja sinaliza problema no pick-order
// ============================================================

const ISSUE_REASONS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'out_of_stock', label: 'Sem estoque físico', hint: 'O sistema mostrava, mas a peça não está na loja' },
  { value: 'defective', label: 'Peça com defeito', hint: 'Furo, mancha, costura ruim, etc.' },
  { value: 'divergence', label: 'Divergência', hint: 'Cor ou tamanho diferente do pedido' },
  { value: 'other', label: 'Outro', hint: 'Descreva na observação abaixo' },
];

function ReportIssueModal({
  row, onClose, onSubmit,
}: {
  row: PickOrderRow;
  onClose: () => void;
  onSubmit: (row: PickOrderRow, reason: string, note: string) => Promise<void> | void;
}) {
  const [reason, setReason] = useState<string>('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = reason && (reason !== 'other' || note.trim().length >= 5);

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(row, reason, note.trim());
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-2 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl max-w-md w-full overflow-hidden shadow-2xl">
        <header className="bg-red-600 text-white px-4 py-3 flex items-center gap-2">
          <AlertCircle className="w-5 h-5" />
          <div className="flex-1">
            <div className="font-bold">Reportar problema</div>
            <div className="text-xs opacity-90">
              Pedido #{row.order.wcOrderNumber ?? row.order.wcOrderId ?? '—'}
            </div>
          </div>
          <button onClick={onClose} className="text-white/90 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="p-4 space-y-3">
          <p className="text-sm text-slate-600">
            Ao confirmar, o pedido <b>some da sua fila</b> e a matriz é avisada pra reatribuir pra outra loja.
          </p>

          <div className="space-y-2">
            {ISSUE_REASONS.map((r) => (
              <label
                key={r.value}
                className={`block border-2 rounded-lg p-3 cursor-pointer transition ${
                  reason === r.value
                    ? 'border-red-500 bg-red-50'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <input
                  type="radio"
                  name="reason"
                  value={r.value}
                  checked={reason === r.value}
                  onChange={() => setReason(r.value)}
                  className="sr-only"
                />
                <div className="flex items-center gap-2">
                  <div
                    className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                      reason === r.value ? 'border-red-500' : 'border-slate-400'
                    }`}
                  >
                    {reason === r.value && (
                      <div className="w-2 h-2 rounded-full bg-red-500" />
                    )}
                  </div>
                  <div>
                    <div className="font-semibold text-slate-900">{r.label}</div>
                    <div className="text-xs text-slate-600">{r.hint}</div>
                  </div>
                </div>
              </label>
            ))}
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-700 block mb-1">
              Observação {reason === 'other' ? '(obrigatório)' : '(opcional)'}
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="Ex: cheguei na arara e a peça não estava lá."
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-red-500"
            />
          </div>
        </div>

        <footer className="p-3 border-t border-slate-100 bg-slate-50 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 bg-white hover:bg-slate-100 text-slate-700 font-semibold py-3 rounded-lg border-2 border-slate-300"
            disabled={submitting}
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit || submitting}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-lg disabled:bg-slate-300 disabled:cursor-not-allowed shadow-md"
          >
            {submitting ? 'Enviando...' : 'Confirmar problema'}
          </button>
        </footer>
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
