'use client';

/**
 * /retaguarda/materiais
 *
 * Inbox da matriz para os pedidos de materiais das filiais.
 *
 * Fluxo de status: pending → approved → separating → shipped → delivered
 *                         ↓ cancelled (em qualquer ponto antes de shipped)
 *
 * Cada card mostra:
 *  - Loja que pediu + data + número do pedido
 *  - Lista de itens (qtd pedida / aprovada / enviada — editáveis)
 *  - Botão de próxima transição
 *  - Campo rastreio (habilitado quando vai enviar)
 *  - Observações (filial + matriz)
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Package2, ClipboardList, RefreshCw, Store, Truck, PackageCheck,
  Clock, CheckCircle2, XCircle, PlayCircle, ChevronRight, MessageSquare,
  Filter, Search, Printer,
} from 'lucide-react';
import { api } from '@/lib/api';

type SupplyItem = {
  id: string; sku: string | null; name: string; category: string | null;
  unit: string; description: string | null;
};

type Status = 'pending' | 'approved' | 'separating' | 'shipped' | 'delivered' | 'cancelled';

type SupplyRequest = {
  id: string;
  requestNumber: number;
  status: Status;
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

const STATUS_ORDER: Status[] = ['pending', 'approved', 'separating', 'shipped', 'delivered', 'cancelled'];

export default function MateriaisMatrizPage() {
  const [items, setItems] = useState<SupplyRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<Status | 'all' | 'open'>('open');
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ items: SupplyRequest[] }>('/supplies/requests?limit=300');
      setItems(data.items || []);
    } catch (err: any) {
      const msg = String(err?.message || err);
      setError(msg.includes('403') ? 'Acesso restrito à matriz.' : 'Falha ao carregar pedidos.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (statusFilter === 'open') {
        if (i.status === 'delivered' || i.status === 'cancelled') return false;
      } else if (statusFilter !== 'all' && i.status !== statusFilter) {
        return false;
      }
      if (!q) return true;
      return (
        i.store.name.toLowerCase().includes(q) ||
        i.store.code.toLowerCase().includes(q) ||
        String(i.requestNumber).includes(q) ||
        i.items.some((it) => it.supply.name.toLowerCase().includes(q))
      );
    });
  }, [items, statusFilter, search]);

  const kpis = useMemo(() => {
    const c: Record<string, number> = {};
    items.forEach((i) => { c[i.status] = (c[i.status] || 0) + 1; });
    return {
      pending: c.pending || 0,
      approved: c.approved || 0,
      separating: c.separating || 0,
      shipped: c.shipped || 0,
      delivered: c.delivered || 0,
      cancelled: c.cancelled || 0,
    };
  }, [items]);

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <ClipboardList className="w-6 h-6 text-brand" />
            Pedidos das filiais
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Aprove, separe e envie os materiais solicitados pelas lojas
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-sm flex items-center gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <Kpi label="Pendente" value={kpis.pending} color="bg-amber-50 text-amber-800 border-amber-200" onClick={() => setStatusFilter('pending')} active={statusFilter === 'pending'} />
        <Kpi label="Aprovado" value={kpis.approved} color="bg-blue-50 text-blue-800 border-blue-200" onClick={() => setStatusFilter('approved')} active={statusFilter === 'approved'} />
        <Kpi label="Separando" value={kpis.separating} color="bg-violet-50 text-violet-800 border-violet-200" onClick={() => setStatusFilter('separating')} active={statusFilter === 'separating'} />
        <Kpi label="Enviado" value={kpis.shipped} color="bg-sky-50 text-sky-800 border-sky-200" onClick={() => setStatusFilter('shipped')} active={statusFilter === 'shipped'} />
        <Kpi label="Entregue" value={kpis.delivered} color="bg-emerald-50 text-emerald-800 border-emerald-200" onClick={() => setStatusFilter('delivered')} active={statusFilter === 'delivered'} />
        <Kpi label="Cancelado" value={kpis.cancelled} color="bg-slate-100 text-slate-600 border-slate-200" onClick={() => setStatusFilter('cancelled')} active={statusFilter === 'cancelled'} />
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por loja, nº do pedido ou item…"
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 bg-white focus:border-brand focus:outline-none text-sm"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as any)}
          className="px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm"
        >
          <option value="open">Em aberto (ativos)</option>
          <option value="all">Todos</option>
          <option value="pending">Pendentes</option>
          <option value="approved">Aprovados</option>
          <option value="separating">Separando</option>
          <option value="shipped">Enviados</option>
          <option value="delivered">Entregues</option>
          <option value="cancelled">Cancelados</option>
        </select>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-3 text-sm">{error}</div>
      )}

      {loading && items.length === 0 ? (
        <div className="text-center py-10 text-slate-500 text-sm">Carregando…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <ClipboardList className="w-12 h-12 mx-auto text-slate-300 mb-3" />
          <p className="font-bold text-slate-700">
            {items.length === 0 ? 'Nenhum pedido recebido ainda' : 'Sem pedidos nesse filtro'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((req) => (
            <RequestCard key={req.id} request={req} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function Kpi({
  label, value, color, onClick, active,
}: { label: string; value: number; color: string; onClick?: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border p-2 text-left ${color} ${active ? 'ring-2 ring-brand ring-offset-1' : ''} hover:opacity-90 transition`}
    >
      <div className="text-[10px] font-bold uppercase tracking-wide">{label}</div>
      <div className="text-xl font-bold">{value}</div>
    </button>
  );
}

function RequestCard({ request, onChanged }: { request: SupplyRequest; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(request.status === 'pending' || request.status === 'approved' || request.status === 'separating');
  const meta = statusMeta(request.status);

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      {/* Header */}
      <header
        className="p-3 sm:p-4 flex items-center gap-3 cursor-pointer hover:bg-slate-50"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${meta.color}`}>
              {meta.icon} {meta.label}
            </span>
            <div className="font-bold text-slate-900">
              Pedido #{String(request.requestNumber).padStart(4, '0')}
            </div>
            <div className="text-xs text-slate-500 font-mono">{formatDate(request.createdAt)}</div>
          </div>
          <div className="flex items-center gap-2 mt-1 text-sm text-slate-600">
            <Store className="w-4 h-4 text-slate-400" />
            <span className="font-semibold">{request.store.code}</span>
            <span>—</span>
            <span>{request.store.name}</span>
            <span className="text-slate-400">·</span>
            <span className="text-xs">{request.items.length} item{request.items.length === 1 ? '' : 'ns'}</span>
          </div>
        </div>
        {/* Botão imprimir — não interfere com expand/collapse (stopPropagation) */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            window.open(`/retaguarda/materiais/imprimir/${request.id}`, '_blank', 'noopener');
          }}
          title="Imprimir pedido"
          className="flex items-center gap-1 text-slate-500 hover:text-white hover:bg-slate-700 border border-slate-300 hover:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors"
        >
          <Printer className="w-4 h-4" />
          <span className="hidden sm:inline">Imprimir</span>
        </button>
        <ChevronRight className={`w-5 h-5 text-slate-400 transition ${expanded ? 'rotate-90' : ''}`} />
      </header>

      {expanded && <RequestBody request={request} onChanged={onChanged} />}
    </div>
  );
}

function RequestBody({ request, onChanged }: { request: SupplyRequest; onChanged: () => void }) {
  // Estado local editável das quantidades
  const [draftItems, setDraftItems] = useState(() =>
    request.items.map((it) => ({
      id: it.id,
      qtyApproved: it.qtyApproved ?? it.qtyRequested,
      qtyShipped: it.qtyShipped ?? (it.qtyApproved ?? it.qtyRequested),
    })),
  );
  const [tracking, setTracking] = useState(request.trackingCode || '');
  const [carrier, setCarrier] = useState(request.carrier || 'Correios');
  const [adminNote, setAdminNote] = useState(request.adminNote || '');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = nextTransitions(request.status);

  const transition = async (toStatus: Status) => {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      const body: any = { toStatus };
      // Notas sempre podem ser atualizadas junto
      if (adminNote !== (request.adminNote || '')) body.adminNote = adminNote || null;

      if (toStatus === 'approved') {
        body.items = draftItems.map((d) => ({ id: d.id, qtyApproved: d.qtyApproved }));
      }
      if (toStatus === 'separating' || toStatus === 'shipped') {
        body.items = draftItems.map((d) => ({
          id: d.id,
          qtyApproved: d.qtyApproved,
          qtyShipped: d.qtyShipped,
        }));
      }
      if (toStatus === 'shipped') {
        if (!tracking.trim() && !confirm('Enviar sem código de rastreio?')) {
          setWorking(false);
          return;
        }
        body.trackingCode = tracking.trim() || null;
        body.carrier = carrier.trim() || null;
      }

      await api(`/supplies/requests/${request.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      onChanged();
    } catch (err: any) {
      const msg = String(err?.message || err);
      setError(msg.includes(':') ? msg.split(':').slice(1).join(':').trim() : 'Falha na transição.');
    } finally {
      setWorking(false);
    }
  };

  const setApproved = (id: string, qty: number) => {
    setDraftItems((prev) =>
      prev.map((d) => (d.id === id ? { ...d, qtyApproved: qty, qtyShipped: Math.min(d.qtyShipped, qty) } : d)),
    );
  };
  const setShipped = (id: string, qty: number) => {
    setDraftItems((prev) => prev.map((d) => (d.id === id ? { ...d, qtyShipped: qty } : d)));
  };

  const showApprovedCol = request.status !== 'pending' && request.status !== 'cancelled';
  const showShippedCol = request.status === 'separating' || request.status === 'shipped' || request.status === 'delivered';
  const editApproved = request.status === 'pending';
  const editShipped = request.status === 'separating';

  return (
    <div className="border-t border-slate-200 p-3 sm:p-4 space-y-3 bg-slate-50/50">
      {/* Notas */}
      {request.note && (
        <div className="bg-white border border-slate-200 rounded-lg p-2 text-xs flex items-start gap-2">
          <MessageSquare className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold text-slate-500 text-[10px] uppercase">Obs da loja:</div>
            <div className="text-slate-700 mt-0.5">{request.note}</div>
          </div>
        </div>
      )}

      {/* Tabela itens */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Item</th>
              <th className="text-center px-3 py-2 w-20">Pediu</th>
              {showApprovedCol && <th className="text-center px-3 py-2 w-24">Aprovado</th>}
              {showShippedCol && <th className="text-center px-3 py-2 w-24">Enviado</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {request.items.map((it) => {
              const draft = draftItems.find((d) => d.id === it.id)!;
              return (
                <tr key={it.id}>
                  <td className="px-3 py-2">
                    <div className="font-semibold text-slate-800">{it.supply.name}</div>
                    <div className="text-[11px] text-slate-400">
                      {it.supply.category ? `${it.supply.category} · ` : ''}Unidade: {it.supply.unit}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center font-mono font-semibold text-slate-800">
                    {it.qtyRequested}
                  </td>
                  {showApprovedCol && (
                    <td className="px-3 py-2 text-center">
                      {editApproved ? (
                        <input
                          type="number"
                          min={0}
                          value={draft.qtyApproved}
                          onChange={(e) => setApproved(it.id, parseInt(e.target.value || '0', 10) || 0)}
                          className="w-16 px-2 py-1 border border-slate-300 rounded text-center font-mono focus:border-brand focus:outline-none"
                        />
                      ) : (
                        <span className="font-mono font-semibold">{it.qtyApproved ?? draft.qtyApproved}</span>
                      )}
                    </td>
                  )}
                  {showShippedCol && (
                    <td className="px-3 py-2 text-center">
                      {editShipped ? (
                        <input
                          type="number"
                          min={0}
                          max={draft.qtyApproved}
                          value={draft.qtyShipped}
                          onChange={(e) => setShipped(it.id, parseInt(e.target.value || '0', 10) || 0)}
                          className="w-16 px-2 py-1 border border-slate-300 rounded text-center font-mono focus:border-brand focus:outline-none"
                        />
                      ) : (
                        <span className="font-mono font-semibold">{it.qtyShipped ?? 0}</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Rastreio (quando vai enviar) */}
      {(request.status === 'separating' || request.status === 'shipped') && (
        <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
          <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500 flex items-center gap-1">
            <Truck className="w-3.5 h-3.5" /> Rastreio
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input
              type="text"
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
              placeholder="Transportadora (Correios, Jadlog…)"
              className="col-span-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:border-brand focus:outline-none"
              disabled={request.status === 'shipped'}
            />
            <input
              type="text"
              value={tracking}
              onChange={(e) => setTracking(e.target.value.toUpperCase())}
              placeholder="Código de rastreio"
              className="col-span-2 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:border-brand focus:outline-none font-mono"
              disabled={request.status === 'shipped'}
            />
          </div>
          {request.status === 'shipped' && request.shippedAt && (
            <div className="text-[11px] text-slate-500">
              Enviado em {formatDate(request.shippedAt)}
            </div>
          )}
        </div>
      )}

      {/* Obs matriz */}
      {request.status !== 'delivered' && request.status !== 'cancelled' && (
        <textarea
          value={adminNote}
          onChange={(e) => setAdminNote(e.target.value)}
          placeholder="Observação da matriz (opcional)…"
          rows={2}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none focus:border-brand focus:outline-none"
        />
      )}
      {request.adminNote && (request.status === 'delivered' || request.status === 'cancelled') && (
        <div className="bg-sky-50 border border-sky-200 rounded-lg p-2 text-xs">
          <div className="font-semibold text-sky-700 text-[10px] uppercase">Matriz:</div>
          <div className="text-sky-900 mt-0.5">{request.adminNote}</div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-2 text-xs">{error}</div>
      )}

      {/* Ações */}
      {next.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {next.map((to) => (
            <TransitionButton
              key={to}
              toStatus={to}
              onClick={() => transition(to)}
              disabled={working}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TransitionButton({
  toStatus, onClick, disabled,
}: { toStatus: Status; onClick: () => void; disabled: boolean }) {
  const meta = transitionMeta(toStatus);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2.5 rounded-lg font-bold text-sm flex items-center gap-2 shadow ${meta.color} disabled:opacity-50`}
    >
      {meta.icon}
      {meta.label}
    </button>
  );
}

// ============================================
// Helpers
// ============================================

function nextTransitions(status: Status): Status[] {
  switch (status) {
    case 'pending':    return ['approved', 'cancelled'];
    case 'approved':   return ['separating', 'cancelled'];
    case 'separating': return ['shipped', 'cancelled'];
    case 'shipped':    return ['delivered'];
    default: return [];
  }
}

function transitionMeta(s: Status): { label: string; icon: React.ReactNode; color: string } {
  switch (s) {
    case 'approved':
      return { label: 'Aprovar pedido', icon: <CheckCircle2 className="w-4 h-4" />, color: 'bg-blue-600 hover:bg-blue-700 text-white' };
    case 'separating':
      return { label: 'Iniciar separação', icon: <PlayCircle className="w-4 h-4" />, color: 'bg-violet-600 hover:bg-violet-700 text-white' };
    case 'shipped':
      return { label: 'Marcar como enviado', icon: <Truck className="w-4 h-4" />, color: 'bg-sky-600 hover:bg-sky-700 text-white' };
    case 'delivered':
      return { label: 'Confirmar entrega', icon: <PackageCheck className="w-4 h-4" />, color: 'bg-emerald-600 hover:bg-emerald-700 text-white' };
    case 'cancelled':
      return { label: 'Cancelar', icon: <XCircle className="w-4 h-4" />, color: 'bg-slate-200 hover:bg-slate-300 text-slate-700' };
    default:
      return { label: s, icon: null, color: 'bg-slate-200 text-slate-700' };
  }
}

function statusMeta(status: Status): { label: string; color: string; icon: React.ReactNode } {
  switch (status) {
    case 'pending':    return { label: 'Pendente',   color: 'bg-amber-100 text-amber-800 border-amber-200',   icon: <Clock className="w-3 h-3" /> };
    case 'approved':   return { label: 'Aprovado',   color: 'bg-blue-100 text-blue-800 border-blue-200',     icon: <CheckCircle2 className="w-3 h-3" /> };
    case 'separating': return { label: 'Separando',  color: 'bg-violet-100 text-violet-800 border-violet-200', icon: <PlayCircle className="w-3 h-3" /> };
    case 'shipped':    return { label: 'Enviado',    color: 'bg-sky-100 text-sky-800 border-sky-200',         icon: <Truck className="w-3 h-3" /> };
    case 'delivered':  return { label: 'Entregue',   color: 'bg-emerald-100 text-emerald-800 border-emerald-200', icon: <PackageCheck className="w-3 h-3" /> };
    case 'cancelled':  return { label: 'Cancelado',  color: 'bg-slate-100 text-slate-600 border-slate-200',   icon: <XCircle className="w-3 h-3" /> };
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}
