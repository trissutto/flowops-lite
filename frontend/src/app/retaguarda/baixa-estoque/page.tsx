'use client';
import { overlayClose } from '@/lib/overlayClose';

/**
 * /retaguarda/baixa-estoque
 *
 * Fila de pick-orders aguardando aprovação da baixa de estoque.
 * Fluxo:
 *   filial bipa 100% → status `separated` → aparece aqui
 *   operadora matriz revisa itens + dados da cliente
 *   → clica "Dar baixa" → backend executa modo (SHADOW ou LIVE)
 *   → pode revisar 1 por 1 OU selecionar vários e dar baixa em massa
 *
 * MODO dinâmico — controlado pelo backend (env var ERP_WRITE_ENABLED):
 *   SHADOW → só loga intenção em integration_logs (NÃO toca no Gigasistemas)
 *   LIVE   → UPDATE estoque -1 no Gigasistemas dentro de transação ACID
 *
 * Frontend pergunta `/pick-orders/erp-mode` no load e ajusta banner/botões/modal.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Check, CheckCircle2, CheckSquare, Clock, Package, Square,
  Store, User, X, Zap,
} from 'lucide-react';
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

interface BulkResult {
  approved: Array<{ id: string; itemsCount: number }>;
  skipped: Array<{ id: string; reason: string }>;
  errors: Array<{ id: string; error: string }>;
  total: number;
}

export default function BaixaEstoquePage() {
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PendingRow | null>(null);
  const [action, setAction] = useState<'approve' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Seleção em massa
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);

  // Modo do ERP (shadow vs live) — descoberto em runtime
  const [writeEnabled, setWriteEnabled] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await api<PendingRow[]>('/pick-orders/pending-approval');
      setRows(data);
      // Limpa seleção pra IDs que sumiram da lista
      setCheckedIds((prev) => {
        const next = new Set<string>();
        const valid = new Set(data.map((r) => r.id));
        for (const id of prev) if (valid.has(id)) next.add(id);
        return next;
      });
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar fila');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Descobre modo do ERP — só faz uma vez (env não muda em runtime)
  useEffect(() => {
    api<{ writeEnabled: boolean }>('/pick-orders/erp-mode')
      .then((r) => setWriteEnabled(!!r.writeEnabled))
      .catch(() => setWriteEnabled(false)); // fallback conservador: assume shadow
  }, []);

  // Socket: sempre que qualquer pick-order muda status, recarrega a fila
  useEffect(() => {
    const sock = getSocket();
    const handler = () => load();
    sock.on('pick-order:status', handler);
    return () => {
      sock.off('pick-order:status', handler);
    };
  }, [load]);

  function toggleRow(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allVisibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const allSelected = allVisibleIds.length > 0 && allVisibleIds.every((id) => checkedIds.has(id));
  const someSelected = checkedIds.size > 0 && !allSelected;

  function toggleAll() {
    if (allSelected) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(allVisibleIds));
    }
  }

  function clearSelection() {
    setCheckedIds(new Set());
  }

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
      setCheckedIds((prev) => {
        const next = new Set(prev);
        next.delete(selected.id);
        return next;
      });
      closeModal();
    } catch (e: any) {
      alert(e.message || 'Erro ao processar');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Bulk approve ────────────────────────────────────────────
  async function runBulkApprove() {
    const ids = Array.from(checkedIds);
    if (ids.length === 0) return;
    setBulkSubmitting(true);
    setBulkResult(null);
    try {
      const res = await api<BulkResult>('/pick-orders/bulk-approve-debit', {
        method: 'POST',
        body: JSON.stringify({ pickOrderIds: ids }),
      });
      setBulkResult(res);
      // Remove da lista os que foram aprovados + os que foram "skipped" (já aprovados antes)
      const doneIds = new Set<string>([
        ...res.approved.map((a) => a.id),
        ...res.skipped.map((s) => s.id),
      ]);
      setRows((prev) => prev.filter((r) => !doneIds.has(r.id)));
      setCheckedIds((prev) => {
        const next = new Set<string>();
        for (const id of prev) if (!doneIds.has(id)) next.add(id);
        return next;
      });
    } catch (e: any) {
      alert(e.message || 'Erro ao processar baixa em massa');
    } finally {
      setBulkSubmitting(false);
    }
  }

  function closeBulkConfirm() {
    if (bulkSubmitting) return;
    setBulkConfirmOpen(false);
    // Só limpa o resultado ao fechar se já terminou
    if (!bulkSubmitting && bulkResult) {
      setBulkResult(null);
    }
  }

  const totalPending = rows.length;
  const oldest = useMemo(
    () => (rows.length ? Math.max(...rows.map((r) => r.waitingMinutes)) : 0),
    [rows],
  );
  const selectedCount = checkedIds.size;
  const selectedRows = useMemo(
    () => rows.filter((r) => checkedIds.has(r.id)),
    [rows, checkedIds],
  );
  const selectedPieces = useMemo(
    () =>
      selectedRows.reduce(
        (s, r) => s + r.items.reduce((a, i) => a + i.quantity, 0),
        0,
      ),
    [selectedRows],
  );

  return (
    <div className="max-w-7xl mx-auto p-6 pb-28">
      <div className="flex items-baseline justify-between mb-2">
        <h1 className="text-3xl font-bold">Baixa de estoque — Retaguarda</h1>
        <button
          onClick={load}
          className="text-sm text-gray-600 hover:text-gray-900 underline"
        >
          Atualizar
        </button>
      </div>

      {/* Banner do modo — muda com base em /pick-orders/erp-mode */}
      {writeEnabled === true ? (
        <div className="bg-emerald-50 border-l-4 border-emerald-500 p-4 rounded mb-4">
          <div className="flex gap-3">
            <Zap className="text-emerald-600 flex-shrink-0 mt-0.5" size={22} />
            <div className="text-sm text-emerald-900">
              <strong>Modo LIVE ativo.</strong> Ao aprovar, o sistema baixa o estoque
              <strong> direto no Gigasistemas</strong> (UPDATE estoque -1 por SKU).
              <strong> Não passe esses pedidos no PDV SITE</strong> — vai dar baixa duplicada.
              Cada baixa é gravada em log de auditoria com estoque antes/depois.
            </div>
          </div>
        </div>
      ) : writeEnabled === false ? (
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
      ) : null}

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
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
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs uppercase text-gray-500">Selecionados</div>
          <div className="text-3xl font-bold mt-1 text-green-700">{selectedCount}</div>
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

      {/* Toolbar de seleção — só aparece se houver pedidos */}
      {!loading && !error && rows.length > 0 && (
        <div className="bg-white rounded-lg shadow px-4 py-3 mb-3 flex items-center gap-3 flex-wrap">
          <button
            onClick={toggleAll}
            className="flex items-center gap-2 px-3 py-2 rounded border border-gray-300 hover:bg-gray-50 text-sm font-medium"
            title={allSelected ? 'Desmarcar todos' : 'Selecionar todos'}
          >
            {allSelected ? (
              <CheckSquare size={18} className="text-green-600" />
            ) : someSelected ? (
              <CheckSquare size={18} className="text-gray-400" />
            ) : (
              <Square size={18} className="text-gray-400" />
            )}
            {allSelected ? 'Desmarcar todos' : 'Selecionar todos'}
          </button>

          <div className="text-sm text-gray-600">
            {selectedCount === 0
              ? 'Nenhum selecionado'
              : `${selectedCount} selecionado${selectedCount === 1 ? '' : 's'} · ${selectedPieces} peça${selectedPieces === 1 ? '' : 's'}`}
          </div>

          {selectedCount > 0 && (
            <>
              <button
                onClick={clearSelection}
                className="text-xs text-gray-500 hover:text-gray-800 underline ml-auto"
              >
                Limpar seleção
              </button>
              <button
                onClick={() => setBulkConfirmOpen(true)}
                className="px-4 py-2 text-sm font-bold rounded bg-green-600 text-white hover:bg-green-700 flex items-center gap-2 shadow"
              >
                <Zap size={16} />
                Dar baixa em {selectedCount}
              </button>
            </>
          )}
        </div>
      )}

      {/* Lista */}
      <div className="space-y-3">
        {rows.map((r) => {
          const totalItems = r.items.reduce((s, i) => s + i.quantity, 0);
          const urgent = r.waitingMinutes >= 30;
          const isChecked = checkedIds.has(r.id);
          return (
            <div
              key={r.id}
              className={`bg-white rounded-lg shadow border-l-4 p-4 transition ${
                urgent ? 'border-red-500' : 'border-purple-500'
              } ${isChecked ? 'ring-2 ring-green-400 bg-green-50/30' : ''}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  {/* Checkbox de seleção */}
                  <button
                    onClick={() => toggleRow(r.id)}
                    className="mt-1 p-1 rounded hover:bg-gray-100"
                    title={isChecked ? 'Desmarcar' : 'Selecionar'}
                  >
                    {isChecked ? (
                      <CheckSquare size={22} className="text-green-600" />
                    ) : (
                      <Square size={22} className="text-gray-400" />
                    )}
                  </button>

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

      {/* Barra fixa inferior — atalho sempre visível quando há seleção */}
      {selectedCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-lg z-40">
          <div className="max-w-7xl mx-auto p-3 flex items-center justify-between gap-3">
            <div className="text-sm">
              <strong className="text-green-700 text-lg">{selectedCount}</strong>{' '}
              pedido{selectedCount === 1 ? '' : 's'} selecionado{selectedCount === 1 ? '' : 's'}
              <span className="text-gray-500"> · {selectedPieces} peça{selectedPieces === 1 ? '' : 's'}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={clearSelection}
                className="text-sm text-gray-600 hover:text-gray-900 px-3 py-2"
              >
                Limpar
              </button>
              <button
                onClick={() => setBulkConfirmOpen(true)}
                className="px-5 py-3 text-sm font-bold rounded bg-green-600 text-white hover:bg-green-700 flex items-center gap-2 shadow"
              >
                <Zap size={16} />
                Dar baixa em {selectedCount}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal review / confirm individual */}
      {selected && action && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          {...overlayClose(closeModal)}
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
                  <div className="overflow-x-auto">
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

              {action === 'approve' && writeEnabled === true && (
                <div className="bg-emerald-50 border border-emerald-300 rounded p-3 text-sm text-emerald-900">
                  <strong>Modo LIVE:</strong> ao confirmar, o sistema vai aplicar
                  <strong> UPDATE estoque -1</strong> direto no Gigasistemas, dentro de
                  uma transação ACID. Se algum SKU ficar com estoque negativo, a operação
                  inteira é abortada (rollback). <strong>Não passe esse pedido no PDV SITE.</strong>
                </div>
              )}
              {action === 'approve' && writeEnabled === false && (
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
                  ? writeEnabled
                    ? 'Confirmar baixa REAL no Giga'
                    : 'Confirmar baixa (Shadow)'
                  : 'Confirmar rejeição'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal bulk approve — confirmação + resultado */}
      {bulkConfirmOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          {...overlayClose(closeBulkConfirm)}
        >
          <div
            className="bg-white rounded-t-xl sm:rounded-xl w-full max-w-2xl max-h-[92vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-white border-b p-4 flex items-center justify-between">
              <div>
                <div className="text-xs text-gray-500">Baixa em massa</div>
                <div className="text-lg font-bold flex items-center gap-2">
                  <Zap size={18} className="text-green-600" />
                  {bulkResult ? 'Baixa concluída' : `Aprovar ${selectedCount} pedidos`}
                </div>
              </div>
              <button
                onClick={closeBulkConfirm}
                disabled={bulkSubmitting}
                className="p-1 hover:bg-gray-100 rounded disabled:opacity-50"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {!bulkResult && (
                <>
                  {writeEnabled === true ? (
                    <div className="bg-emerald-50 border border-emerald-300 rounded p-3 text-sm text-emerald-900">
                      <strong>Modo LIVE:</strong> vai aplicar <strong>UPDATE estoque -1</strong>{' '}
                      direto no Gigasistemas pra cada SKU dos{' '}
                      <strong>{selectedCount}</strong> pedidos. Cada pedido roda em transação
                      própria (se um falhar, os outros seguem). <strong>Não passe esses pedidos
                      no PDV SITE</strong> — vai dar baixa duplicada.
                    </div>
                  ) : (
                    <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-900">
                      <strong>Shadow mode:</strong> vai gravar a intenção de baixa dos{' '}
                      <strong>{selectedCount}</strong> pedidos em log e liberar as lojas pra postar.{' '}
                      <strong>Nenhum estoque é baixado no Gigasistemas.</strong>
                    </div>
                  )}

                  <div>
                    <h3 className="text-sm font-semibold text-gray-700 mb-2">
                      Pedidos que serão aprovados
                    </h3>
                    <div className="border rounded overflow-hidden max-h-72 overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-xs uppercase text-gray-500 sticky top-0">
                          <tr>
                            <th className="text-left px-3 py-2">Pedido</th>
                            <th className="text-left px-3 py-2">Loja</th>
                            <th className="text-left px-3 py-2">Cliente</th>
                            <th className="text-right px-3 py-2">Peças</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedRows.map((r) => {
                            const pieces = r.items.reduce((s, i) => s + i.quantity, 0);
                            return (
                              <tr key={r.id} className="border-t">
                                <td className="px-3 py-2 font-mono">
                                  #{r.order.wcOrderNumber || r.order.wcOrderId}
                                </td>
                                <td className="px-3 py-2 text-gray-700">{r.store.code}</td>
                                <td className="px-3 py-2 text-gray-700 truncate max-w-[14rem]">
                                  {r.order.customerName || '—'}
                                </td>
                                <td className="px-3 py-2 text-right font-semibold">{pieces}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}

              {bulkResult && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="bg-green-50 border border-green-200 rounded p-3">
                      <div className="text-xs uppercase text-green-700">Aprovados</div>
                      <div className="text-2xl font-bold text-green-800 mt-1">
                        {bulkResult.approved.length}
                      </div>
                    </div>
                    <div className="bg-gray-50 border border-gray-200 rounded p-3">
                      <div className="text-xs uppercase text-gray-600">Já aprovados</div>
                      <div className="text-2xl font-bold text-gray-700 mt-1">
                        {bulkResult.skipped.length}
                      </div>
                    </div>
                    <div className="bg-red-50 border border-red-200 rounded p-3">
                      <div className="text-xs uppercase text-red-700">Erros</div>
                      <div className="text-2xl font-bold text-red-800 mt-1">
                        {bulkResult.errors.length}
                      </div>
                    </div>
                  </div>

                  {bulkResult.errors.length > 0 && (
                    <div className="border border-red-200 rounded p-3 bg-red-50">
                      <div className="text-sm font-semibold text-red-900 mb-1">
                        Pedidos com erro — revisar manualmente
                      </div>
                      <ul className="text-xs text-red-800 space-y-1 max-h-32 overflow-y-auto">
                        {bulkResult.errors.map((e) => (
                          <li key={e.id} className="font-mono">
                            {e.id.slice(0, 8)}… — {e.error}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {bulkResult.skipped.length > 0 && (
                    <div className="border border-gray-200 rounded p-3 bg-gray-50">
                      <div className="text-sm font-semibold text-gray-800 mb-1">
                        Pedidos ignorados (já aprovados ou status inválido)
                      </div>
                      <ul className="text-xs text-gray-700 space-y-1 max-h-24 overflow-y-auto">
                        {bulkResult.skipped.map((s) => (
                          <li key={s.id} className="font-mono">
                            {s.id.slice(0, 8)}… — {s.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="sticky bottom-0 bg-white border-t p-4 flex justify-end gap-2">
              {!bulkResult ? (
                <>
                  <button
                    onClick={closeBulkConfirm}
                    disabled={bulkSubmitting}
                    className="px-4 py-2 text-sm rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={runBulkApprove}
                    disabled={bulkSubmitting || selectedCount === 0}
                    className="px-5 py-2 text-sm font-bold rounded bg-green-600 text-white hover:bg-green-700 flex items-center gap-2 disabled:opacity-50"
                  >
                    <Zap size={16} />
                    {bulkSubmitting
                      ? `Aprovando ${selectedCount}…`
                      : writeEnabled
                      ? `Baixar REAL ${selectedCount} pedidos no Giga`
                      : `Confirmar baixa de ${selectedCount} pedidos (Shadow)`}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => {
                    setBulkResult(null);
                    setBulkConfirmOpen(false);
                  }}
                  className="px-4 py-2 text-sm font-semibold rounded bg-slate-900 text-white hover:bg-black"
                >
                  Fechar
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
