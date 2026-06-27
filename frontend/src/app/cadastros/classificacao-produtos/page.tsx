'use client';

/**
 * Cadastros → Classificação de Produtos (BÁSICO / MODA).
 *
 * Classifica o catálogo por REFERÊNCIA (modelo) entre BÁSICO e MODA, pra
 * alimentar futuras regras de liquidação/promoção. NÃO altera nada do ERP —
 * a classificação vive no Postgres do Flow (product_classification).
 *
 * Busca inteligente "contém" em tempo real, filtros rápidos, seleção em massa
 * e alteração em lote (em transação no backend). Plus size é só leitura
 * (vem do flag do ERP).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Tags, Search, RefreshCw, Loader2, Check, X } from 'lucide-react';

type Quick = 'todos' | 'basicos' | 'moda' | 'nao_revisados';

interface Row {
  ref: string;
  descricao: string;
  marca: string;
  fornecedor: string;
  categoria: string;
  plusSize: boolean;
  tipoProduto: number; // 0=MODA, 1=BASICO
  revisada: boolean;
}

interface Counters {
  total: number;
  basicos: number;
  moda: number;
  naoRevisados: number;
  plusSize: number;
}

interface Facets {
  marcas: string[];
  fornecedores: string[];
  categorias: string[];
}

const PER_PAGE = 50;
const fmt = (n: number) => n.toLocaleString('pt-BR');

export default function ClassificacaoProdutosPage() {
  // Filtros
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [quick, setQuick] = useState<Quick>('todos');
  const [marca, setMarca] = useState('');
  const [fornecedor, setFornecedor] = useState('');
  const [categoria, setCategoria] = useState('');
  const [plusSizeOnly, setPlusSizeOnly] = useState(false);

  // Dados
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [counters, setCounters] = useState<Counters | null>(null);
  const [facets, setFacets] = useState<Facets>({ marcas: [], fornecedores: [], categorias: [] });

  // Seleção: ou um Set explícito, ou "todos os filtrados"
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allFiltered, setAllFiltered] = useState(false);

  // UI
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { tipo: number; count: number }>(null);

  const filterObj = useMemo(
    () => ({
      search: search || undefined,
      quick: quick !== 'todos' ? quick : undefined,
      marca: marca || undefined,
      fornecedor: fornecedor || undefined,
      categoria: categoria || undefined,
      plusSize: plusSizeOnly || undefined,
    }),
    [search, quick, marca, fornecedor, categoria, plusSizeOnly],
  );

  const queryString = useCallback(
    (p: number) => {
      const q = new URLSearchParams();
      if (search) q.set('search', search);
      if (quick !== 'todos') q.set('quick', quick);
      if (marca) q.set('marca', marca);
      if (fornecedor) q.set('fornecedor', fornecedor);
      if (categoria) q.set('categoria', categoria);
      if (plusSizeOnly) q.set('plusSize', '1');
      q.set('page', String(p));
      q.set('perPage', String(PER_PAGE));
      return q.toString();
    },
    [search, quick, marca, fornecedor, categoria, plusSizeOnly],
  );

  // Debounce da busca
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Sempre que filtro muda, volta pra página 1 e limpa seleção
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
    setAllFiltered(false);
  }, [search, quick, marca, fornecedor, categoria, plusSizeOnly]);

  const loadList = useCallback(
    async (p: number) => {
      setLoading(true);
      setError(null);
      try {
        const data = await api<{ rows: Row[]; total: number }>(
          `/product-classification/list?${queryString(p)}`,
        );
        setRows(data.rows);
        setTotal(data.total);
      } catch (e: any) {
        setError(e?.message || 'Falha ao carregar produtos');
        setRows([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    },
    [queryString],
  );

  const loadCounters = useCallback(async () => {
    try {
      setCounters(await api<Counters>('/product-classification/counters'));
    } catch {
      /* silencioso — cartões só mostram '—' */
    }
  }, []);

  // Carrega facets uma vez
  useEffect(() => {
    api<Facets>('/product-classification/facets')
      .then(setFacets)
      .catch(() => {});
    loadCounters();
  }, [loadCounters]);

  // Recarrega lista quando filtro/página mudam
  useEffect(() => {
    loadList(page);
  }, [page, loadList]);

  // ── Seleção ────────────────────────────────────────────────────────────
  const toggleRow = (ref: string) => {
    setAllFiltered(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelected(new Set());
    setAllFiltered(true);
  };

  const clearSelection = () => {
    setSelected(new Set());
    setAllFiltered(false);
  };

  const selectionCount = allFiltered ? total : selected.size;
  const hasSelection = selectionCount > 0;

  // ── Salvar ─────────────────────────────────────────────────────────────
  const setOne = async (ref: string, tipoProduto: number) => {
    // Otimista
    setRows((prev) =>
      prev.map((r) => (r.ref === ref ? { ...r, tipoProduto, revisada: true } : r)),
    );
    try {
      await api('/product-classification/set', {
        method: 'POST',
        body: JSON.stringify({ ref, tipoProduto }),
      });
      loadCounters();
    } catch (e: any) {
      setError(e?.message || 'Falha ao salvar');
      loadList(page); // reverte do servidor
    }
  };

  const runBulk = async (tipoProduto: number) => {
    setConfirm(null);
    setSaving(true);
    setError(null);
    try {
      const body: any = { tipoProduto };
      if (allFiltered) body.filtro = filterObj;
      else body.refs = Array.from(selected);
      const res = await api<{ alterados: number }>('/product-classification/bulk', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      clearSelection();
      await Promise.all([loadList(page), loadCounters()]);
      setError(null);
      if (typeof res?.alterados === 'number') {
        // feedback rápido reusando o banner (não é erro)
        setOkMsg(`${fmt(res.alterados)} produto(s) marcado(s) como ${tipoProduto === 1 ? 'BÁSICO' : 'MODA'}.`);
      }
    } catch (e: any) {
      setError(e?.message || 'Falha na alteração em lote');
    } finally {
      setSaving(false);
    }
  };

  const [okMsg, setOkMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!okMsg) return;
    const t = setTimeout(() => setOkMsg(null), 4000);
    return () => clearTimeout(t);
  }, [okMsg]);

  const refreshCatalog = async () => {
    setSaving(true);
    try {
      await api('/product-classification/refresh', { method: 'POST' });
      await Promise.all([loadList(page), loadCounters()]);
      api<Facets>('/product-classification/facets').then(setFacets).catch(() => {});
    } finally {
      setSaving(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const pageHasSelectableAllFiltered = allFiltered;

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4 sm:py-6">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 grid place-items-center text-white">
            <Tags className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg sm:text-xl font-bold text-slate-900">Classificação de Produtos</h1>
            <p className="text-xs text-slate-500">BÁSICO / MODA por referência — alimenta liquidações e campanhas</p>
          </div>
        </div>
        <button
          onClick={refreshCatalog}
          disabled={saving}
          className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          title="Recarrega o catálogo do ERP"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${saving ? 'animate-spin' : ''}`} />
          Atualizar catálogo
        </button>
      </div>

      {/* Cartões de contadores */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2.5 mb-4">
        <CounterCard label="TOTAL DE PRODUTOS" value={counters?.total} tone="slate" />
        <CounterCard label="BÁSICOS" value={counters?.basicos} tone="blue" />
        <CounterCard label="MODA" value={counters?.moda} tone="rose" />
        <CounterCard label="AINDA NÃO REVISADOS" value={counters?.naoRevisados} tone="amber" />
        <CounterCard label="PLUS SIZE" value={counters?.plusSize} tone="violet" />
      </div>

      {/* Busca */}
      <div className="relative mb-3">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Pesquisar por descrição, referência, fornecedor, coleção ou qualquer palavra... (marca: use o filtro ao lado)"
          className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
        />
      </div>

      {/* Filtros rápidos + selects */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {([
          ['todos', 'Todos'],
          ['basicos', 'Somente Básicos'],
          ['moda', 'Somente Moda'],
          ['nao_revisados', 'Somente Não Revisados'],
        ] as [Quick, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setQuick(key)}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border transition ${
              quick === key
                ? 'bg-violet-600 text-white border-violet-600'
                : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
            }`}
          >
            {label}
          </button>
        ))}

        <select value={marca} onChange={(e) => setMarca(e.target.value)} className="text-xs px-2 py-1.5 rounded-lg border border-slate-300 bg-white max-w-[160px]">
          <option value="">Marca (todas)</option>
          {facets.marcas.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={fornecedor} onChange={(e) => setFornecedor(e.target.value)} className="text-xs px-2 py-1.5 rounded-lg border border-slate-300 bg-white max-w-[160px]">
          <option value="">Fornecedor (todos)</option>
          {facets.fornecedores.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <select value={categoria} onChange={(e) => setCategoria(e.target.value)} className="text-xs px-2 py-1.5 rounded-lg border border-slate-300 bg-white max-w-[160px]">
          <option value="">Categoria (todas)</option>
          {facets.categorias.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 px-2 py-1.5 rounded-lg border border-slate-300 bg-white cursor-pointer">
          <input type="checkbox" checked={plusSizeOnly} onChange={(e) => setPlusSizeOnly(e.target.checked)} />
          Só Plus Size
        </label>
      </div>

      {/* Barra de ações em massa */}
      <div className="flex flex-wrap items-center gap-2 mb-2 min-h-[40px]">
        <button
          onClick={selectAllFiltered}
          disabled={total === 0}
          className="text-xs font-bold px-3 py-2 rounded-lg bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-40"
        >
          MARCAR TODOS ({fmt(total)})
        </button>
        {hasSelection && (
          <>
            <span className="text-xs text-slate-600 font-medium">
              {allFiltered
                ? `Todos os ${fmt(total)} filtrados selecionados`
                : `${fmt(selected.size)} selecionado(s)`}
            </span>
            <button
              onClick={() => setConfirm({ tipo: 1, count: selectionCount })}
              disabled={saving}
              className="text-xs font-bold px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
            >
              MARCAR SELECIONADOS COMO BÁSICO
            </button>
            <button
              onClick={() => setConfirm({ tipo: 0, count: selectionCount })}
              disabled={saving}
              className="text-xs font-bold px-3 py-2 rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40"
            >
              MARCAR SELECIONADOS COMO MODA
            </button>
            <button onClick={clearSelection} className="text-xs text-slate-500 hover:text-slate-800 underline">
              limpar
            </button>
          </>
        )}
        {saving && <Loader2 className="w-4 h-4 animate-spin text-slate-500" />}
      </div>

      {/* Banners */}
      {error && (
        <div className="mb-2 text-xs px-3 py-2 rounded-lg bg-red-50 text-red-700 border border-red-200 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      {okMsg && (
        <div className="mb-2 text-xs px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200">
          {okMsg}
        </div>
      )}

      {/* Grid */}
      <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="w-10 px-3 py-2.5 text-left">
                  <input
                    type="checkbox"
                    checked={pageHasSelectableAllFiltered}
                    onChange={(e) => (e.target.checked ? selectAllFiltered() : clearSelection())}
                    title="Selecionar todos os filtrados"
                  />
                </th>
                <th className="px-3 py-2.5 text-left">Referência</th>
                <th className="px-3 py-2.5 text-left">Descrição</th>
                <th className="px-3 py-2.5 text-left">Marca</th>
                <th className="px-3 py-2.5 text-left">Fornecedor</th>
                <th className="px-3 py-2.5 text-left">Categoria</th>
                <th className="px-3 py-2.5 text-center">Plus</th>
                <th className="px-3 py-2.5 text-center">Tipo Atual</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={8} className="px-3 py-10 text-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin inline" /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-10 text-center text-slate-400">Nenhum produto encontrado.</td></tr>
              ) : (
                rows.map((r) => {
                  const isSel = allFiltered || selected.has(r.ref);
                  const basico = r.tipoProduto === 1;
                  return (
                    <tr key={r.ref} className={isSel ? 'bg-violet-50/60' : 'hover:bg-slate-50'}>
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={isSel} onChange={() => toggleRow(r.ref)} />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-700">{r.ref}</td>
                      <td className="px-3 py-2 text-slate-800 max-w-[280px] truncate" title={r.descricao}>
                        {r.descricao || '—'}
                        {!r.revisada && (
                          <span className="ml-1.5 align-middle text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">não revisado</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-600 text-xs">{r.marca || '—'}</td>
                      <td className="px-3 py-2 text-slate-600 text-xs">{r.fornecedor || '—'}</td>
                      <td className="px-3 py-2 text-slate-600 text-xs">{r.categoria || '—'}</td>
                      <td className="px-3 py-2 text-center">
                        {r.plusSize ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 font-semibold">PLUS</span> : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => setOne(r.ref, basico ? 0 : 1)}
                          className="inline-flex items-center gap-2 group"
                          title={basico ? 'Clique pra marcar como MODA' : 'Clique pra marcar como BÁSICO'}
                        >
                          <span
                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${basico ? 'bg-blue-600' : 'bg-rose-500'}`}
                          >
                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${basico ? 'translate-x-4' : 'translate-x-0.5'}`} />
                          </span>
                          <span className={`text-xs font-bold ${basico ? 'text-blue-700' : 'text-rose-600'}`}>
                            {basico ? '🟦 BÁSICO' : '🟥 MODA'}
                          </span>
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Paginação */}
        <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-t border-slate-200 bg-slate-50 text-xs text-slate-600">
          <span>
            {total > 0
              ? `${fmt((page - 1) * PER_PAGE + 1)}–${fmt(Math.min(page * PER_PAGE, total))} de ${fmt(total)}`
              : '0 produtos'}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage(1)} disabled={page <= 1} className="px-2 py-1 rounded border border-slate-300 bg-white disabled:opacity-40">«</button>
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-2 py-1 rounded border border-slate-300 bg-white disabled:opacity-40">‹</button>
            <span className="px-2">Pág. {fmt(page)} / {fmt(totalPages)}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="px-2 py-1 rounded border border-slate-300 bg-white disabled:opacity-40">›</button>
            <button onClick={() => setPage(totalPages)} disabled={page >= totalPages} className="px-2 py-1 rounded border border-slate-300 bg-white disabled:opacity-40">»</button>
          </div>
        </div>
      </div>

      {/* Confirmação de lote */}
      {confirm && (
        <div className="fixed inset-0 bg-black/40 grid place-items-center z-50 p-4" onClick={() => setConfirm(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-slate-900 mb-1">Confirmar alteração em lote</h3>
            <p className="text-sm text-slate-600 mb-4">
              Marcar <strong>{fmt(confirm.count)}</strong> produto(s) como{' '}
              <strong className={confirm.tipo === 1 ? 'text-blue-700' : 'text-rose-600'}>
                {confirm.tipo === 1 ? 'BÁSICO' : 'MODA'}
              </strong>?
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirm(null)} className="text-sm px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">Cancelar</button>
              <button
                onClick={() => runBulk(confirm.tipo)}
                className={`text-sm font-bold px-3 py-2 rounded-lg text-white inline-flex items-center gap-1.5 ${confirm.tipo === 1 ? 'bg-blue-600 hover:bg-blue-700' : 'bg-rose-600 hover:bg-rose-700'}`}
              >
                <Check className="w-4 h-4" /> Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CounterCard({ label, value, tone }: { label: string; value?: number; tone: string }) {
  const tones: Record<string, string> = {
    slate: 'from-slate-50 to-slate-100 text-slate-800 border-slate-200',
    blue: 'from-blue-50 to-blue-100 text-blue-800 border-blue-200',
    rose: 'from-rose-50 to-rose-100 text-rose-800 border-rose-200',
    amber: 'from-amber-50 to-amber-100 text-amber-800 border-amber-200',
    violet: 'from-violet-50 to-violet-100 text-violet-800 border-violet-200',
  };
  return (
    <div className={`rounded-xl border bg-gradient-to-br p-3 ${tones[tone] || tones.slate}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-xl sm:text-2xl font-bold mt-0.5">
        {value === undefined ? '—' : value.toLocaleString('pt-BR')}
      </div>
    </div>
  );
}
