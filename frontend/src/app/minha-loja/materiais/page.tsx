'use client';

/**
 * /minha-loja/materiais
 *
 * Filial pede materiais de uso diário (saquinhos, durex, bobina, etiqueta...)
 * para a matriz e acompanha o status dos pedidos.
 *
 * Duas abas:
 *  - Novo pedido: seleciona itens ativos do almoxarifado + quantidade + observação
 *  - Meus pedidos: lista pedidos anteriores com status (pending → delivered)
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft, Package2, Plus, Minus, Trash2, Send, RefreshCw,
  ClipboardList, Search, CheckCircle2, Truck, PackageCheck,
  Clock, XCircle, PlayCircle,
} from 'lucide-react';
import { api } from '@/lib/api';

type SupplyItem = {
  id: string;
  sku: string | null;
  name: string;
  category: string | null;
  unit: string;
  description: string | null;
  active: boolean;
};

type SupplyRequestStatus =
  | 'pending' | 'approved' | 'separating' | 'shipped' | 'delivered' | 'cancelled';

type SupplyRequest = {
  id: string;
  requestNumber: number;
  status: SupplyRequestStatus;
  note: string | null;
  adminNote: string | null;
  trackingCode: string | null;
  carrier: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  items: Array<{
    id: string;
    qtyRequested: number;
    qtyApproved: number | null;
    qtyShipped: number | null;
    supply: SupplyItem;
  }>;
  store: { id: string; code: string; name: string };
};

type Tab = 'novo' | 'historico';

export default function MateriaisPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTab: Tab = searchParams.get('tab') === 'historico' ? 'historico' : 'novo';
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-brand text-white sticky top-0 z-20 shadow">
        <div className="px-4 py-3 flex items-center gap-3 max-w-4xl mx-auto">
          <Link href="/minha-loja" className="p-2 hover:bg-white/10 rounded" title="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-2 font-bold">
              <Package2 className="w-5 h-5" />
              Materiais
            </div>
            <div className="text-xs opacity-80">Pedidos de insumos pra loja</div>
          </div>
        </div>
        {/* Tabs */}
        <div className="px-4 max-w-4xl mx-auto grid grid-cols-2 gap-2 pb-3">
          <TabButton
            active={tab === 'novo'}
            onClick={() => setTab('novo')}
            icon={<Plus className="w-4 h-4" />}
            label="Novo pedido"
          />
          <TabButton
            active={tab === 'historico'}
            onClick={() => setTab('historico')}
            icon={<ClipboardList className="w-4 h-4" />}
            label="Meus pedidos"
          />
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-3 sm:p-4">
        {tab === 'novo' ? <NovoPedidoTab onCreated={() => setTab('historico')} /> : <HistoricoTab />}
      </main>
    </div>
  );
}

