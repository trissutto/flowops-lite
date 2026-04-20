'use client';

/**
 * /retaguarda/baixa-estoque
 *
 * Fila de pick-orders aguardando aprovação da baixa de estoque.
 * Fluxo:
 *   filial bipa 100% → status `separated` → aparece aqui
 *   operadora matriz revisa itens + dados da cliente
 *   → clica "Dar baixa (SHADOW)" → status `ready` → loja libera botão Enviar
 *
 * MODO SHADOW: backend apenas loga a intenção de baixa em integration_logs.
 * NÃO toca no Gigasistemas ainda. Operadora continua fazendo baixa manual no PDV SITE.
 * Quando a comparação (log × PDV) estiver estável por 2+ semanas, plugamos a call real.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Clock, Package, Store, User, X } from 'lucide-react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';

interface PendingItem {
  id: string;
  sku: string;
  productName: string | null;
  quantity: number;
  unitPrice: number | null;
}

interface PendingRow {
  id: string;
  status: 'separated';
  createdAt: string;
  updatedAt: string;
  waitingMinutes: number;
  store: { id: string; code: string; name: string | null; city: string | null };
  order: {
    id: string;
    wcOrderId: number;
    wcOrderNumber: string | null;
    customerName: string | null;
    customerCpf: string | null;
    customerEmail: string | null;
    customerPhone: string | null;
    shippingCep: string | null;
    totalAmount: number | null;
  };
  items: PendingItem[];
}

export default function BaixaEstoquePage() {
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PendingRow | null>(null);
  const [action, setAction] = useState<'approve' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await api<PendingRow[]>('/pick-orders/pending-approval');
      setRows(data);
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar fila');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Socket: sempre que qualquer pick-order muda status, recarrega a fila
  useEffect(() => {
    const sock = getSocket();
    const handler = () => load();
    sock.on('pick-order:status', handler);
    return () => {
      sock.off('pick-order:status', handler);
    };
  }, [load]);

  function openApprove(row: PendingRow) {
    setSelected(row);
    setAction('approve');
    setReason('');
  }

  function openReject(row: PendingRow) {
    setSelected(row);
    setAction('reject');
    setReason('');
  }

  function closeModal() {
    if (submitting) return;
    setSelected(null);
    setAction(null);
    setReason('');
  }

  async function confirm() {
    if (!selected || !action) return;
    setSubmitting(true);
    try {
      if (action === 'approve') {
        await api(`/pick-orders/${selected.id}/approve-debit`, { method: 'POST' });
      } else {
        await api(`/pick-orders/${selected.id}/reject-debit`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
      }
      setRows((prev) => prev.filter((r) => r.id !== selected.id));
      closeModal();
    } catch (e: any) {
      alert(e.message || 'Erro ao processar');
    } finally {
      setSubmitting(false);
    }
  }

  const totalPending = rows.length;
  const oldest = useMemo(
    () => (rows.length ? Math.max(...rows.map((r) => r.waitingMinutes)) : 0),
    [rows],
  );

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="flex items-baseline justify-between mb-2">
        <h1 className="text-3xl font-bold">Baixa de estoque — Retaguarda</h1>
        <button
          onClick={load}
          className="text-sm text-gray-600 hover:text-gray-900 underline"
        >
          Atualizar
        </button>
      </div>

      {/* Banner shadow mode — critico não esconder */}
      <div className="bg-amber-50 border-l-4 border-amber-400 p-4 rounded mb-4">
        <div className="flex gap-3">
          <AlertTriangle className="text-amber-600 flex-shrink-0 mt-0.5" size={22} />
          <div className="text-sm text-amber-900">
            <strong>Modo Shadow ativo.</strong> Ao aprovar, o sistema apenas registra a intenção
            de baixa em log de auditoria — <strong>não</strong> baixa no Gigasistemas ainda.
            Continue fazendo a venda no PDV SITE como de costume. Quando a comparação
            (log × PDV) estiver consistente, ativamos a baixa automática.
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs uppercase text-gray-500">Pick-orders na fila</div>
          <div className="text-3xl font-bold mt-1">{totalPending}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs uppercase text-gray-500">Mais antigo aguardando</div>
          <div className="text-3xl font-bold mt-1">
            {oldest > 0 ? `${oldest} min` : '—'}
          </div>
        </div>
      </div>

      {loading && <div className="text-gray-500">Carregando fila…</div>}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm">
          {error}
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div className="bg-white rounded-lg shadow p-12 text-center text-gray-500">
          <CheckCircle2 className="mx-auto text-green-500 mb-3" size={48} />
          Nenhum pick-order aguardando baixa. Fila zerada.
        </div>
      )}

      {/* Lista */}
      <div className="space-y-3">
        {rows.map((r) => {
          const totalItems = r.items.reduce((s, i) => s + i.quantity, 0);
          const urgent = r.waitingMinutes >= 30;
          return (
            <div
              key={r.id}
              className={`bg-white rounded-lg shadow border-l-4 p-4 ${
                urgent ? 'border-red-500' : 'border-purple-500'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-3 mb-2">
                    <div className="flex items-center gap-1 text-sm font-semibold">
                      <Store size={16} className="text-gray-500" />
                      {r.store.code} — {r.store.name || r.store.city || '—'}
                    </div>
                    <div className="text-sm text-gray-500">
                      Pedido WC #{r.order.wcOrderNumber || r.order.wcOrderId}
                    </div>
                    <div
                      className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded ${
                        urgent
                          ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      <Clock size={12} /> {r.waitingMinutes} min
                    </div>
                  </div>

                  <div className="flex items-center gap-1 text-sm text-gray-700 mb-2">
                    <User size={14} className="text-gray-500" />
                    {r.order.customerName || '—'}
                    {r.order.customerCpf ? ` · CPF ${r.order.customerCpf}` : ''}
                  </div>

                  <div className="flex items-center gap-1 text-sm text-gray-700">
                    <Package size={14} className="text-gray-500" />
                    {r.items.length} SKU{r.items.length === 1 ? '' : 's'} · {totalItems}{' '}
                    peça{totalItems === 1 ? '' : 's'}
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => openReject(r)}
                    className="px-3 py-2 text-sm rounded border border-red-300 text-red-700 hover:bg-red-50"
                  >
                    Rejeitar
                  </button>
                  <button
                    onClick={() => openApprove(r)}
                    className="px-4 py-2 text-sm font-semibold rounded bg-green-600 text-white hover:bg-green-700"
                  >
                    Revisar &amp; dar baixa
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Modal review / confirm */}
      {selected && action && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={closeModal}
        >
          <div
            className="bg-white rounded-t-xl sm:rounded-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-white border-b p-4 flex items-center justify-between">
              <div>
                <div className="text-xs text-gray-500">
                  Pedido WC #{selected.order.wcOrderNumber || selected.order.wcOrderId} ·{' '}
                  {selected.store.code}
                </div>
                <div className="text-lg font-bold">
                  {action === 'approve' ? 'Revisar baixa de estoque' : 'Rejeitar baixa'}
                </div>
              </div>
              <button
                onClick={closeModal}
                disabled={submitting}
                className="p-1 hover:bg-gray-100 rounded disabled:opacity-50"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Cliente */}
              <section>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Cliente</h3>
                <div className="bg-gray-50 rounded p-3 text-sm space-y-1">
                  <div>
                    <strong>{selected.order.customerName || '—'}</strong>
                  </div>
                  {selected.order.customerCpf && (
                    <div className="text-gray-600">CPF: {selected.order.customerCpf}</div>
                  )}
                  {selected.order.customerEmail && (
                    <div className="text-gray-600">{selected.order.customerEmail}</div>
                  )}
                  {selected.order.customerPhone && (
                    <div className="text-gray-600">{selected.order.customerPhone}</div>
                  )}
                  {selected.order.shippingCep && (
                    <div className="text-gray-600">CEP: {selected.order.shippingCep}</div>
                  )}
                  {selected.order.totalAmount != null && (
                    <div className="text-gray-600">
                      Total pedido: R${' '}
                      {Number(selected.order.totalAmount).toFixed(2).replace('.', ',')}
                    </div>
                  )}
                </div>
              </section>

              {/* Itens */}
              <section>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">
                  Itens a baixar ({selected.items.length} SKU
                  {selected.items.length === 1 ? '' : 's'})
                </h3>
                <div className="border rounded overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                      <tr>
                        <th className="text-left px-3 py-2">SKU</th>
                        <th className="text-left px-3 py-2">Produto</th>
                        <th className="text-right px-3 py-2">Qtd</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.items.map((i) => (
                        <tr key={i.id} className="border-t">
                          <td className="px-3 py-2 font-mono">{i.sku}</td>
                          <td className="px-3 py-2 text-gray-700">{i.productName || '—'}</td>
                          <td className="px-3 py-2 text-right font-semibold">{i.quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {action === 'reject' && (
                <section>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">
                    Motivo da rejeição (opcional)
                  </label>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                    placeholder="Ex: divergência na contagem, produto avariado…"
                    className="w-full border rounded p-2 text-sm"
                  />
                  <div className="text-xs text-gray-500 mt-1">
                    A loja volta pro status "Separando" e precisa bipar de novo.
                  </div>
                </section>
              )}

              {action === 'approve' && (
                <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-900">
                  <strong>Shadow mode:</strong> clicar em confirmar só registra a intenção
                  em log e libera a loja pra postar. Baixa no Gigasistemas continua manual
                  pelo PDV SITE.
                </div>
              )}
            </div>

            <div className="sticky bottom-0 bg-white border-t p-4 flex justify-end gap-2">
              <button
                onClick={closeModal}
                disabled={submitting}
                className="px-4 py-2 text-sm rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={confirm}
                disabled={submitting}
                className={`px-4 py-2 text-sm font-semibold rounded text-white flex items-center gap-2 disabled:opacity-50 ${
                  action === 'approve'
                    ? 'bg-green-600 hover:bg-green-700'
                    : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                {action === 'approve' ? <Check size={16} /> : <X size={16} />}
                {submitting
                  ? 'Processando…'
                  : action === 'approve'
                  ? 'Confirmar baixa (Shadow)'
                  : 'Confirmar rejeição'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
