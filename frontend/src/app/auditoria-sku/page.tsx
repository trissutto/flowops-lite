'use client';

/**
 * Tela /auditoria-sku
 *
 * Lista todas as variações que foram PULADAS no bulk sync por não ter
 * referência no ERP gigasistemas21 ou por não ter SKU cadastrado no WC.
 * Scan é read-only (nenhum PUT). Resulta em:
 *   - "sem SKU site"         → variação sem SKU cadastrado no WooCommerce
 *   - "não encontrado no ERP" → variação com SKU mas que não existe no Gigasistemas
 *
 * Dá pra filtrar por motivo, por busca textual (nome/SKU) e por categoria.
 * Exporta XLSX pra atacar em lote fora da aplicação.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import {
  AlertTriangle,
  RefreshCw,
  Search,
  FileDown,
  ExternalLink,
  Loader2,
  CheckCircle2,
  XCircle,
  Wrench,
  Ban,
} from 'lucide-react';

const WC_ADMIN_URL =
  process.env.NEXT_PUBLIC_WC_ADMIN_URL ||
  'https://lurds.com.br/wp-admin/post.php?action=edit&post=';

interface SkuAuditState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  totalProducts: number;
  processed: number;
  currentProductId: number | null;
  currentProductName: string | null;
  entriesFound: number;
  missingSkuCount: number;
  notInErpCount: number;
  productsFailed: number;
  lastError: string | null;
  lastFinishedAt: string | null;
  hasResult: boolean;
}

interface SkuAuditEntry {
  productId: number;
  productName: string;
  productSku: string | null;
  categories: string[];
  variationId: number;
  variationSku: string | null;
  variationAttrs: string;
  variationStock: number | null;
  image: string | null;
  reason: 'sem-sku' | 'nao-encontrado';
}

type ReasonFilter = 'all' | 'sem-sku' | 'nao-encontrado';

// ─── Correção de sufixo -N ───
interface SkuFixCandidate {
  productId: number;
  productName: string;
  productSku: string | null;
  variationId: number;
  variationAttrs: string;
  oldSku: string;
  baseSku: string;
  currentWcStock: number | null;
  erpStockAtBase: number | null;
  status: 'corrigivel' | 'conflito' | 'base-nao-existe-erp';
  conflictWithVariationId: number | null;
  conflictWithVariationSku: string | null;
}

interface SkuFixPreviewResponse {
  generatedAt: string;
  totalAuditEntries: number;
  candidates: SkuFixCandidate[];
  summary: {
    corrigivel: number;
    conflito: number;
    baseNaoExisteErp: number;
  };
}

interface SkuFixApplyResponse {
  total: number;
  success: number;
  failed: number;
  details: Array<{
    productId: number;
    variationId: number;
    oldSku: string;
    newSku: string;
    success: boolean;
    error?: string;
  }>;
}

export default function AuditoriaSkuPage() {
  const [state, setState] = useState<SkuAuditState | null>(null);
  const [entries, setEntries] = useState<SkuAuditEntry[]>([]);
  const [loadingResult, setLoadingResult] = useState(false);
  const [starting, setStarting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [reasonFilter, setReasonFilter] = useState<ReasonFilter>('all');
  const [searchText, setSearchText] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');

  // ─── Correção de sufixo -N ───
  const [skuFix, setSkuFix] = useState<SkuFixPreviewResponse | null>(null);
  const [skuFixLoading, setSkuFixLoading] = useState(false);
  const [selectedVarIds, setSelectedVarIds] = useState<Set<number>>(new Set());
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<SkuFixApplyResponse | null>(null);

  // ─── Polling do estado ───
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const s = await api<SkuAuditState>('/products/sku-audit/status');
        if (!alive) return;
        setState(s);
        // Se terminou e tem resultado, puxa
        if (!s.running && s.hasResult && entries.length === 0 && !loadingResult) {
          loadResult();
        }
      } catch (e) {
        if (alive) setErrorMsg((e as Error).message);
      }
    }
    tick();
    const id = setInterval(tick, state?.running ? 1500 : 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.running]);

  async function loadResult() {
    setLoadingResult(true);
    try {
      const r = await api<{ state: SkuAuditState; entries: SkuAuditEntry[] }>(
        '/products/sku-audit/result',
      );
      setEntries(r.entries);
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setLoadingResult(false);
    }
  }

  async function startAudit() {
    setStarting(true);
    setErrorMsg(null);
    try {
      const s = await api<SkuAuditState>('/products/sku-audit/start', {
        method: 'POST',
      });
      setState(s);
      setEntries([]);
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function downloadXlsx() {
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      const res = await fetch(`${apiUrl}/api/products/sku-audit/export.xlsx`, {
        headers: { Authorization: token ? `Bearer ${token}` : '' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const disp = res.headers.get('Content-Disposition') || '';
      const m = disp.match(/filename="?([^";]+)"?/i);
      const filename = m ? m[1] : `sku-audit-${Date.now()}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErrorMsg((e as Error).message);
    }
  }

  // ─── Correção de sufixo -N ───
  async function loadSkuFixPreview() {
    setSkuFixLoading(true);
    setErrorMsg(null);
    setApplyResult(null);
    try {
      const r = await api<SkuFixPreviewResponse>('/products/sku-fix/preview');
      setSkuFix(r);
      // Pré-seleciona todos os 'corrigivel'
      const ids = new Set<number>();
      for (const c of r.candidates) {
        if (c.status === 'corrigivel') ids.add(c.variationId);
      }
      setSelectedVarIds(ids);
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setSkuFixLoading(false);
    }
  }

  function toggleSelected(id: number) {
    setSelectedVarIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllCorrigivel() {
    if (!skuFix) return;
    const ids = new Set<number>();
    for (const c of skuFix.candidates) {
      if (c.status === 'corrigivel') ids.add(c.variationId);
    }
    setSelectedVarIds(ids);
  }

  function clearSelection() {
    setSelectedVarIds(new Set());
  }

  async function applySkuFix() {
    if (!skuFix || selectedVarIds.size === 0) return;
    const items = skuFix.candidates
      .filter((c) => selectedVarIds.has(c.variationId) && c.status === 'corrigivel')
      .map((c) => ({
        productId: c.productId,
        variationId: c.variationId,
        oldSku: c.oldSku,
        newSku: c.baseSku,
      }));

    if (items.length === 0) return;

    // Dupla confirmação
    if (
      !window.confirm(
        `Aplicar ${items.length} correções de SKU no WooCommerce? Essa ação altera as variações.`,
      )
    )
      return;
    if (
      !window.confirm(
        `Confirmação final: ${items.length} variações terão sua SKU sobrescrita. Continuar?`,
      )
    )
      return;

    setApplying(true);
    setErrorMsg(null);
    try {
      const r = await api<SkuFixApplyResponse>('/products/sku-fix/apply', {
        method: 'POST',
        body: JSON.stringify({ items }),
        headers: { 'Content-Type': 'application/json' },
      });
      setApplyResult(r);
      // Limpa estado de fix (auditoria foi invalidada no backend)
      setSkuFix(null);
      setSelectedVarIds(new Set());
      // Auditoria atual também ficou stale — limpa a lista local e força nova
      setEntries([]);
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setApplying(false);
    }
  }

  // ─── Filtros derivados ───
  const allCategories = useMemo(() => {
    const s = new Set<string>();
    for (const e of entries) for (const c of e.categories) s.add(c);
    return Array.from(s).sort();
  }, [entries]);

  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return entries.filter((e) => {
      if (reasonFilter !== 'all' && e.reason !== reasonFilter) return false;
      if (categoryFilter && !e.categories.includes(categoryFilter)) return false;
      if (!q) return true;
      const hay = `${e.productName} ${e.productSku ?? ''} ${e.variationSku ?? ''} ${e.variationAttrs}`.toLowerCase();
      return hay.includes(q);
    });
  }, [entries, reasonFilter, searchText, categoryFilter]);

  const pct =
    state && state.totalProducts > 0
      ? Math.min(100, Math.round((state.processed / state.totalProducts) * 100))
      : 0;

  const totalPuladas = entries.length;
  const semSku = entries.filter((e) => e.reason === 'sem-sku').length;
  const naoEncontrado = entries.filter((e) => e.reason === 'nao-encontrado').length;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <AlertTriangle className="w-6 h-6 text-amber-500" />
            Auditoria de SKU
          </h1>
          <p className="text-slate-600 text-sm mt-1">
            Variações que foram <b>puladas</b> na sincronização com o Gigasistemas.
            Scan read-only (nenhuma alteração é feita no site).
          </p>
        </div>
        <div className="flex gap-2">
          {entries.length > 0 && (
            <button
              onClick={downloadXlsx}
              className="px-4 py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 flex items-center gap-2 text-sm font-semibold"
            >
              <FileDown className="w-4 h-4" /> Exportar XLSX
            </button>
          )}
          <button
            onClick={startAudit}
            disabled={starting || !!state?.running}
            className="px-4 py-2 bg-violet-600 text-white rounded-md hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm font-semibold"
          >
            {state?.running ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Rodando...
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4" />
                {entries.length > 0 ? 'Regerar auditoria' : 'Gerar auditoria'}
              </>
            )}
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm">
          {errorMsg}
        </div>
      )}

      {/* Card de progresso */}
      {state?.running && (
        <div className="bg-violet-50 border border-violet-200 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="font-semibold text-violet-900">
              Varrendo catálogo... {state.processed}/{state.totalProducts}
            </div>
            <div className="text-sm text-violet-700 font-mono">{pct}%</div>
          </div>
          <div className="h-2 bg-violet-100 rounded overflow-hidden">
            <div
              className="h-full bg-violet-600 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          {state.currentProductName && (
            <div className="text-xs text-slate-600">
              Atual:{' '}
              <span className="font-mono">{state.currentProductName}</span>
            </div>
          )}
          <div className="flex gap-3 text-xs">
            <span className="px-2 py-0.5 bg-white rounded border border-violet-200">
              Encontradas até agora: <b>{state.entriesFound}</b>
            </span>
            <span className="px-2 py-0.5 bg-white rounded border border-violet-200">
              Sem SKU: <b>{state.missingSkuCount}</b>
            </span>
            <span className="px-2 py-0.5 bg-white rounded border border-violet-200">
              Não encontradas no ERP: <b>{state.notInErpCount}</b>
            </span>
          </div>
        </div>
      )}

      {/* Card: sem resultado ainda */}
      {!state?.running && !state?.hasResult && entries.length === 0 && (
        <div className="bg-white border rounded-lg p-8 text-center text-slate-500">
          <AlertTriangle className="w-12 h-12 mx-auto text-slate-300 mb-3" />
          <div className="text-sm">
            Nenhuma auditoria gerada ainda. Clique em <b>Gerar auditoria</b> pra varrer o catálogo.
          </div>
          <div className="text-xs text-slate-400 mt-2">
            Scan é read-only e costuma levar ~10-15 minutos pra catálogo completo.
          </div>
        </div>
      )}

      {/* KPIs + filtros + tabela */}
      {entries.length > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white border rounded-lg p-4">
              <div className="text-xs text-slate-500 uppercase tracking-wide">Total de puladas</div>
              <div className="text-2xl font-bold text-slate-800 mt-1">{totalPuladas}</div>
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-600 uppercase tracking-wide">Sem SKU no site</div>
              <div className="text-2xl font-bold text-slate-800 mt-1">{semSku}</div>
            </div>
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="text-xs text-red-700 uppercase tracking-wide">Não encontradas no ERP</div>
              <div className="text-2xl font-bold text-red-800 mt-1">{naoEncontrado}</div>
            </div>
          </div>

          {state?.lastFinishedAt && (
            <div className="text-xs text-slate-500 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3 text-emerald-500" />
              Última varredura em {new Date(state.lastFinishedAt).toLocaleString('pt-BR')}
            </div>
          )}

          {/* ─── Correção automática de SKU (sufixo -N) ─── */}
          <div className="bg-amber-50 border-2 border-amber-300 rounded-lg p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-bold text-amber-900 flex items-center gap-2">
                  <Wrench className="w-5 h-5" />
                  Correção automática de SKU (sufixo -N)
                </h2>
                <p className="text-xs text-amber-800 mt-1">
                  Identifica variações com SKU no formato <code className="bg-white px-1 rounded">12345678-1</code> (artefato do WooCommerce em importações)
                  e remove o sufixo, batendo com o Gigasistemas.
                </p>
              </div>
              {!skuFix && !applyResult && (
                <button
                  onClick={loadSkuFixPreview}
                  disabled={skuFixLoading}
                  className="shrink-0 px-4 py-2 bg-amber-600 text-white rounded-md hover:bg-amber-700 disabled:opacity-50 flex items-center gap-2 text-sm font-semibold"
                >
                  {skuFixLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> Analisando...
                    </>
                  ) : (
                    <>Analisar candidatos</>
                  )}
                </button>
              )}
            </div>

            {/* Resultado do aplicar */}
            {applyResult && (
              <div
                className={`p-3 rounded border text-sm ${
                  applyResult.failed === 0
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                    : 'bg-orange-50 border-orange-300 text-orange-900'
                }`}
              >
                <div className="font-semibold">
                  {applyResult.failed === 0 ? '✅ Correções aplicadas!' : '⚠️ Aplicado com erros'}
                </div>
                <div className="text-xs mt-1">
                  {applyResult.success} de {applyResult.total} variações tiveram a SKU corrigida.
                  {applyResult.failed > 0 && ` ${applyResult.failed} falharam.`}
                </div>
                <div className="text-xs mt-2">
                  A auditoria foi invalidada. Clique em <b>Regerar auditoria</b> pra ver o novo cenário,
                  depois dispare o bulk sync.
                </div>
              </div>
            )}

            {/* Preview carregado */}
            {skuFix && !applyResult && (
              <>
                {/* Sumário */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                  <div className="bg-emerald-100 border border-emerald-300 rounded p-2">
                    <div className="text-emerald-700 uppercase font-semibold">Corrigível</div>
                    <div className="text-2xl font-bold text-emerald-900">{skuFix.summary.corrigivel}</div>
                  </div>
                  <div className="bg-orange-100 border border-orange-300 rounded p-2">
                    <div className="text-orange-700 uppercase font-semibold">Conflito</div>
                    <div className="text-2xl font-bold text-orange-900">{skuFix.summary.conflito}</div>
                  </div>
                  <div className="bg-slate-100 border border-slate-300 rounded p-2">
                    <div className="text-slate-600 uppercase font-semibold">Base não existe ERP</div>
                    <div className="text-2xl font-bold text-slate-800">{skuFix.summary.baseNaoExisteErp}</div>
                  </div>
                </div>

                {skuFix.candidates.length === 0 ? (
                  <div className="text-sm text-slate-600 bg-white rounded p-3 border">
                    Nenhuma variação com sufixo -N encontrada. 👍
                  </div>
                ) : (
                  <>
                    {/* Ações de seleção */}
                    <div className="flex items-center gap-2 text-xs">
                      <button
                        onClick={selectAllCorrigivel}
                        className="px-2 py-1 bg-white border rounded hover:bg-slate-50"
                      >
                        Selecionar todos corrigíveis ({skuFix.summary.corrigivel})
                      </button>
                      <button
                        onClick={clearSelection}
                        className="px-2 py-1 bg-white border rounded hover:bg-slate-50"
                      >
                        Limpar seleção
                      </button>
                      <div className="ml-auto font-semibold text-amber-900">
                        {selectedVarIds.size} selecionada{selectedVarIds.size === 1 ? '' : 's'}
                      </div>
                    </div>

                    {/* Tabela de candidatos */}
                    <div className="bg-white border rounded overflow-hidden max-h-96 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-100 sticky top-0">
                          <tr>
                            <th className="p-2 w-10"></th>
                            <th className="p-2 text-left">Produto</th>
                            <th className="p-2 text-left">SKU atual</th>
                            <th className="p-2 text-left">→ Novo SKU</th>
                            <th className="p-2 text-center">Estoque ERP</th>
                            <th className="p-2 text-left">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {skuFix.candidates.map((c) => {
                            const checkable = c.status === 'corrigivel';
                            const checked = selectedVarIds.has(c.variationId);
                            return (
                              <tr
                                key={c.variationId}
                                className={`border-t ${
                                  !checkable ? 'bg-slate-50 opacity-70' : 'hover:bg-amber-50'
                                }`}
                              >
                                <td className="p-2 text-center">
                                  {checkable ? (
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => toggleSelected(c.variationId)}
                                    />
                                  ) : (
                                    <Ban className="w-3 h-3 text-slate-400 inline" />
                                  )}
                                </td>
                                <td className="p-2">
                                  <div className="font-semibold">{c.productName}</div>
                                  <div className="text-slate-500">{c.variationAttrs}</div>
                                </td>
                                <td className="p-2 font-mono">{c.oldSku}</td>
                                <td className="p-2 font-mono text-emerald-700 font-semibold">
                                  {c.baseSku}
                                </td>
                                <td className="p-2 text-center font-mono">
                                  {c.erpStockAtBase ?? '—'}
                                </td>
                                <td className="p-2">
                                  {c.status === 'corrigivel' && (
                                    <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-semibold">
                                      corrigível
                                    </span>
                                  )}
                                  {c.status === 'conflito' && (
                                    <div>
                                      <span className="px-2 py-0.5 rounded bg-orange-100 text-orange-800 font-semibold">
                                        conflito
                                      </span>
                                      <div className="text-slate-500 mt-0.5">
                                        outra var. já usa <code>{c.conflictWithVariationSku}</code>
                                      </div>
                                    </div>
                                  )}
                                  {c.status === 'base-nao-existe-erp' && (
                                    <span className="px-2 py-0.5 rounded bg-slate-200 text-slate-700 font-semibold">
                                      base não existe ERP
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Botão aplicar */}
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs text-amber-900">
                        <b>⚠️ Atenção:</b> essa ação altera SKUs no WooCommerce. Irreversível via esse fluxo.
                        Rode o <b>bulk sync</b> depois pra atualizar o estoque.
                      </div>
                      <button
                        onClick={applySkuFix}
                        disabled={applying || selectedVarIds.size === 0}
                        className="shrink-0 px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 flex items-center gap-2 text-sm font-semibold"
                      >
                        {applying ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" /> Aplicando...
                          </>
                        ) : (
                          <>
                            <Wrench className="w-4 h-4" /> Aplicar {selectedVarIds.size} correção
                            {selectedVarIds.size === 1 ? '' : 'ões'}
                          </>
                        )}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {/* Filtros */}
          <div className="bg-white border rounded-lg p-3 flex flex-wrap items-center gap-3">
            <div className="flex border rounded overflow-hidden text-sm">
              {([
                ['all', `Todas (${totalPuladas})`],
                ['sem-sku', `Sem SKU (${semSku})`],
                ['nao-encontrado', `Não encontradas (${naoEncontrado})`],
              ] as Array<[ReasonFilter, string]>).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setReasonFilter(k)}
                  className={`px-3 py-1.5 ${
                    reasonFilter === k
                      ? 'bg-violet-600 text-white'
                      : 'bg-white hover:bg-slate-50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex-1 min-w-[200px] relative">
              <Search className="absolute left-2 top-2.5 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Buscar por nome, SKU ou atributo..."
                className="w-full pl-8 pr-3 py-2 text-sm border rounded"
              />
            </div>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="text-sm border rounded px-2 py-2"
            >
              <option value="">Todas as categorias</option>
              {allCategories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          {/* Tabela */}
          <div className="bg-white border rounded-lg overflow-hidden">
            <div className="text-xs text-slate-500 px-3 py-2 border-b bg-slate-50">
              Mostrando {filtered.length} de {entries.length}
            </div>
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-xs">
                <tr>
                  <th className="p-2 text-left w-12"></th>
                  <th className="p-2 text-left">Produto</th>
                  <th className="p-2 text-left">SKU Site</th>
                  <th className="p-2 text-left">Variação</th>
                  <th className="p-2 text-center">Estoque WC</th>
                  <th className="p-2 text-left">Motivo</th>
                  <th className="p-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-slate-400">
                      Nenhum item com esses filtros.
                    </td>
                  </tr>
                )}
                {filtered.slice(0, 500).map((e) => (
                  <tr
                    key={`${e.productId}-${e.variationId}`}
                    className="border-t hover:bg-slate-50"
                  >
                    <td className="p-2">
                      {e.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={e.image}
                          alt=""
                          className="w-10 h-10 object-cover rounded"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-10 h-10 bg-slate-100 rounded" />
                      )}
                    </td>
                    <td className="p-2">
                      <div className="font-semibold text-sm">{e.productName}</div>
                      {e.categories.length > 0 && (
                        <div className="text-xs text-slate-500 mt-0.5">
                          {e.categories.slice(0, 3).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td className="p-2 font-mono text-xs">
                      {e.variationSku ?? (
                        <span className="text-slate-400 italic">—</span>
                      )}
                    </td>
                    <td className="p-2 text-xs">{e.variationAttrs || <span className="text-slate-400">—</span>}</td>
                    <td className="p-2 text-center font-mono text-sm">
                      {e.variationStock ?? (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="p-2">
                      {e.reason === 'sem-sku' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-slate-200 text-slate-700">
                          <XCircle className="w-3 h-3" /> sem SKU
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-700">
                          <AlertTriangle className="w-3 h-3" /> não encontrado no ERP
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-right">
                      <a
                        href={`${WC_ADMIN_URL}${e.productId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-violet-600 hover:text-violet-800 inline-flex"
                        title="Abrir no admin do WooCommerce"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {filtered.length > 500 && (
              <div className="text-xs text-center text-slate-500 py-2 border-t bg-slate-50">
                Exibindo primeiras 500 linhas. Use filtros ou exporte XLSX pra ver o resto.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