function TabButton({
  active, onClick, icon, label,
}: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center justify-center gap-2 py-2 rounded-lg font-semibold text-sm transition ${
        active ? 'bg-white text-brand' : 'bg-white/10 text-white hover:bg-white/20'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ======================================================
// Tab: Novo pedido
// ======================================================

function NovoPedidoTab({ onCreated }: { onCreated: () => void }) {
  const [catalog, setCatalog] = useState<SupplyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Carrinho: { [itemId]: qty }
  const [cart, setCart] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const items = await api<SupplyItem[]>('/supplies/items');
        if (mounted) setCatalog(Array.isArray(items) ? items.filter((i) => i.active) : []);
      } catch (err: any) {
        if (mounted) setError('Não foi possível carregar o catálogo.');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((i) =>
      i.name.toLowerCase().includes(q) ||
      (i.category || '').toLowerCase().includes(q) ||
      (i.sku || '').toLowerCase().includes(q),
    );
  }, [catalog, search]);

  // Agrupa por categoria
  const grouped = useMemo(() => {
    const map = new Map<string, SupplyItem[]>();
    filtered.forEach((it) => {
      const cat = it.category || 'Outros';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(it);
    });
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const totalItens = useMemo(
    () => Object.values(cart).reduce((s, q) => s + q, 0),
    [cart],
  );
  const totalLinhas = Object.keys(cart).length;

  const setQty = (itemId: string, qty: number) => {
    setCart((prev) => {
      const next = { ...prev };
      if (qty <= 0) delete next[itemId];
      else next[itemId] = qty;
      return next;
    });
  };

  const submit = async () => {
    if (submitting || totalLinhas === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const items = Object.entries(cart).map(([supplyItemId, qtyRequested]) => ({
        supplyItemId,
        qtyRequested,
      }));
      const created = await api<SupplyRequest>('/supplies/requests', {
        method: 'POST',
        body: JSON.stringify({ items, note: note.trim() || null }),
      });
      setCart({});
      setNote('');
      setSuccess(`Pedido #${created.requestNumber} enviado! A matriz vai receber agora.`);
      setTimeout(() => {
        setSuccess(null);
        onCreated();
      }, 1500);
    } catch (err: any) {
      const msg = String(err?.message || err);
      setError(msg.includes(':') ? msg.split(':').slice(1).join(':').trim() : 'Falha ao enviar pedido.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="text-center py-10 text-slate-500 text-sm">Carregando catálogo…</div>;
  }

  if (catalog.length === 0 && !error) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
        <Package2 className="w-12 h-12 mx-auto text-slate-300 mb-3" />
        <p className="font-bold text-slate-700">Almoxarifado vazio</p>
        <p className="text-sm text-slate-500 mt-1">
          A matriz ainda não cadastrou nenhum material. Fala com o gerente da matriz.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-3 text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl p-3 text-sm flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5" /> {success}
        </div>
      )}

      {/* Busca */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar item (saquinho, durex…)"
          className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-200 bg-white focus:border-brand focus:outline-none text-sm"
        />
      </div>

      {/* Catálogo agrupado por categoria */}
      {grouped.map(([cat, items]) => (
        <section key={cat} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <header className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs font-bold uppercase tracking-wide text-slate-600">
            {cat}
          </header>
          <div className="divide-y divide-slate-100">
            {items.map((it) => (
              <ItemRow
                key={it.id}
                item={it}
                qty={cart[it.id] || 0}
                onChange={(q) => setQty(it.id, q)}
              />
            ))}
          </div>
        </section>
      ))}

      {/* Sticky bottom bar — carrinho + enviar */}
      {totalLinhas > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 shadow-2xl z-30">
          <div className="max-w-4xl mx-auto p-3 sm:p-4 space-y-2">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Observação (opcional)… Ex: urgente, precisa até sexta"
              rows={2}
              className="w-full p-2 border border-slate-200 rounded-lg text-sm focus:border-brand focus:outline-none resize-none"
            />
            <div className="flex items-center gap-2">
              <div className="flex-1 text-sm">
                <div className="font-bold text-slate-900">
                  {totalLinhas} {totalLinhas === 1 ? 'item' : 'itens'}
                </div>
                <div className="text-xs text-slate-500">
                  Total: {totalItens} {totalItens === 1 ? 'unidade' : 'unidades'}
                </div>
              </div>
              <button
                onClick={() => setCart({})}
                className="px-3 py-2.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 flex items-center gap-1 text-sm font-semibold"
              >
                <Trash2 className="w-4 h-4" />
                Limpar
              </button>
              <button
                onClick={submit}
                disabled={submitting || totalLinhas === 0}
                className="px-4 py-2.5 rounded-lg bg-brand text-white font-bold hover:opacity-90 disabled:bg-slate-300 flex items-center gap-2 shadow"
              >
                <Send className="w-4 h-4" />
                {submitting ? 'Enviando…' : 'Enviar pedido'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Spacer pra não cobrir o último item com a bottom bar */}
      {totalLinhas > 0 && <div className="h-44" />}
    </div>
  );
}

function ItemRow({
  item, qty, onChange,
}: { item: SupplyItem; qty: number; onChange: (q: number) => void }) {
  const active = qty > 0;
  return (
    <div className={`flex items-center gap-3 p-3 ${active ? 'bg-amber-50/50' : ''}`}>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-slate-900 text-sm leading-tight">{item.name}</div>
        <div className="text-[11px] text-slate-500 mt-0.5">
          {item.sku ? `SKU ${item.sku} · ` : ''}Unidade: {item.unit}
          {item.description ? ` · ${item.description}` : ''}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => onChange(Math.max(0, qty - 1))}
          disabled={qty === 0}
          className="w-8 h-8 rounded-lg border border-slate-300 flex items-center justify-center text-slate-600 hover:bg-slate-100 disabled:opacity-40"
          aria-label="Diminuir"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <input
          type="number"
          min={0}
          value={qty || ''}
          placeholder="0"
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            onChange(Number.isFinite(v) && v >= 0 ? v : 0);
          }}
          className="w-12 h-8 text-center border border-slate-300 rounded-lg text-sm font-semibold focus:border-brand focus:outline-none"
        />
        <button
          onClick={() => onChange(qty + 1)}
          className="w-8 h-8 rounded-lg bg-brand text-white flex items-center justify-center hover:opacity-90"
          aria-label="Aumentar"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ======================================================
// Tab: Histórico de pedidos
// ======================================================

function HistoricoTab() {
  const [items, setItems] = useState<SupplyRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ items: SupplyRequest[] }>('/supplies/requests');
      setItems(data.items || []);
    } catch (err: any) {
      setError('Não foi possível carregar os pedidos.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const kpis = useMemo(() => {
    const counter: Record<string, number> = {};
    items.forEach((i) => { counter[i.status] = (counter[i.status] || 0) + 1; });
    return {
      pending: counter.pending || 0,
      approved: counter.approved || 0,
      separating: counter.separating || 0,
      shipped: counter.shipped || 0,
      delivered: counter.delivered || 0,
      cancelled: counter.cancelled || 0,
    };
  }, [items]);

  return (
    <div className="space-y-3">
      {/* KPIs */}
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
        <StatusKpi label="Aguardando" count={kpis.pending + kpis.approved + kpis.separating} color="bg-amber-100 text-amber-800 border-amber-200" />
        <StatusKpi label="Enviado" count={kpis.shipped} color="bg-sky-100 text-sky-800 border-sky-200" />
        <StatusKpi label="Entregue" count={kpis.delivered} color="bg-emerald-100 text-emerald-800 border-emerald-200" />
        <StatusKpi label="Cancelado" count={kpis.cancelled} color="bg-slate-100 text-slate-700 border-slate-200" />
        <button
          onClick={load}
          disabled={loading}
          className="rounded-lg border border-slate-200 bg-white hover:bg-slate-50 px-2 py-2 text-xs font-semibold text-slate-600 flex flex-col items-center justify-center gap-0.5"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </div>

      {/* Lista */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-3 text-sm">{error}</div>
      )}
      {loading && items.length === 0 ? (
        <div className="text-center py-10 text-slate-500 text-sm">Carregando…</div>
      ) : items.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <ClipboardList className="w-12 h-12 mx-auto text-slate-300 mb-3" />
          <p className="font-bold text-slate-700">Nenhum pedido ainda</p>
          <p className="text-sm text-slate-500 mt-1">
            Faça seu primeiro pedido na aba "Novo pedido".
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((req) => <RequestCard key={req.id} request={req} onChanged={load} />)}
        </div>
      )}
    </div>
  );
}

