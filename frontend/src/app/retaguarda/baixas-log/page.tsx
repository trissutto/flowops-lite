'use client';

/**
 * /retaguarda/baixas-log
 *
 * Auditoria de baixas de estoque (integration_logs).
 *
 * Motivação: quando matriz aprova baixa na tela /baixa-estoque, o pick-order
 * sai da fila e a informação "some". Se a baixa não refletir no Gigasistemas,
 * operadora fica cega. Essa tela devolve a visibilidade — mostra exatamente o
 * que foi tentado, o modo (REAL vs SHADOW), o resultado e o antes/depois do
 * estoque por SKU.
 *
 * Eventos observados:
 *   debit.real.applied   → LIVE deu certo (mostra applied[])
 *   debit.real.failed    → LIVE falhou (mostra error)
 *   debit.approved.shadow→ SHADOW (não tocou ERP — precisa PDV manual)
 *   debit.bulk-approved.*→ batch agregado (soma dos individuais)
 *
 * Permissão: só admin/operator (matriz). Rota protegida no backend também.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, CheckCircle2, ChevronRight, Clock, Database, Filter, Loader2,
  Package, RefreshCw, RotateCcw, Search, Store as StoreIcon, X, XCircle, Zap,
} from 'lucide-react';
import { api } from '@/lib/api';

// ===========================================================================
// Types
// ===========================================================================

interface LogRow {
  id: number;
  source: string;
  direction: string;
  event: string;
  status: number | null;
  error: string | null;
  createdAt: string;
  storeCode: string | null;
  pickOrderId: string | null;
  approvedBy: string | null;
  itemsCount: number | null;
  appliedCount: number | null;
  payloadPreview: string;
}

interface ListResp {
  rows: LogRow[];
  total: number;
  limit: number;
  offset: number;
}

interface DetailResp extends LogRow {
  payload: any; // parsed JSON do payload (ou string crua se não for JSON)
}

interface StatsBucket {
  total: number;
  success: number;
  failed: number;
  shadow: number;
}

interface StatsResp {
  last24h: StatsBucket;
  last7d: StatsBucket;
}

type StatusFilter = 'all' | 'success' | 'failed';
type ModeFilter = 'all' | 'real' | 'shadow';

// ===========================================================================
// Helpers de classificação de event
// ===========================================================================

function eventKind(event: string): {
  kind: 'real-ok' | 'real-fail' | 'shadow' | 'bulk-real' | 'bulk-shadow' | 'other';
  label: string;
  color: string;
} {
  if (event === 'debit.real.applied') return { kind: 'real-ok', label: 'LIVE OK', color: 'bg-green-100 text-green-800 border-green-300' };
  if (event === 'debit.real.failed') return { kind: 'real-fail', label: 'LIVE FALHOU', color: 'bg-red-100 text-red-800 border-red-300' };
  if (event === 'debit.approved.shadow') return { kind: 'shadow', label: 'SHADOW', color: 'bg-amber-100 text-amber-800 border-amber-300' };
  if (event === 'debit.bulk-approved.real') return { kind: 'bulk-real', label: 'BATCH LIVE', color: 'bg-blue-100 text-blue-800 border-blue-300' };
  if (event === 'debit.bulk-approved.shadow') return { kind: 'bulk-shadow', label: 'BATCH SHADOW', color: 'bg-amber-100 text-amber-800 border-amber-300' };
  return { kind: 'other', label: event, color: 'bg-gray-100 text-gray-700 border-gray-300' };
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// ===========================================================================
// Page
// ===========================================================================

export default function BaixasLogPage() {
  // filtros
  const [status, setStatus] = useState<StatusFilter>('all');
  const [mode, setMode] = useState<ModeFilter>('all');
  const [storeCode, setStoreCode] = useState('');
  const [q, setQ] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // dados
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<StatsResp | null>(null);

  // detalhe (modal)
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailResp | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // reabertura
  const [reopening, setReopening] = useState(false);
  const [bulkReopenResult, setBulkReopenResult] = useState<string | null>(null);

  // paginação
  const [offset, setOffset] = useState(0);
  const limit = 100;

  // -----------------------------------------------------------------------
  // Fetch
  // -----------------------------------------------------------------------

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set('eventPrefix', 'debit.');
      qs.set('limit', String(limit));
      qs.set('offset', String(offset));
      if (status !== 'all') qs.set('status', status);
      if (storeCode.trim()) qs.set('storeCode', storeCode.trim());
      if (q.trim()) qs.set('q', q.trim());
      if (dateFrom) qs.set('from', new Date(dateFrom).toISOString());
      if (dateTo) {
        // Se usuário escolheu 2026-04-22, inclui até 23:59:59 daquele dia
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        qs.set('to', end.toISOString());
      }

      const resp = await api<ListResp>(`/integration-logs?${qs.toString()}`);
      // Filtro `mode` é aplicado no cliente pra evitar regex no backend
      let filtered = resp.rows;
      if (mode === 'real') filtered = filtered.filter((r) => r.event.includes('real'));
      else if (mode === 'shadow') filtered = filtered.filter((r) => r.event.includes('shadow'));

      setRows(filtered);
      setTotal(resp.total);
    } catch (e: any) {
      setError(String(e?.message ?? 'Erro ao carregar'));
    } finally {
      setLoading(false);
    }
  }, [status, mode, storeCode, q, dateFrom, dateTo, offset]);

  const loadStats = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ eventPrefix: 'debit.' });
      const resp = await api<StatsResp>(`/integration-logs/stats?${qs.toString()}`);
      setStats(resp);
    } catch {
      setStats(null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // -----------------------------------------------------------------------
  // Detail modal
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (selectedId == null) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    api<DetailResp>(`/integration-logs/${selectedId}`)
      .then((r) => setDetail(r))
      .catch((e) => setError(String(e?.message ?? 'Erro ao carregar detalhe')))
      .finally(() => setDetailLoading(false));
  }, [selectedId]);

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  const resetFilters = () => {
    setStatus('all');
    setMode('all');
    setStoreCode('');
    setQ('');
    setDateFrom('');
    setDateTo('');
    setOffset(0);
  };

  const hasFilters = useMemo(
    () => status !== 'all' || mode !== 'all' || storeCode || q || dateFrom || dateTo,
    [status, mode, storeCode, q, dateFrom, dateTo],
  );

  // IDs únicos de pick-orders nas rows visíveis que vieram de SHADOW
  // (candidatos a reabrir em lote). Ignora nulls e batch logs (bulk-approved).
  const reopenCandidates = useMemo(() => {
    const ids = new Set<string>();
    for (const r of rows) {
      if (!r.pickOrderId) continue;
      if (!r.event.includes('shadow') && r.event !== 'debit.real.failed') continue;
      // pula batch logs (event bulk-approved.shadow) — não têm pickOrderId individual
      if (r.event.startsWith('debit.bulk-approved')) continue;
      ids.add(r.pickOrderId);
    }
    return Array.from(ids);
  }, [rows]);

  // -----------------------------------------------------------------------
  // Reabrir baixa — devolve pick-order pra fila /baixa-estoque
  // -----------------------------------------------------------------------

  const reopenOne = async (pickOrderId: string) => {
    if (!confirm('Reabrir essa baixa? O pick-order volta pra fila de /baixa-estoque pra ser baixado novamente no ERP.')) return;
    setReopening(true);
    try {
      await api(`/pick-orders/${pickOrderId}/reopen-debit`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Reaberto manualmente pela tela de log' }),
      });
      alert('Baixa reaberta. Vai aparecer em /baixa-estoque.');
      setSelectedId(null);
      load();
      loadStats();
    } catch (e: any) {
      alert(`Erro ao reabrir: ${String(e?.message ?? e)}`);
    } finally {
      setReopening(false);
    }
  };

  const reopenBulk = async () => {
    if (reopenCandidates.length === 0) {
      alert('Nenhum pick-order candidato a reabrir nesta página (precisa ser SHADOW ou LIVE falhou).');
      return;
    }
    if (!confirm(
      `Reabrir ${reopenCandidates.length} pick-orders? ` +
      `Todos que tiveram baixa em SHADOW ou falharam nesta página voltam pra /baixa-estoque. ` +
      `Os que já foram baixados LIVE serão bloqueados automaticamente (proteção anti-dupla).`,
    )) return;
    setReopening(true);
    setBulkReopenResult(null);
    try {
      const resp = await api<{
        reopened: Array<{ id: string }>;
        skipped: Array<{ id: string; reason: string }>;
        blocked: Array<{ id: string; reason: string }>;
        errors: Array<{ id: string; error: string }>;
        total: number;
      }>('/pick-orders/bulk-reopen-debit', {
        method: 'POST',
        body: JSON.stringify({
          pickOrderIds: reopenCandidates,
          reason: 'Bulk reabertura via tela de log',
        }),
      });
      const summary = `Reabertos: ${resp.reopened.length} • Pulados: ${resp.skipped.length} • Bloqueados (já LIVE): ${resp.blocked.length} • Erros: ${resp.errors.length}`;
      setBulkReopenResult(summary);
      load();
      loadStats();
    } catch (e: any) {
      alert(`Erro no lote: ${String(e?.message ?? e)}`);
    } finally {
      setReopening(false);
    }
  };

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* ------------------ Header ------------------ */}
      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Database className="w-7 h-7 text-amber-600" />
            Log de Baixas
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Auditoria de todas as baixas de estoque tentadas no Gigasistemas. Clique numa linha pra ver o antes/depois de cada SKU.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {reopenCandidates.length > 0 && (
            <button
              onClick={reopenBulk}
              disabled={reopening}
              className="px-3 py-2 text-sm font-bold rounded bg-amber-600 text-white hover:bg-amber-700 flex items-center gap-2 disabled:opacity-60"
              title="Devolve todos os pick-orders SHADOW/FALHOU desta página pra fila /baixa-estoque"
            >
              <RotateCcw className="w-4 h-4" />
              Reabrir {reopenCandidates.length} shadow/falha
            </button>
          )}
          <button
            onClick={() => { load(); loadStats(); }}
            className="px-3 py-2 text-sm font-semibold rounded bg-gray-900 text-white hover:bg-gray-700 flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Atualizar
          </button>
        </div>
      </div>

      {bulkReopenResult && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 mb-3 text-sm text-amber-900 flex items-start gap-2">
          <RotateCcw className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <div className="font-semibold">Lote reaberto — {bulkReopenResult}</div>
            <div className="text-xs text-amber-700 mt-0.5">
              Acesse <a href="/retaguarda/baixa-estoque" className="underline">/retaguarda/baixa-estoque</a> pra dar baixa no ERP novamente.
            </div>
          </div>
          <button onClick={() => setBulkReopenResult(null)} className="text-amber-700 hover:text-amber-900">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ------------------ Stats cards ------------------ */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
          <div className="bg-white rounded-lg shadow p-4">
            <div className="text-xs text-gray-500 uppercase font-semibold mb-1">24h — Total</div>
            <div className="text-2xl font-bold">{stats.last24h.total}</div>
            <div className="text-xs text-gray-500 mt-1">{stats.last7d.total} nos últimos 7d</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4 border-l-4 border-green-500">
            <div className="text-xs text-green-700 uppercase font-semibold mb-1 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> LIVE OK (24h)
            </div>
            <div className="text-2xl font-bold text-green-700">{stats.last24h.success}</div>
            <div className="text-xs text-gray-500 mt-1">{stats.last7d.success} nos últimos 7d</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4 border-l-4 border-red-500">
            <div className="text-xs text-red-700 uppercase font-semibold mb-1 flex items-center gap-1">
              <XCircle className="w-3 h-3" /> LIVE falhou (24h)
            </div>
            <div className="text-2xl font-bold text-red-700">{stats.last24h.failed}</div>
            <div className="text-xs text-gray-500 mt-1">{stats.last7d.failed} nos últimos 7d</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4 border-l-4 border-amber-500">
            <div className="text-xs text-amber-700 uppercase font-semibold mb-1 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" /> SHADOW (24h)
            </div>
            <div className="text-2xl font-bold text-amber-700">{stats.last24h.shadow}</div>
            <div className="text-xs text-gray-500 mt-1">
              {stats.last24h.shadow > 0
                ? 'ERP_WRITE_ENABLED=false em runtime'
                : 'sem baixas shadow'}
            </div>
          </div>
        </div>
      )}

      {/* ------------------ Filtros ------------------ */}
      <div className="bg-white rounded-lg shadow p-4 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="w-4 h-4 text-gray-600" />
          <h2 className="font-semibold text-sm">Filtros</h2>
          {hasFilters && (
            <button
              onClick={resetFilters}
              className="ml-auto text-xs text-gray-500 hover:text-red-600 flex items-center gap-1"
            >
              <X className="w-3 h-3" /> Limpar
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Status</label>
            <select
              value={status}
              onChange={(e) => { setStatus(e.target.value as StatusFilter); setOffset(0); }}
              className="w-full text-sm border rounded px-2 py-1.5"
            >
              <option value="all">Todos</option>
              <option value="success">Sucesso (200)</option>
              <option value="failed">Falha (≠200)</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Modo</label>
            <select
              value={mode}
              onChange={(e) => { setMode(e.target.value as ModeFilter); setOffset(0); }}
              className="w-full text-sm border rounded px-2 py-1.5"
            >
              <option value="all">Todos</option>
              <option value="real">LIVE (real)</option>
              <option value="shadow">SHADOW</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Código loja</label>
            <input
              type="text"
              value={storeCode}
              onChange={(e) => { setStoreCode(e.target.value); setOffset(0); }}
              placeholder="ex: 01 ou LJ01"
              className="w-full text-sm border rounded px-2 py-1.5"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Busca (SKU/erro)</label>
            <input
              type="text"
              value={q}
              onChange={(e) => { setQ(e.target.value); setOffset(0); }}
              placeholder="ex: VMS-223"
              className="w-full text-sm border rounded px-2 py-1.5"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">De</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setOffset(0); }}
              className="w-full text-sm border rounded px-2 py-1.5"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Até</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setOffset(0); }}
              className="w-full text-sm border rounded px-2 py-1.5"
            />
          </div>
        </div>
      </div>

      {/* ------------------ Lista ------------------ */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg shadow p-12 text-center text-gray-500">
          <Loader2 className="w-6 h-6 animate-spin inline-block" />
          <div className="mt-2 text-sm">Carregando…</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-12 text-center text-gray-500">
          Nenhum registro encontrado com esses filtros.
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b text-xs uppercase text-gray-600">
                <tr>
                  <th className="text-left px-3 py-2">Data</th>
                  <th className="text-left px-3 py-2">Evento</th>
                  <th className="text-left px-3 py-2">Loja</th>
                  <th className="text-right px-3 py-2">Itens</th>
                  <th className="text-left px-3 py-2">Pick-order / Erro</th>
                  <th className="text-left px-3 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => {
                  const kind = eventKind(r.event);
                  const isFail = r.status !== 200;
                  return (
                    <tr
                      key={r.id}
                      onClick={() => setSelectedId(r.id)}
                      className={`cursor-pointer hover:bg-gray-50 ${isFail ? 'bg-red-50/30' : ''}`}
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-gray-700">
                        <Clock className="w-3 h-3 inline mr-1 text-gray-400" />
                        {formatDateTime(r.createdAt)}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-block text-xs font-bold uppercase border rounded px-2 py-0.5 ${kind.color}`}>
                          {kind.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.storeCode ? (
                          <span className="inline-flex items-center gap-1 text-gray-700">
                            <StoreIcon className="w-3 h-3 text-gray-400" />
                            <span className="font-mono font-semibold">{r.storeCode}</span>
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {r.appliedCount != null ? (
                          <span className="font-mono text-xs">
                            <Package className="w-3 h-3 inline mr-0.5 text-gray-400" />
                            {r.appliedCount}
                            {r.itemsCount != null && r.itemsCount !== r.appliedCount && (
                              <span className="text-gray-400">/{r.itemsCount}</span>
                            )}
                          </span>
                        ) : r.itemsCount != null ? (
                          <span className="font-mono text-xs text-gray-600">{r.itemsCount}</span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 max-w-md truncate">
                        {r.error ? (
                          <span className="text-red-700 text-xs" title={r.error}>
                            {r.error}
                          </span>
                        ) : r.pickOrderId ? (
                          <span className="font-mono text-xs text-gray-500" title={r.pickOrderId}>
                            {r.pickOrderId.slice(0, 8)}…
                          </span>
                        ) : (
                          <span className="text-gray-400 text-xs">{r.payloadPreview.slice(0, 60)}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-300">
                        <ChevronRight className="w-4 h-4" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Paginação */}
          <div className="border-t bg-gray-50 px-4 py-2 flex items-center justify-between text-xs text-gray-600">
            <span>
              {offset + 1}–{Math.min(offset + rows.length, total)} de {total}
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={offset === 0}
                className="px-2 py-1 border rounded bg-white disabled:opacity-40 hover:bg-gray-100"
              >
                Anterior
              </button>
              <button
                onClick={() => setOffset(offset + limit)}
                disabled={offset + rows.length >= total}
                className="px-2 py-1 border rounded bg-white disabled:opacity-40 hover:bg-gray-100"
              >
                Próxima
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------ Modal detalhe ------------------ */}
      {selectedId != null && (
        <DetailModal
          loading={detailLoading}
          detail={detail}
          onClose={() => setSelectedId(null)}
          onReopen={reopenOne}
          reopening={reopening}
        />
      )}
    </div>
  );
}

// ===========================================================================
// DetailModal — mostra payload parsed com foco em applied[] (antes/depois)
// ===========================================================================

function DetailModal({
  loading,
  detail,
  onClose,
  onReopen,
  reopening,
}: {
  loading: boolean;
  detail: DetailResp | null;
  onClose: () => void;
  onReopen: (pickOrderId: string) => void;
  reopening: boolean;
}) {
  // Exibe botão Reabrir somente se:
  //  - é shadow OU failed
  //  - tem pickOrderId individual (não batch agregado)
  const canReopen =
    !!detail?.pickOrderId &&
    (detail.event === 'debit.approved.shadow' || detail.event === 'debit.real.failed');
  const kind = detail ? eventKind(detail.event) : null;
  const applied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }> =
    detail?.payload?.applied ?? [];
  const items: Array<{ sku: string; qty: number; name?: string }> = detail?.payload?.items ?? [];

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-3">
            {kind && (
              <span className={`inline-block text-xs font-bold uppercase border rounded px-2 py-1 ${kind.color}`}>
                {kind.label}
              </span>
            )}
            <h3 className="font-bold">
              Log #{detail?.id ?? '…'}
              {detail && <span className="text-sm text-gray-500 font-normal ml-2">{formatDateTime(detail.createdAt)}</span>}
            </h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-3">
          {loading ? (
            <div className="text-center py-8 text-gray-500">
              <Loader2 className="w-6 h-6 animate-spin inline-block" />
            </div>
          ) : !detail ? (
            <div className="text-center py-8 text-gray-500">Sem dados</div>
          ) : (
            <>
              {/* Metadata */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm bg-gray-50 rounded p-3">
                <div>
                  <div className="text-xs text-gray-500">Source</div>
                  <div className="font-mono">{detail.source}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Direction</div>
                  <div className="font-mono">{detail.direction}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Status HTTP</div>
                  <div className={`font-mono font-semibold ${detail.status === 200 ? 'text-green-700' : 'text-red-700'}`}>
                    {detail.status ?? '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Loja</div>
                  <div className="font-mono font-semibold">{detail.storeCode ?? '—'}</div>
                </div>
                {detail.pickOrderId && (
                  <div className="col-span-2 md:col-span-4">
                    <div className="text-xs text-gray-500">Pick-order ID</div>
                    <div className="font-mono text-xs break-all">{detail.pickOrderId}</div>
                  </div>
                )}
              </div>

              {/* Erro (se houver) */}
              {detail.error && (
                <div className="bg-red-50 border border-red-200 rounded p-3">
                  <div className="text-xs uppercase font-semibold text-red-700 mb-1 flex items-center gap-1">
                    <XCircle className="w-3 h-3" /> Erro
                  </div>
                  <div className="text-sm text-red-800 font-mono whitespace-pre-wrap">{detail.error}</div>
                </div>
              )}

              {/* Applied — antes/depois (caso de sucesso LIVE) */}
              {applied.length > 0 && (
                <div>
                  <div className="text-xs uppercase font-semibold text-gray-600 mb-2 flex items-center gap-1">
                    <Zap className="w-3 h-3" /> Estoque aplicado no Gigasistemas
                  </div>
                  <table className="w-full text-xs border">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="text-left px-2 py-1">SKU</th>
                        <th className="text-left px-2 py-1">Loja</th>
                        <th className="text-right px-2 py-1">Qtd</th>
                        <th className="text-right px-2 py-1">Antes</th>
                        <th className="text-right px-2 py-1">Depois</th>
                      </tr>
                    </thead>
                    <tbody>
                      {applied.map((a, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="px-2 py-1 font-mono">{a.sku}</td>
                          <td className="px-2 py-1 font-mono">{a.storeCode}</td>
                          <td className="px-2 py-1 text-right font-mono text-red-700">-{a.qty}</td>
                          <td className="px-2 py-1 text-right font-mono text-gray-600">{a.previousStock}</td>
                          <td className="px-2 py-1 text-right font-mono font-bold">{a.newStock}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Items (caso shadow ou failed — não tem applied) */}
              {applied.length === 0 && items.length > 0 && (
                <div>
                  <div className="text-xs uppercase font-semibold text-gray-600 mb-2 flex items-center gap-1">
                    <Package className="w-3 h-3" /> Itens que foram tentados
                  </div>
                  <table className="w-full text-xs border">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="text-left px-2 py-1">SKU</th>
                        <th className="text-left px-2 py-1">Produto</th>
                        <th className="text-right px-2 py-1">Qtd</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((it, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="px-2 py-1 font-mono">{it.sku}</td>
                          <td className="px-2 py-1">{it.name ?? '—'}</td>
                          <td className="px-2 py-1 text-right font-mono">{it.qty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Bulk summary */}
              {(detail.event.startsWith('debit.bulk-approved')) && detail.payload && (
                <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm">
                  <div className="text-xs uppercase font-semibold text-blue-700 mb-2">Resumo do lote</div>
                  <div className="grid grid-cols-4 gap-2 text-center">
                    <div>
                      <div className="text-xs text-gray-500">Total</div>
                      <div className="font-bold">{detail.payload.total ?? 0}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500">Aprovados</div>
                      <div className="font-bold text-green-700">{detail.payload.approvedCount ?? 0}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500">Skipped</div>
                      <div className="font-bold text-gray-600">{detail.payload.skippedCount ?? 0}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500">Erros</div>
                      <div className="font-bold text-red-700">{detail.payload.errorCount ?? 0}</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Raw JSON pro caso extremo (debug) */}
              <details className="text-xs">
                <summary className="cursor-pointer text-gray-500 hover:text-gray-700">Payload completo (JSON)</summary>
                <pre className="mt-2 bg-gray-900 text-gray-100 p-3 rounded overflow-auto max-h-80 text-[11px]">
                  {JSON.stringify(detail.payload, null, 2)}
                </pre>
              </details>
            </>
          )}
        </div>

        {/* Footer — ação de reabrir (só pra shadow/failed) */}
        {canReopen && detail?.pickOrderId && (
          <div className="border-t bg-amber-50 p-3 flex items-center justify-between gap-3">
            <div className="text-xs text-amber-800">
              {detail.event === 'debit.approved.shadow'
                ? 'Baixa feita em SHADOW — não tocou o ERP. Reabrir devolve o pick-order pra fila.'
                : 'Baixa falhou no ERP. Reabrir devolve o pick-order pra fila pra tentar novamente.'}
            </div>
            <button
              onClick={() => onReopen(detail.pickOrderId!)}
              disabled={reopening}
              className="px-4 py-2 text-sm font-bold rounded bg-amber-600 text-white hover:bg-amber-700 flex items-center gap-2 disabled:opacity-60 whitespace-nowrap"
            >
              <RotateCcw className="w-4 h-4" />
              Reabrir p/ baixar de novo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