function StatusKpi({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className={`rounded-lg border p-2 text-center ${color}`}>
      <div className="text-[10px] font-bold uppercase tracking-wide leading-tight">{label}</div>
      <div className="text-xl font-bold">{count}</div>
    </div>
  );
}

function RequestCard({ request, onChanged }: { request: SupplyRequest; onChanged: () => void }) {
  const meta = statusMeta(request.status);
  const canCancel = request.status === 'pending';
  const [cancelling, setCancelling] = useState(false);

  const cancel = async () => {
    if (!confirm('Cancelar este pedido?')) return;
    setCancelling(true);
    try {
      await api(`/supplies/requests/${request.id}/cancel`, { method: 'POST' });
      onChanged();
    } catch (err: any) {
      alert('Falha ao cancelar: ' + (err?.message || err));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <div className="font-bold text-slate-900 text-base">
            Pedido #{String(request.requestNumber).padStart(4, '0')}
          </div>
          <div className="text-[11px] text-slate-500">{formatDate(request.createdAt)}</div>
        </div>
        <span className={`inline-flex items-center gap-1 text-[11px] font-bold uppercase px-2 py-1 rounded-full border ${meta.color}`}>
          {meta.icon}
          {meta.label}
        </span>
      </div>

      {/* Itens */}
      <div className="text-xs space-y-1">
        {request.items.map((it) => {
          const effectiveQty = it.qtyShipped ?? it.qtyApproved ?? it.qtyRequested;
          const diverged = it.qtyApproved != null && it.qtyApproved !== it.qtyRequested;
          return (
            <div key={it.id} className="flex items-start gap-2">
              <div className="flex-1 text-slate-700">{it.supply.name}</div>
              <div className={`font-mono font-semibold ${diverged ? 'text-amber-700' : 'text-slate-900'}`}>
                {effectiveQty} {it.supply.unit}
                {diverged && (
                  <span className="text-slate-400 text-[10px] ml-1">
                    (pediu {it.qtyRequested})
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Notas */}
      {request.note && (
        <div className="text-[11px] text-slate-600 border-t border-slate-100 pt-2">
          <span className="font-semibold text-slate-500">Sua obs:</span> {request.note}
        </div>
      )}
      {request.adminNote && (
        <div className="text-[11px] text-sky-700 bg-sky-50 border border-sky-200 rounded p-2">
          <span className="font-semibold">Matriz:</span> {request.adminNote}
        </div>
      )}
      {request.trackingCode && (
        <div className="text-[11px] text-slate-700 bg-slate-50 border border-slate-200 rounded p-2 flex items-center gap-2">
          <Truck className="w-3.5 h-3.5 text-slate-500" />
          <span>
            {request.carrier ? `${request.carrier} · ` : ''}
            <span className="font-mono font-semibold">{request.trackingCode}</span>
          </span>
        </div>
      )}

      {canCancel && (
        <div className="pt-1 border-t border-slate-100">
          <button
            onClick={cancel}
            disabled={cancelling}
            className="text-xs text-red-600 hover:text-red-700 font-semibold disabled:opacity-50"
          >
            {cancelling ? 'Cancelando…' : 'Cancelar pedido'}
          </button>
        </div>
      )}
    </div>
  );
}

function statusMeta(status: SupplyRequestStatus): {
  label: string;
  color: string;
  icon: React.ReactNode;
} {
  switch (status) {
    case 'pending':
      return { label: 'Pendente', color: 'bg-amber-100 text-amber-800 border-amber-200', icon: <Clock className="w-3 h-3" /> };
    case 'approved':
      return { label: 'Aprovado', color: 'bg-blue-100 text-blue-800 border-blue-200', icon: <CheckCircle2 className="w-3 h-3" /> };
    case 'separating':
      return { label: 'Separando', color: 'bg-violet-100 text-violet-800 border-violet-200', icon: <PlayCircle className="w-3 h-3" /> };
    case 'shipped':
      return { label: 'Enviado', color: 'bg-sky-100 text-sky-800 border-sky-200', icon: <Truck className="w-3 h-3" /> };
    case 'delivered':
      return { label: 'Entregue', color: 'bg-emerald-100 text-emerald-800 border-emerald-200', icon: <PackageCheck className="w-3 h-3" /> };
    case 'cancelled':
      return { label: 'Cancelado', color: 'bg-slate-100 text-slate-600 border-slate-200', icon: <XCircle className="w-3 h-3" /> };
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}
