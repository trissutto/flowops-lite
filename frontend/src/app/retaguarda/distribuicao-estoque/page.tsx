'use client';

/**
 * /retaguarda/distribuicao-estoque
 *
 * Tela de análise de distribuição de estoque PLUS SIZE entre as lojas.
 *
 * Caso de uso real (Lurd's): peças paradas em algumas lojas (8 unidades de
 * VLM-222 MARINHO 48 em Santos) enquanto outras estão zeradas. Essa tela
 * mostra TODAS as variações REF+COR+TAM com qty por loja em formato igual ao
 * Wincred (consulta de produtos) — MAS com filtros + indicador de criticidade
 * + botão "Realinhar" pra resolver direto.
 *
 * Critério de criticidade (regra do user):
 *   ALTO  → alguma loja com 0 E outra com 3+
 *   MEDIO → alguma com 0 E outra com 2
 *   OK    → distribuído
 *
 * Default = só desequilibrados + plus size + estoque total >= 3.
 */

import { Fragment, useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, RefreshCw, Loader2, Filter, Search, Package,
  Shuffle, AlertTriangle, AlertCircle, CheckCircle2,
  ChevronDown, ChevronUp, X, Settings2,
} from 'lucide-react';
import { api } from '@/lib/api';

type Row = {
  codigo: string;
  ref: string;
  cor: string | null;
  tamanho: string | null;
  descricao: string;
  preco: number;
  estoquePorLoja: Record<string, number>;
  total: number;
  criticidade: 'ALTO' | 'MEDIO' | 'OK';
};

type Distribution = {
  rows: Row[];
  lojas: string[];
  totalRows: number;
  truncated: boolean;
};

type Store = {
  id: string;
  code: string;
  name: string;
  active: boolean;
};

type GrupoItem = { codigo: number; nome: string };

const PLUS_SIZE_DEFAULT = [
  '46', '48', '50', '52', '54', '56', '58', '60',
  '46/48', '48/50', '50/52', '52/54', '54/56', '56/58', '58/60',
];

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function DistribuicaoEstoque() {
  const router = useRouter();

  // ── Auth check ──
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) router.push('/login');
  }, [router]);

  // ── Stores cache (pra mapear código → nome curto) ──
  const [stores, setStores] = useState<Store[]>([]);
  useEffect(() => {
    api<Store[]>('/stores')
      .then((arr) => setStores(arr.filter((s) => s.active)))
      .catch(() => {});
  }, []);
  const storeNameByCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of stores) map.set(s.code, s.name);
    return map;
  }, [stores]);

  // ── Filtros ──
  const [grupos, setGrupos] = useState<GrupoItem[]>([]);
  const [subgrupos, setSubgrupos] = useState<GrupoItem[]>([]);
  const [grupoSelected, setGrupoSelected] = useState<number | null>(null);
  const [subgrupoSelected, setSubgrupoSelected] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [searchDebounce, setSearchDebounce] = useState('');
  const [tamanhos, setTamanhos] = useState<string[]>(PLUS_SIZE_DEFAULT);
  const [mode, setMode] = useState<'imbalanced' | 'all'>('imbalanced');
  // minTotal=2: análise faz sentido só com 2+ peças por SKU (CODIGO)
  const [minTotal, setMinTotal] = useState(2);
  const [showSettings, setShowSettings] = useState(false);

  // ── Drawer de realinhamento inline ──
  const [drawerGroup, setDrawerGroup] = useState<GroupDrawer | null>(null);

  // ── Modal "Realinhar TODOS" ──
  const [showRealignAllModal, setShowRealignAllModal] = useState(false);

  // ── Tab atual: 'raiz' | 'distribuicao' | 'config' ──
  // raiz       = Sprint 1, visão agrupada por REF+COR (default)
  // distribuicao = visão antiga (1 linha por variação REF+COR+TAM)
  // config     = lojas que participam + scores
  const [activeTab, setActiveTab] = useState<'raiz' | 'distribuicao' | 'config'>('raiz');

  // ── Dirty tracking: filtros mudaram desde a última busca ──
  // Usado pra avisar visualmente "clica Atualizar pra ver os novos resultados".
  const [lastQueryKey, setLastQueryKey] = useState<string>('');
  const currentQueryKey = `${grupoSelected || ''}|${subgrupoSelected || ''}|${search}|${tamanhos.join(',')}|${mode}|${minTotal}`;
  const filtersDirty = lastQueryKey !== '' && lastQueryKey !== currentQueryKey;

  // ── Dados ──
  const [data, setData] = useState<Distribution | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load grupos
  useEffect(() => {
    api<GrupoItem[]>('/intelligence/grupos').then(setGrupos).catch(() => {});
  }, []);

  // Load subgrupos quando muda grupo
  useEffect(() => {
    if (!grupoSelected) {
      setSubgrupos([]);
      setSubgrupoSelected(null);
      return;
    }
    api<GrupoItem[]>(`/intelligence/subgrupos?grupo=${grupoSelected}`)
      .then(setSubgrupos)
      .catch(() => setSubgrupos([]));
  }, [grupoSelected]);

  // Debounce do search (800ms — query SQL é pesada, evita rodar a cada tecla)
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounce(search), 800);
    return () => clearTimeout(t);
  }, [search]);

  // Fetch dados
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (grupoSelected) params.set('grupo', String(grupoSelected));
      if (subgrupoSelected) params.set('subgrupo', String(subgrupoSelected));
      if (searchDebounce.trim()) params.set('search', searchDebounce.trim());
      if (tamanhos.length > 0) params.set('tamanhos', tamanhos.join(','));
      params.set('mode', mode);
      params.set('minTotal', String(minTotal));
      params.set('limit', '1500');

      const r = await api<Distribution>(`/intelligence/stock-distribution?${params}`);
      setData(r);
      // Marca o snapshot dos filtros usados nessa última busca
      setLastQueryKey(currentQueryKey);
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar distribuição');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [grupoSelected, subgrupoSelected, searchDebounce, tamanhos, mode, minTotal, currentQueryKey]);

  // ── Carregamento manual: NÃO carrega automaticamente em cada mudança ──
  // Query SQL no Giga é pesada — só dispara quando user clica "Atualizar"
  // OU dá Enter na busca. Estado inicial vazio até primeira ação.
  // (Removido o useEffect que disparava automaticamente)

  // ── KPIs derivados ──
  const kpis = useMemo(() => {
    if (!data) return { alto: 0, medio: 0, ok: 0, total: 0, pecas: 0 };
    let alto = 0, medio = 0, ok = 0, pecas = 0;
    for (const r of data.rows) {
      if (r.criticidade === 'ALTO') alto++;
      else if (r.criticidade === 'MEDIO') medio++;
      else ok++;
      pecas += r.total;
    }
    return { alto, medio, ok, total: data.rows.length, pecas };
  }, [data]);

  // Nome compacto da loja (CODE - nome abreviado)
  const lojaLabel = (code: string) => {
    const name = storeNameByCode.get(code) || code;
    // Pega só a primeira palavra do nome (SANTOS 1 → SANTOS)
    return name.split(' ')[0].substring(0, 6).toUpperCase();
  };

  // Cor da célula de quantidade
  const cellBgClass = (qty: number) => {
    if (qty < 0) return 'bg-rose-200 text-rose-900 font-bold';
    if (qty === 0) return 'text-slate-300';
    if (qty >= 5) return 'bg-emerald-200 text-emerald-900 font-bold';
    if (qty >= 3) return 'bg-emerald-100 text-emerald-800 font-semibold';
    return 'text-slate-700';
  };

  // Cor da linha conforme criticidade
  const rowBgClass = (crit: Row['criticidade']) => {
    if (crit === 'ALTO') return 'bg-rose-50 hover:bg-rose-100';
    if (crit === 'MEDIO') return 'bg-amber-50 hover:bg-amber-100';
    return 'hover:bg-slate-50';
  };

  // Abre DRAWER inline de realinhamento — não redireciona, faz balanço aqui
  const realinharGrupo = (group: GroupDrawer) => {
    setDrawerGroup(group);
  };

  const limparFiltros = () => {
    setGrupoSelected(null);
    setSubgrupoSelected(null);
    setSearch('');
    setTamanhos(PLUS_SIZE_DEFAULT);
    setMode('imbalanced');
    setMinTotal(2);
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-[1800px] mx-auto px-4 py-3 flex items-center gap-3">
          <Link
            href="/retaguarda"
            className="p-2 rounded hover:bg-slate-100"
            title="Voltar pra Gestão"
          >
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </Link>
          <div className="flex-1">
            <h1 className="text-lg font-black text-slate-800">
              Distribuição de Estoque
            </h1>
            <p className="text-xs text-slate-500">
              Detecta desequilíbrios entre lojas · PLUS SIZE
            </p>
          </div>
          {activeTab === 'distribuicao' && (
            <button
              onClick={() => setShowRealignAllModal(true)}
              disabled={loading || !data || data.rows.filter((r) => r.criticidade !== 'OK').length === 0}
              className="flex items-center gap-1.5 px-3 py-2 bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-md text-sm font-bold"
              title="Realinhar TODAS as variações desequilibradas com 1 clique"
            >
              <Shuffle className="w-4 h-4" />
              Realinhar TODOS
              {data && (
                <span className="ml-1 bg-white/20 px-1.5 py-0.5 rounded text-[10px] font-mono">
                  {data.rows.filter((r) => r.criticidade !== 'OK').length}
                </span>
              )}
            </button>
          )}
          <button
            onClick={fetchData}
            disabled={loading || activeTab !== 'distribuicao'}
            className={`relative flex items-center gap-1.5 px-3 py-2 text-white rounded-md text-sm font-bold disabled:opacity-50 transition ${
              filtersDirty
                ? 'bg-amber-500 hover:bg-amber-600 ring-2 ring-amber-300 animate-pulse'
                : 'bg-violet-600 hover:bg-violet-700'
            }`}
            title={
              filtersDirty
                ? 'Filtros mudaram desde a última busca — clique pra atualizar resultados'
                : 'Recarregar com os filtros atuais'
            }
          >
            {filtersDirty && (
              <span className="absolute -top-1.5 -right-1.5 w-2.5 h-2.5 bg-amber-300 rounded-full ring-2 ring-white"></span>
            )}
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            Atualizar
          </button>
        </div>
      </header>

      <main className="max-w-[1800px] mx-auto p-4 space-y-4">
        {/* Tabs */}
        <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-lg p-1 w-fit">
          <button
            onClick={() => setActiveTab('raiz')}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
              activeTab === 'raiz'
                ? 'bg-fuchsia-600 text-white shadow'
                : 'text-slate-600 hover:text-slate-900'
            }`}
            title="Visão por REF+COR — 1 linha por referência. Clica pra ver tamanhos."
          >
            🌱 Visão Raiz
          </button>
          <button
            onClick={() => setActiveTab('distribuicao')}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
              activeTab === 'distribuicao'
                ? 'bg-violet-600 text-white shadow'
                : 'text-slate-600 hover:text-slate-900'
            }`}
            title="Visão antiga por variação — 1 linha por código de barras"
          >
            📊 Por Variação
          </button>
          <button
            onClick={() => setActiveTab('config')}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
              activeTab === 'config'
                ? 'bg-violet-600 text-white shadow'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            ⚙️ Config Realinhamento
          </button>
        </div>

        {activeTab === 'config' ? (
          <RealignConfigPanel />
        ) : activeTab === 'raiz' ? (
          <RefRootView stores={stores} grupos={grupos} />
        ) : (
          <>
        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="bg-rose-100 border border-rose-300 rounded-lg p-3">
            <div className="text-xs font-bold text-rose-700 uppercase">🔴 Alto</div>
            <div className="text-2xl font-black text-rose-900">{kpis.alto}</div>
            <div className="text-[10px] text-rose-600">com 0 + com 3+</div>
          </div>
          <div className="bg-amber-100 border border-amber-300 rounded-lg p-3">
            <div className="text-xs font-bold text-amber-700 uppercase">🟡 Médio</div>
            <div className="text-2xl font-black text-amber-900">{kpis.medio}</div>
            <div className="text-[10px] text-amber-600">com 0 + com 2</div>
          </div>
          <div className="bg-emerald-100 border border-emerald-300 rounded-lg p-3">
            <div className="text-xs font-bold text-emerald-700 uppercase">🟢 OK</div>
            <div className="text-2xl font-black text-emerald-900">{kpis.ok}</div>
            <div className="text-[10px] text-emerald-600">distribuído</div>
          </div>
          <div className="bg-slate-100 border border-slate-300 rounded-lg p-3">
            <div className="text-xs font-bold text-slate-700 uppercase">Total filtrado</div>
            <div className="text-2xl font-black text-slate-900">{kpis.total}</div>
            <div className="text-[10px] text-slate-600">{kpis.pecas} peças</div>
          </div>
        </div>

        {/* Filtros */}
        <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* Categoria */}
            <select
              value={grupoSelected ?? ''}
              onChange={(e) => setGrupoSelected(e.target.value ? Number(e.target.value) : null)}
              className="px-3 py-2 border rounded-md text-sm bg-white"
            >
              <option value="">📁 Todas categorias</option>
              {grupos.map((g) => (
                <option key={g.codigo} value={g.codigo}>{g.nome}</option>
              ))}
            </select>

            {/* Subcategoria */}
            {grupoSelected && subgrupos.length > 0 && (
              <select
                value={subgrupoSelected ?? ''}
                onChange={(e) => setSubgrupoSelected(e.target.value ? Number(e.target.value) : null)}
                className="px-3 py-2 border rounded-md text-sm bg-white"
              >
                <option value="">▾ Todos subgrupos</option>
                {subgrupos.map((s) => (
                  <option key={s.codigo} value={s.codigo}>{s.nome}</option>
                ))}
              </select>
            )}

            {/* Busca */}
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setSearchDebounce(search);
                    fetchData();
                  }
                }}
                placeholder="Buscar REF, descrição ou CODIGO... (Enter pra buscar)"
                className="w-full pl-8 pr-3 py-2 border rounded-md text-sm"
              />
            </div>

            {/* Modo */}
            <div className="flex rounded-md border overflow-hidden">
              <button
                onClick={() => setMode('imbalanced')}
                className={`px-3 py-2 text-xs font-bold ${
                  mode === 'imbalanced'
                    ? 'bg-rose-600 text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                ⚖️ Desequilibrados
              </button>
              <button
                onClick={() => setMode('all')}
                className={`px-3 py-2 text-xs font-bold ${
                  mode === 'all'
                    ? 'bg-slate-700 text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                Todos
              </button>
            </div>

            {/* Settings avançado */}
            <button
              onClick={() => setShowSettings((s) => !s)}
              className="px-3 py-2 bg-slate-100 hover:bg-slate-200 rounded-md text-xs font-bold text-slate-600 flex items-center gap-1.5"
            >
              <Settings2 className="w-3.5 h-3.5" />
              {showSettings ? 'Ocultar' : 'Avançado'}
            </button>

            <button
              onClick={limparFiltros}
              className="px-3 py-2 text-xs font-bold text-slate-500 hover:text-slate-700"
            >
              Limpar
            </button>
          </div>

          {/* Settings avançado */}
          {showSettings && (
            <div className="pt-2 border-t border-slate-100 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs font-semibold text-slate-700">
                  📏 Tamanhos:
                </label>
                <div className="flex flex-wrap gap-1">
                  {PLUS_SIZE_DEFAULT.map((t) => (
                    <button
                      key={t}
                      onClick={() =>
                        setTamanhos((prev) =>
                          prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
                        )
                      }
                      className={`px-2 py-1 rounded text-xs font-bold ${
                        tamanhos.includes(t)
                          ? 'bg-violet-600 text-white'
                          : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <label className="text-xs font-semibold text-slate-700">
                  📊 Mín. peças por variação (código de barras):
                </label>
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={minTotal}
                  onChange={(e) => setMinTotal(Math.max(0, Number(e.target.value) || 0))}
                  className="w-16 px-2 py-1 border rounded text-sm font-mono"
                />
                <span className="text-xs text-slate-500">
                  ↳ cada REF + COR + TAMANHO = 1 código de barras (variação). Só analisa
                  se alguma loja tiver pelo menos essa quantidade DESSA variação específica.
                </span>
              </div>
            </div>
          )}

          {/* Banner: filtros mudaram desde a última busca */}
          {filtersDirty && (
            <div className="bg-amber-100 border-2 border-amber-400 rounded-lg p-3 flex items-center gap-3 animate-pulse">
              <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0" />
              <div className="flex-1 text-sm text-amber-900">
                <strong>Filtros mudaram desde a última busca.</strong> Os dados abaixo são da
                consulta anterior. Clique em <strong>"Atualizar"</strong> pra ver os novos resultados.
              </div>
              <button
                onClick={fetchData}
                disabled={loading}
                className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-bold flex items-center gap-2 shrink-0"
              >
                <RefreshCw className="w-4 h-4" />
                Atualizar agora
              </button>
            </div>
          )}
        </div>

        {/* Aviso truncado */}
        {data?.truncated && (
          <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs text-amber-800 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            Resultado limitado a 1500 produtos. Filtre por categoria/busca pra refinar.
          </div>
        )}

        {/* Tabela */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          {loading ? (
            <div className="p-12 text-center">
              <Loader2 className="w-8 h-8 animate-spin text-violet-600 mx-auto" />
              <div className="text-sm text-slate-500 mt-2">Carregando distribuição...</div>
            </div>
          ) : error ? (
            <div className="p-8 text-center">
              <AlertCircle className="w-8 h-8 text-rose-600 mx-auto" />
              <div className="text-sm text-rose-700 font-bold mt-2">{error}</div>
              <button
                onClick={fetchData}
                className="mt-3 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-sm rounded-md font-bold"
              >
                Tentar novamente
              </button>
            </div>
          ) : !data ? (
            // Estado inicial — ainda não fez nenhuma busca
            <div className="p-12 text-center">
              <Search className="w-12 h-12 text-violet-400 mx-auto" />
              <div className="text-base font-bold text-slate-700 mt-3">
                Aplique os filtros desejados e clique em <span className="text-violet-700">Atualizar</span>
              </div>
              <div className="text-xs text-slate-500 mt-1">
                A consulta é pesada no Giga — só carrega quando você manda.
                Pode escolher categoria, tamanhos ou buscar uma REF antes.
              </div>
            </div>
          ) : data.rows.length === 0 ? (
            <div className="p-12 text-center">
              <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto" />
              <div className="text-base font-bold text-slate-700 mt-3">
                {mode === 'imbalanced'
                  ? 'Nenhuma variação desequilibrada nos filtros atuais!'
                  : 'Nenhuma variação encontrada nos filtros'}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {mode === 'imbalanced'
                  ? 'Tente "Todos" pra ver o estoque completo.'
                  : 'Ajuste os filtros e tente novamente.'}
              </div>
            </div>
          ) : (
            <VariationMapView
              rows={data.rows}
              lojas={data.lojas}
              storeNameByCode={storeNameByCode}
              lojaLabel={lojaLabel}
              onRealinhar={realinharGrupo}
            />
          )}
        </div>

          </>
        )}

        {/* Legenda — só mostra na aba de distribuição */}
        {activeTab === 'distribuicao' && (
        <div className="bg-white border border-slate-200 rounded-lg p-3 text-xs text-slate-600 space-y-1.5">
          <div className="font-bold text-slate-700">Legenda das bolinhas (estoque por variação na loja):</div>
          <div className="flex flex-wrap gap-x-5 gap-y-1.5 items-center">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-red-500" /> ZERO
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-orange-500" /> apenas 1
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-yellow-400" /> 2 (baixo)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-green-500" /> 3-4 saudável
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-blue-500" /> 5-9 excesso
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-purple-600" /> 10+ concentrando
            </span>
          </div>
        </div>
        )}
      </main>

      {/* ─── Drawer de realinhamento inline ─── */}
      {drawerGroup && (
        <RealignDrawer
          group={drawerGroup}
          stores={stores}
          storeNameByCode={storeNameByCode}
          onClose={() => setDrawerGroup(null)}
        />
      )}

      {/* ─── Modal "Realinhar TODOS" — batch de todas as variações desequilibradas ─── */}
      {showRealignAllModal && data && (
        <RealignAllModal
          rows={data.rows}
          stores={stores}
          storeNameByCode={storeNameByCode}
          onClose={() => setShowRealignAllModal(false)}
          onSuccess={() => {
            setShowRealignAllModal(false);
            fetchData();
          }}
        />
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   VariationMapView — visualização por REF+COR com matriz LOJA × TAMANHO
   Cada card = 1 modelo de cor. Bolinha colorida codifica criticidade.
   ════════════════════════════════════════════════════════════════════════ */

/* Tipo Row já está declarado no topo do arquivo (linha 32) */

/* Tipo de grupo exportado pra usar no drawer */
export type GroupDrawer = {
  key: string;
  ref: string;
  cor: string;
  descricao: string;
  preco: number;
  tamanhos: string[];
  items: Row[];
  totalRede: number;
  criticidadeAlta: number;
};

/* VariationMapView — TABELA PLANILHÃO estilo Giga.
   1 linha = 1 variação (código de barras). Colunas = lojas + total + ações.
   Bolinhas coloridas por célula. Botão "Realinhar" passa o GROUP (REF+COR)
   inteiro pro drawer (que mostra a matriz tamanho × loja). */
function VariationMapView({
  rows,
  lojas,
  storeNameByCode,
  lojaLabel,
  onRealinhar,
}: {
  rows: Row[];
  lojas: string[];
  storeNameByCode: Map<string, string>;
  lojaLabel: (code: string) => string;
  onRealinhar: (group: GroupDrawer) => void;
}) {
  // Computa groups por REF+COR (necessário pra abrir o drawer com contexto)
  const { groups, rowToGroup } = useMemo(() => {
    const map = new Map<string, GroupDrawer>();
    const rowMap = new Map<string, GroupDrawer>(); // codigo → group
    for (const r of rows) {
      const cor = (r.cor || 'SEM COR').trim().toUpperCase();
      const ref = r.ref || '—';
      const key = `${ref}|${cor}`;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          ref,
          cor,
          descricao: r.descricao,
          preco: r.preco,
          tamanhos: [],
          items: [],
          totalRede: 0,
          criticidadeAlta: 0,
        };
        map.set(key, g);
      }
      g.items.push(r);
      g.totalRede += r.total;
      if (r.criticidade === 'ALTO') g.criticidadeAlta++;
      if (r.preco > g.preco) g.preco = r.preco;
      rowMap.set(r.codigo, g);
    }
    for (const g of map.values()) {
      const tamSet = new Set<string>();
      for (const it of g.items) if (it.tamanho) tamSet.add(it.tamanho.trim());
      g.tamanhos = Array.from(tamSet).sort((a, b) => {
        const na = parseInt(a, 10);
        const nb = parseInt(b, 10);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
      });
    }
    return { groups: Array.from(map.values()), rowToGroup: rowMap };
  }, [rows]);

  // Ordenação:
  //   1º — DESCRIÇÃO alfabética (ex: "VESTIDO ESTAMPA MARINHO" antes de "VESTIDO ESTAMPA PRETO")
  //   2º — dentro da mesma descrição, TAMANHO numérico crescente (46, 48, 50, ...)
  // Critérios numéricos pra combinações tipo "46/48" (parse só do primeiro número).
  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const da = (a.descricao || '').toUpperCase();
      const db = (b.descricao || '').toUpperCase();
      if (da !== db) return da.localeCompare(db);
      // mesma descrição → ordena por tamanho numericamente
      const ta = (a.tamanho || '').trim();
      const tb = (b.tamanho || '').trim();
      const na = parseInt(ta, 10);
      const nb = parseInt(tb, 10);
      if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
      // fallback alfabético se tamanho não-numérico (P, M, G, GG, etc)
      return ta.localeCompare(tb);
    });
  }, [rows]);

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className="overflow-auto max-h-[calc(100vh-280px)]">
        <table className="w-full text-xs">
          <thead className="bg-slate-100 text-slate-700 sticky top-0 z-10 border-b-2 border-slate-300">
            <tr>
              <th className="px-2 py-2 text-left font-bold sticky left-0 bg-slate-100 z-20 min-w-[90px] border-r border-slate-300">
                CÓDIGO
              </th>
              <th className="px-2 py-2 text-left font-bold sticky left-[90px] bg-slate-100 z-20 min-w-[380px] border-r border-slate-300">
                DESCRIÇÃO
              </th>
              <th className="px-2 py-2 text-right font-bold min-w-[70px] border-r border-slate-300">
                PREÇO
              </th>
              {lojas.map((lj) => (
                <th
                  key={lj}
                  className="px-1 py-2 text-center font-bold min-w-[52px]"
                  title={storeNameByCode.get(lj) || lj}
                >
                  {lojaLabel(lj)}
                </th>
              ))}
              <th className="px-2 py-2 text-center font-bold bg-violet-700 text-white sticky right-[100px] min-w-[50px]">
                TOT
              </th>
              <th className="px-2 py-2 text-center font-bold bg-violet-700 text-white sticky right-0 min-w-[100px]">
                AÇÃO
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => {
              const group = rowToGroup.get(row.codigo);
              const bgRow =
                row.criticidade === 'ALTO'
                  ? 'bg-rose-50 hover:bg-rose-100'
                  : row.criticidade === 'MEDIO'
                  ? 'bg-amber-50 hover:bg-amber-100'
                  : 'hover:bg-slate-50';
              return (
                <tr key={row.codigo} className={`${bgRow} border-b border-slate-100 transition-colors`}>
                  <td className="px-2 py-1.5 font-mono text-slate-700 sticky left-0 bg-inherit z-10 border-r border-slate-200">
                    {row.codigo}
                  </td>
                  <td className="px-2 py-1.5 sticky left-[90px] bg-inherit z-10 border-r border-slate-200">
                    <div className="font-semibold text-slate-800" title={row.descricao}>
                      {row.descricao || `${row.ref} ${row.cor || ''}/${row.tamanho || ''}`}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-slate-600 border-r border-slate-200">
                    {row.preco > 0 ? brl(row.preco) : '—'}
                  </td>
                  {lojas.map((lj) => {
                    const qty = row.estoquePorLoja[lj] ?? 0;
                    return (
                      <td key={lj} className="px-1 py-1.5 text-center">
                        <Bolinha qty={qty} />
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5 text-center font-mono font-black text-violet-700 bg-violet-50 sticky right-[100px]">
                    {row.total}
                  </td>
                  <td className="px-2 py-1.5 text-center sticky right-0 bg-white">
                    {group && row.criticidade !== 'OK' ? (
                      <button
                        onClick={() => onRealinhar(group)}
                        className={`px-2 py-1 rounded text-[10px] font-bold flex items-center gap-1 mx-auto ${
                          row.criticidade === 'ALTO'
                            ? 'bg-rose-600 hover:bg-rose-700 text-white'
                            : 'bg-amber-500 hover:bg-amber-600 text-white'
                        }`}
                        title="Sugerir realinhamento dessa REF+COR"
                      >
                        <Shuffle className="w-3 h-3" />
                        Realinhar
                      </button>
                    ) : (
                      <span className="text-emerald-600">🟢</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-2 border-t border-slate-200 text-xs text-slate-500 bg-slate-50">
        {sortedRows.length} variação(ões) · {groups.length} REF+COR únicos
      </div>
    </div>
  );
}

/* lojaLabel está no componente principal — passado via prop pro VariationMapView.
   VariationCard antigo (matriz LOJA × TAMANHO em card) foi removido —
   substituído por VariationMapView (tabela planilha 1 linha = 1 variação). */

/* ════════════════════════════════════════════════════════════════════════
   RealignDrawer — sugestão automática de balanço entre lojas
   Algoritmo por TAMANHO:
     1. Soma o estoque total daquele tamanho na rede
     2. Lojas elegíveis = ativas, exceto SITE/PF, ordenadas por priorityScore desc
     3. Distribuição target:
        - Se total >= N lojas: cada uma ganha 1 base, excedente vai pras top
        - Se total <  N lojas: só as top recebem 1 cada
     4. Calcula movimentos: surplus em A → deficit em B
   ════════════════════════════════════════════════════════════════════════ */

type Move = { from: string; to: string; tamanho: string; qty: number };

function RealignDrawer({
  group,
  stores,
  storeNameByCode,
  onClose,
}: {
  group: GroupDrawer;
  stores: Store[];
  storeNameByCode: Map<string, string>;
  onClose: () => void;
}) {
  // ── Config de participação (canSendRealign + canReceiveRealign) ──
  // Lê do Store. Default: ambos true (compatibilidade com sistema antigo).
  // Filtra também SITE e PF que não são lojas físicas.
  const ignoredCodes = new Set(['SITE', 'PF']);
  const sendableStores = useMemo(
    () =>
      stores
        .filter(
          (s) =>
            s.active &&
            !ignoredCodes.has(s.code) &&
            (s as any).canSendRealign !== false,
        )
        .sort(
          (a, b) => ((b as any).priorityScore ?? 50) - ((a as any).priorityScore ?? 50),
        ),
    [stores],
  );
  const receivableStores = useMemo(
    () =>
      stores
        .filter(
          (s) =>
            s.active &&
            !ignoredCodes.has(s.code) &&
            (s as any).canReceiveRealign !== false,
        )
        .sort(
          (a, b) => ((b as any).priorityScore ?? 50) - ((a as any).priorityScore ?? 50),
        ),
    [stores],
  );
  // Todas as lojas que aparecem na matriz (cede OU recebe — pra ver atual + alvo)
  const eligibleStores = useMemo(() => {
    const set = new Map<string, Store>();
    for (const s of sendableStores) set.set(s.code, s);
    for (const s of receivableStores) set.set(s.code, s);
    return Array.from(set.values()).sort(
      (a, b) => ((b as any).priorityScore ?? 50) - ((a as any).priorityScore ?? 50),
    );
  }, [sendableStores, receivableStores]);

  // Matriz atual por tamanho × loja
  const currentMatrix = useMemo(() => {
    const m: Record<string, Record<string, number>> = {};
    for (const tam of group.tamanhos) m[tam] = {};
    for (const it of group.items) {
      const tam = (it.tamanho || '').trim();
      for (const [lj, q] of Object.entries(it.estoquePorLoja || {})) {
        if (!m[tam]) m[tam] = {};
        m[tam][lj] = q;
      }
    }
    return m;
  }, [group]);

  // Calcula target por tamanho usando algoritmo de balanço
  const { targetMatrix, moves } = useMemo(() => {
    const target: Record<string, Record<string, number>> = {};
    const allMoves: Move[] = [];

    for (const tam of group.tamanhos) {
      target[tam] = {};
      const currentByStore = currentMatrix[tam] || {};

      // Total disponível (soma de TODAS as lojas, mesmo as não-sendable —
      // peças existem mas só lojas sendable podem ceder)
      const totalAvailable = Object.values(currentByStore).reduce((s, v) => s + (v || 0), 0);

      // Inicializa target = 0 pra todas que aparecem na matriz
      for (const s of eligibleStores) target[tam][s.code] = 0;

      // Distribui SÓ pra lojas que podem RECEBER (receivableStores)
      if (totalAvailable === 0 || receivableStores.length === 0) {
        // nada a fazer
      } else if (totalAvailable >= receivableStores.length) {
        // 1 base pra cada loja que recebe, sobra distribuída por prioridade
        let remaining = totalAvailable;
        for (const s of receivableStores) {
          target[tam][s.code] = 1;
          remaining--;
        }
        let i = 0;
        while (remaining > 0) {
          target[tam][receivableStores[i % receivableStores.length].code]++;
          remaining--;
          i++;
        }
      } else {
        // Não dá pra todas: PROTEGE quem já tem estoque (não zerar ninguém!)
        // 1º: target=1 pras lojas que JÁ têm ≥ 1 (evita movimento desnecessário)
        // 2º: target=1 pras restantes por priorityScore até acabar
        let remaining = totalAvailable;
        const withStock = receivableStores.filter(
          (s) => (currentByStore[s.code] || 0) >= 1,
        );
        const withoutStock = receivableStores.filter(
          (s) => (currentByStore[s.code] || 0) === 0,
        );
        for (const s of withStock) {
          if (remaining <= 0) break;
          target[tam][s.code] = 1;
          remaining--;
        }
        for (const s of withoutStock) {
          if (remaining <= 0) break;
          target[tam][s.code] = 1;
          remaining--;
        }
      }

      // Calcula movimentos: surplus de SENDABLE → deficit de RECEIVABLE
      const sources: Array<{ code: string; surplus: number }> = [];
      const sinks: Array<{ code: string; deficit: number }> = [];
      const sendableCodes = new Set(sendableStores.map((s) => s.code));
      const receivableCodes = new Set(receivableStores.map((s) => s.code));
      for (const s of eligibleStores) {
        const cur = currentByStore[s.code] || 0;
        const tgt = target[tam][s.code] || 0;
        const diff = cur - tgt;
        if (diff > 0 && sendableCodes.has(s.code)) {
          sources.push({ code: s.code, surplus: diff });
        } else if (diff < 0 && receivableCodes.has(s.code)) {
          sinks.push({ code: s.code, deficit: -diff });
        }
      }

      // Greedy match
      for (const sink of sinks) {
        while (sink.deficit > 0 && sources.length > 0) {
          const src = sources[0];
          const transfer = Math.min(src.surplus, sink.deficit);
          if (transfer > 0) {
            allMoves.push({ from: src.code, to: sink.code, tamanho: tam, qty: transfer });
            src.surplus -= transfer;
            sink.deficit -= transfer;
          }
          if (src.surplus === 0) sources.shift();
        }
      }
    }

    return { targetMatrix: target, moves: allMoves };
  }, [currentMatrix, eligibleStores, group.tamanhos]);

  const totalMoves = moves.reduce((s, m) => s + m.qty, 0);

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-30 backdrop-blur-sm" onClick={onClose} />
      <aside className="fixed right-0 top-0 bottom-0 w-full md:w-[860px] bg-white shadow-2xl z-40 overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-slate-200 px-5 py-3 flex items-center justify-between z-10">
          <div className="flex items-baseline gap-3">
            <Shuffle className="w-5 h-5 text-violet-600" />
            <span className="font-mono font-black text-lg text-slate-800">
              REF {group.ref}
            </span>
            <span className="font-bold text-slate-600 uppercase text-sm">
              — {group.cor}
            </span>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Resumo */}
          <div className="bg-violet-50 border border-violet-200 rounded-lg p-3 text-sm">
            <div className="flex items-center justify-between mb-1">
              <span className="font-bold text-violet-900">
                💡 Sugestão de realinhamento
              </span>
              <span className="font-mono font-bold text-violet-900 text-lg">
                {moves.length} movimento(s) · {totalMoves} peça(s)
              </span>
            </div>
            <p className="text-xs text-violet-700">
              Regra: todas as lojas com ≥ 1 quando possível. Em caso de excesso,
              prioridade pelas lojas com maior <code>priorityScore</code>.
              SITE e PF ignorados.
            </p>
          </div>

          {/* Matriz Atual × Sugerida */}
          <div>
            <h4 className="font-bold text-slate-800 mb-2">Estoque por tamanho</h4>
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-2 py-2 text-left font-bold text-slate-600 sticky left-0 bg-slate-50 min-w-[160px]">
                      Loja
                    </th>
                    {group.tamanhos.map((t) => (
                      <th
                        key={t}
                        colSpan={2}
                        className="px-1 py-1 text-center font-bold text-slate-700 border-l border-slate-200 min-w-[80px]"
                      >
                        {t}
                      </th>
                    ))}
                  </tr>
                  <tr className="text-[10px] uppercase tracking-wider bg-slate-100">
                    <th className="px-2 py-1 sticky left-0 bg-slate-100"></th>
                    {group.tamanhos.map((t) => (
                      <Fragment key={t}>
                        <th className="px-1 py-1 text-center text-slate-500 border-l border-slate-200">
                          Atual
                        </th>
                        <th className="px-1 py-1 text-center text-violet-700">→ Alvo</th>
                      </Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {eligibleStores.map((s) => {
                    const nome = storeNameByCode.get(s.code) || s.name;
                    return (
                      <tr key={s.code} className="border-t border-slate-100">
                        <td className="px-2 py-1.5 sticky left-0 bg-white font-medium text-slate-700">
                          <span className="font-mono text-[10px] text-slate-400 mr-1">
                            {s.code}
                          </span>
                          {nome.replace(/^Lurd's\s*/i, '')}
                        </td>
                        {group.tamanhos.map((tam) => {
                          const cur = currentMatrix[tam]?.[s.code] ?? 0;
                          const tgt = targetMatrix[tam]?.[s.code] ?? 0;
                          const diff = tgt - cur;
                          return (
                            <Fragment key={tam}>
                              <td className="px-1 py-1 text-center border-l border-slate-100">
                                <span className="font-mono text-slate-600">{cur}</span>
                              </td>
                              <td className="px-1 py-1 text-center">
                                <span
                                  className={`font-mono font-bold ${
                                    diff > 0
                                      ? 'text-emerald-700'
                                      : diff < 0
                                      ? 'text-rose-700'
                                      : 'text-slate-400'
                                  }`}
                                >
                                  {tgt}
                                  {diff !== 0 && (
                                    <span className="text-[10px] ml-0.5">
                                      ({diff > 0 ? '+' : ''}
                                      {diff})
                                    </span>
                                  )}
                                </span>
                              </td>
                            </Fragment>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Lista de movimentos sugeridos */}
          <div>
            <h4 className="font-bold text-slate-800 mb-2">
              Transferências sugeridas ({moves.length})
            </h4>
            {moves.length === 0 ? (
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-800">
                ✓ Distribuição já está balanceada — nenhuma transferência necessária.
              </div>
            ) : (
              <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-[300px] overflow-y-auto">
                {moves.map((m, i) => (
                  <div key={i} className="px-3 py-2 flex items-center gap-3 text-sm hover:bg-slate-50">
                    <span className="font-mono font-bold text-rose-600 w-12 text-right">
                      −{m.qty}
                    </span>
                    <span className="flex-1 truncate">
                      <span className="font-mono text-[10px] text-slate-400 mr-1">
                        {m.from}
                      </span>
                      <span className="font-medium">
                        {(storeNameByCode.get(m.from) || m.from).replace(/^Lurd's\s*/i, '')}
                      </span>
                    </span>
                    <span className="text-slate-400">→</span>
                    <span className="flex-1 truncate">
                      <span className="font-mono text-[10px] text-slate-400 mr-1">
                        {m.to}
                      </span>
                      <span className="font-medium">
                        {(storeNameByCode.get(m.to) || m.to).replace(/^Lurd's\s*/i, '')}
                      </span>
                    </span>
                    <span className="font-mono font-bold text-emerald-700 w-12">
                      +{m.qty}
                    </span>
                    <span className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded font-bold">
                      Tam {m.tamanho}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Ações */}
          {moves.length > 0 && (
            <ApplyRealignment
              group={group}
              moves={moves}
              onClose={onClose}
            />
          )}
        </div>
      </aside>
    </>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   RealignAllModal — processa TODAS as variações desequilibradas de uma vez.
   Roda o mesmo algoritmo de balanço pra cada (REF + COR + TAMANHO),
   consolida os moves e cria todas as transferências em UMA chamada.
   ════════════════════════════════════════════════════════════════════════ */

interface AllMove {
  ref: string;
  cor: string;
  tamanho: string;
  sku: string;
  desc: string;
  from: string;
  to: string;
  qty: number;
}

function RealignAllModal({
  rows,
  stores,
  storeNameByCode,
  onClose,
  onSuccess,
}: {
  rows: Row[];
  stores: Store[];
  storeNameByCode: Map<string, string>;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Lojas elegíveis (respeita canSendRealign/canReceiveRealign)
  const ignoredCodes = new Set(['SITE', 'PF']);
  const sendableStores = useMemo(
    () =>
      stores
        .filter(
          (s) =>
            s.active && !ignoredCodes.has(s.code) && (s as any).canSendRealign !== false,
        )
        .sort(
          (a, b) =>
            ((b as any).priorityScore ?? 50) - ((a as any).priorityScore ?? 50),
        ),
    [stores],
  );
  const receivableStores = useMemo(
    () =>
      stores
        .filter(
          (s) =>
            s.active && !ignoredCodes.has(s.code) && (s as any).canReceiveRealign !== false,
        )
        .sort(
          (a, b) =>
            ((b as any).priorityScore ?? 50) - ((a as any).priorityScore ?? 50),
        ),
    [stores],
  );

  // Algoritmo: pra cada variação, calcula moves (mesmo algoritmo do drawer)
  const allMoves: AllMove[] = useMemo(() => {
    const result: AllMove[] = [];
    const sendableCodes = new Set(sendableStores.map((s) => s.code));
    const receivableCodes = new Set(receivableStores.map((s) => s.code));

    for (const row of rows) {
      if (row.criticidade === 'OK') continue;
      const currentByStore = row.estoquePorLoja || {};
      const totalAvailable = Object.values(currentByStore).reduce((s, v) => s + (v || 0), 0);
      if (totalAvailable === 0 || receivableStores.length === 0) continue;

      const target: Record<string, number> = {};
      const allStores = new Set([...sendableCodes, ...receivableCodes]);
      for (const code of allStores) target[code] = 0;

      if (totalAvailable >= receivableStores.length) {
        let remaining = totalAvailable;
        for (const s of receivableStores) {
          target[s.code] = 1;
          remaining--;
        }
        let i = 0;
        while (remaining > 0) {
          target[receivableStores[i % receivableStores.length].code]++;
          remaining--;
          i++;
        }
      } else {
        // Não dá pra todas: PROTEGE quem já tem estoque (não zerar ninguém!)
        let remaining = totalAvailable;
        const withStock = receivableStores.filter(
          (s) => (currentByStore[s.code] || 0) >= 1,
        );
        const withoutStock = receivableStores.filter(
          (s) => (currentByStore[s.code] || 0) === 0,
        );
        for (const s of withStock) {
          if (remaining <= 0) break;
          target[s.code] = 1;
          remaining--;
        }
        for (const s of withoutStock) {
          if (remaining <= 0) break;
          target[s.code] = 1;
          remaining--;
        }
      }

      // Sources e sinks
      const sources: Array<{ code: string; surplus: number }> = [];
      const sinks: Array<{ code: string; deficit: number }> = [];
      for (const code of allStores) {
        const cur = currentByStore[code] || 0;
        const tgt = target[code] || 0;
        const diff = cur - tgt;
        if (diff > 0 && sendableCodes.has(code)) {
          sources.push({ code, surplus: diff });
        } else if (diff < 0 && receivableCodes.has(code)) {
          sinks.push({ code, deficit: -diff });
        }
      }

      // Greedy match
      for (const sink of sinks) {
        while (sink.deficit > 0 && sources.length > 0) {
          const src = sources[0];
          const transfer = Math.min(src.surplus, sink.deficit);
          if (transfer > 0) {
            result.push({
              ref: row.ref,
              cor: (row.cor || '').trim() || 'SEM COR',
              tamanho: (row.tamanho || '').trim(),
              sku: row.codigo,
              desc: row.descricao,
              from: src.code,
              to: sink.code,
              qty: transfer,
            });
            src.surplus -= transfer;
            sink.deficit -= transfer;
          }
          if (src.surplus === 0) sources.shift();
        }
      }
    }

    return result;
  }, [rows, sendableStores, receivableStores]);

  // Stats agregadas
  const stats = useMemo(() => {
    const totalQty = allMoves.reduce((s, m) => s + m.qty, 0);
    const uniqueRefs = new Set(allMoves.map((m) => m.ref)).size;
    const fromStoresSet = new Set(allMoves.map((m) => m.from));
    const toStoresSet = new Set(allMoves.map((m) => m.to));

    // Top origens e destinos
    const byFrom: Record<string, number> = {};
    const byTo: Record<string, number> = {};
    for (const m of allMoves) {
      byFrom[m.from] = (byFrom[m.from] || 0) + m.qty;
      byTo[m.to] = (byTo[m.to] || 0) + m.qty;
    }
    const topFrom = Object.entries(byFrom).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const topTo = Object.entries(byTo).sort((a, b) => b[1] - a[1]).slice(0, 5);

    return {
      totalMoves: allMoves.length,
      totalQty,
      uniqueRefs,
      lojasOrigem: fromStoresSet.size,
      lojasDestino: toStoresSet.size,
      topFrom,
      topTo,
    };
  }, [allMoves]);

  const apply = async () => {
    if (allMoves.length === 0) return;
    if (
      !confirm(
        `Vai criar ${stats.totalMoves} ordens de transferência (${stats.totalQty} peças) ` +
          `entre ${stats.lojasOrigem} lojas origem e ${stats.lojasDestino} lojas destino.\n\n` +
          `Cada loja origem vai receber cards de realinhamento na tela /minha-loja/realinhamento.\n\n` +
          `Confirma?`,
      )
    ) return;

    setApplying(true);
    setResult(null);
    try {
      const plan = allMoves.map((m) => ({
        sku: m.sku,
        ref: m.ref,
        cor: m.cor === 'SEM COR' ? null : m.cor,
        tamanho: m.tamanho,
        desc: m.desc,
        fromCode: m.from,
        toCode: m.to,
        qty: m.qty,
      }));

      const res = await api<{ created: number; errors?: any[] }>(
        '/realignment/confirm',
        {
          method: 'POST',
          body: JSON.stringify({
            plan,
            note: `Realinhamento em LOTE · ${stats.totalMoves} movimentos · gerado pela tela de Distribuição`,
          }),
        },
      );

      setResult({
        ok: true,
        msg: `✓ ${res.created || allMoves.length} ordens criadas com sucesso. Lojas origem já recebendo notificação.`,
      });
      setTimeout(() => onSuccess(), 2500);
    } catch (e: any) {
      setResult({
        ok: false,
        msg: e?.message || 'Falha ao criar transferências',
      });
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-rose-50 to-violet-50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-rose-100 flex items-center justify-center">
              <Shuffle className="w-5 h-5 text-rose-700" />
            </div>
            <div>
              <h2 className="font-bold text-slate-900 text-lg">Realinhar TODOS</h2>
              <p className="text-xs text-slate-500">
                Balanço automático de todas as variações desequilibradas
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/60 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {allMoves.length === 0 ? (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-6 text-center">
              <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-2" />
              <div className="font-bold text-emerald-900">Nada pra realinhar!</div>
              <div className="text-xs text-emerald-700 mt-1">
                Todas as variações filtradas estão equilibradas OU não tem peças disponíveis pra distribuir.
              </div>
            </div>
          ) : (
            <>
              {/* Resumo */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="bg-rose-50 border border-rose-200 rounded p-3 text-center">
                  <div className="text-2xl font-black text-rose-700">{stats.totalMoves}</div>
                  <div className="text-[10px] uppercase font-bold text-rose-800 tracking-wider">Movimentos</div>
                </div>
                <div className="bg-violet-50 border border-violet-200 rounded p-3 text-center">
                  <div className="text-2xl font-black text-violet-700">{stats.totalQty}</div>
                  <div className="text-[10px] uppercase font-bold text-violet-800 tracking-wider">Peças</div>
                </div>
                <div className="bg-blue-50 border border-blue-200 rounded p-3 text-center">
                  <div className="text-2xl font-black text-blue-700">{stats.uniqueRefs}</div>
                  <div className="text-[10px] uppercase font-bold text-blue-800 tracking-wider">REFs</div>
                </div>
                <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-center">
                  <div className="text-2xl font-black text-emerald-700">
                    {stats.lojasOrigem}→{stats.lojasDestino}
                  </div>
                  <div className="text-[10px] uppercase font-bold text-emerald-800 tracking-wider">Lojas</div>
                </div>
              </div>

              {/* Top origens e destinos */}
              <div className="grid grid-cols-2 gap-3">
                <div className="border border-slate-200 rounded-lg p-3">
                  <div className="text-[11px] uppercase font-bold text-slate-500 tracking-wider mb-2">
                    Top 5 origens (envia)
                  </div>
                  <div className="space-y-1">
                    {stats.topFrom.map(([code, qty]) => (
                      <div key={code} className="flex items-center justify-between text-sm">
                        <span className="text-slate-700">
                          <span className="font-mono text-xs text-slate-400 mr-1">{code}</span>
                          {(storeNameByCode.get(code) || code).replace(/^Lurd's\s*/i, '')}
                        </span>
                        <span className="font-mono font-bold text-rose-600">−{qty}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="border border-slate-200 rounded-lg p-3">
                  <div className="text-[11px] uppercase font-bold text-slate-500 tracking-wider mb-2">
                    Top 5 destinos (recebe)
                  </div>
                  <div className="space-y-1">
                    {stats.topTo.map(([code, qty]) => (
                      <div key={code} className="flex items-center justify-between text-sm">
                        <span className="text-slate-700">
                          <span className="font-mono text-xs text-slate-400 mr-1">{code}</span>
                          {(storeNameByCode.get(code) || code).replace(/^Lurd's\s*/i, '')}
                        </span>
                        <span className="font-mono font-bold text-emerald-600">+{qty}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Preview de alguns moves */}
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-[11px] uppercase font-bold text-slate-600 tracking-wider">
                  Pré-visualização (primeiros 20 movimentos)
                </div>
                <div className="max-h-60 overflow-y-auto divide-y divide-slate-100">
                  {allMoves.slice(0, 20).map((m, i) => (
                    <div key={i} className="px-3 py-1.5 flex items-center gap-2 text-xs hover:bg-slate-50">
                      <span className="font-mono text-rose-600 w-10 text-right">−{m.qty}</span>
                      <span className="font-mono text-[10px] text-slate-400 w-8">{m.from}</span>
                      <span className="text-slate-400">→</span>
                      <span className="font-mono text-[10px] text-slate-400 w-8">{m.to}</span>
                      <span className="font-bold text-emerald-600 w-10">+{m.qty}</span>
                      <span className="flex-1 truncate text-slate-600">
                        REF <strong>{m.ref}</strong> · {m.cor} · Tam {m.tamanho}
                      </span>
                    </div>
                  ))}
                  {allMoves.length > 20 && (
                    <div className="px-3 py-2 text-center text-xs text-slate-500 bg-slate-50">
                      …e mais {allMoves.length - 20} movimentos
                    </div>
                  )}
                </div>
              </div>

              {result && (
                <div
                  className={`p-3 rounded-lg text-sm ${
                    result.ok
                      ? 'bg-emerald-50 border border-emerald-200 text-emerald-900'
                      : 'bg-rose-50 border border-rose-200 text-rose-900'
                  }`}
                >
                  {result.msg}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 flex items-center gap-2 bg-slate-50">
          <button
            onClick={onClose}
            disabled={applying}
            className="flex-1 px-4 py-2 rounded-lg bg-white border border-slate-300 hover:bg-slate-100 text-sm font-medium disabled:opacity-50"
          >
            Cancelar
          </button>
          {allMoves.length > 0 && !result?.ok && (
            <button
              onClick={apply}
              disabled={applying}
              className="flex-1 px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 text-white text-sm font-bold flex items-center justify-center gap-2"
            >
              {applying ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Criando {allMoves.length} ordens…
                </>
              ) : (
                <>
                  <Shuffle className="w-4 h-4" />
                  Aplicar TODOS ({allMoves.length})
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* Envia os moves pro endpoint /realignment/confirm */
function ApplyRealignment({
  group,
  moves,
  onClose,
}: {
  group: GroupDrawer;
  moves: Move[];
  onClose: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const apply = async () => {
    if (!confirm(
      `Vai criar ${moves.length} ordens de transferência (tipo REALINHAMENTO).\n\n` +
        `Cada loja origem vai receber um card na tela /minha-loja/realinhamento ` +
        `com foto do produto e os tamanhos a separar.\n\nConfirma?`,
    )) {
      return;
    }
    setApplying(true);
    setResult(null);
    try {
      // Monta plan[] no formato esperado por POST /realignment/confirm
      const plan = moves.map((m) => {
        // Acha o item correspondente (mesmo tamanho) pra pegar sku/ref/cor
        const item = group.items.find((it) => (it.tamanho || '').trim() === m.tamanho);
        return {
          sku: item?.codigo || '',
          ref: group.ref,
          cor: group.cor === 'SEM COR' ? null : group.cor,
          tamanho: m.tamanho,
          desc: group.descricao,
          fromCode: m.from,
          toCode: m.to,
          qty: m.qty,
        };
      });

      const res = await api<{ created: number; errors?: any[] }>(
        '/realignment/confirm',
        {
          method: 'POST',
          body: JSON.stringify({
            plan,
            note: `Realinhamento automático · ${group.ref} ${group.cor} · gerado pela tela de Distribuição`,
          }),
        },
      );

      setResult({
        ok: true,
        msg: `✓ ${res.created || moves.length} ordens criadas. Lojas origem já estão sendo notificadas.`,
      });
      // Fecha drawer após 2s
      setTimeout(() => onClose(), 2500);
    } catch (e: any) {
      setResult({
        ok: false,
        msg: e?.message || 'Falha ao criar transferências',
      });
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-3 pt-2 border-t border-slate-200">
      {result && (
        <div
          className={`p-3 rounded-lg text-sm ${
            result.ok
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border border-rose-200 text-rose-900'
          }`}
        >
          {result.msg}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={onClose}
          disabled={applying}
          className="flex-1 px-4 py-2.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-sm font-medium disabled:opacity-50"
        >
          Cancelar
        </button>
        <button
          onClick={apply}
          disabled={applying || !!result?.ok}
          className="flex-1 px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-700 disabled:bg-violet-300 text-white text-sm font-bold flex items-center justify-center gap-2"
        >
          {applying ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Criando ordens...
            </>
          ) : (
            <>
              <Shuffle className="w-4 h-4" />
              Aplicar e criar {moves.length} transferência{moves.length > 1 ? 's' : ''}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   RealignConfigPanel — aba de config de quem participa do realinhamento
   Cada loja tem 2 toggles: pode CEDER · pode RECEBER
   Salva em batch via POST /stores/realign-config/update
   ════════════════════════════════════════════════════════════════════════ */

type RealignConfigItem = {
  code: string;
  name: string;
  city: string | null;
  tipo: string;
  priorityScore: number;
  canSendRealign: boolean;
  canReceiveRealign: boolean;
  // Sprint 0 — Consolidação de grade
  consolidationScore?: number;
  isOutlet?: boolean;
};

function RealignConfigPanel() {
  const [items, setItems] = useState<RealignConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<RealignConfigItem[]>('/stores/realign-config/list');
      setItems(data);
      setDirty(false);
    } catch (e: any) {
      setSaveResult({ ok: false, msg: e?.message || 'Erro ao carregar' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleSend = (code: string) => {
    setItems((prev) =>
      prev.map((it) =>
        it.code === code ? { ...it, canSendRealign: !it.canSendRealign } : it,
      ),
    );
    setDirty(true);
  };
  const toggleReceive = (code: string) => {
    setItems((prev) =>
      prev.map((it) =>
        it.code === code ? { ...it, canReceiveRealign: !it.canReceiveRealign } : it,
      ),
    );
    setDirty(true);
  };
  const setConsolidationScore = (code: string, value: number) => {
    const clamped = Math.max(0, Math.min(200, Math.round(value) || 50));
    setItems((prev) =>
      prev.map((it) => (it.code === code ? { ...it, consolidationScore: clamped } : it)),
    );
    setDirty(true);
  };
  const toggleOutlet = (code: string) => {
    setItems((prev) =>
      prev.map((it) => (it.code === code ? { ...it, isOutlet: !it.isOutlet } : it)),
    );
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setSaveResult(null);
    try {
      await api('/stores/realign-config/update', {
        method: 'POST',
        body: JSON.stringify({
          items: items.map((it) => ({
            code: it.code,
            canSendRealign: it.canSendRealign,
            canReceiveRealign: it.canReceiveRealign,
            consolidationScore: it.consolidationScore ?? 50,
            isOutlet: !!it.isOutlet,
          })),
        }),
      });
      setSaveResult({ ok: true, msg: `✓ ${items.length} lojas atualizadas` });
      setDirty(false);
    } catch (e: any) {
      setSaveResult({ ok: false, msg: e?.message || 'Erro ao salvar' });
    } finally {
      setSaving(false);
    }
  };

  const stats = useMemo(() => {
    const both = items.filter((i) => i.canSendRealign && i.canReceiveRealign).length;
    const sendOnly = items.filter((i) => i.canSendRealign && !i.canReceiveRealign).length;
    const receiveOnly = items.filter((i) => !i.canSendRealign && i.canReceiveRealign).length;
    const none = items.filter((i) => !i.canSendRealign && !i.canReceiveRealign).length;
    return { both, sendOnly, receiveOnly, none };
  }, [items]);

  if (loading) {
    return (
      <div className="p-12 text-center bg-white border border-slate-200 rounded-lg">
        <Loader2 className="w-8 h-8 animate-spin text-violet-600 mx-auto" />
        <div className="text-sm text-slate-500 mt-2">Carregando lojas…</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Info card */}
      <div className="bg-violet-50 border border-violet-200 rounded-lg p-3 text-sm text-violet-900">
        <div className="font-bold mb-1">⚙️ Quem participa do realinhamento automático</div>
        <p className="text-xs text-violet-700">
          Configure aqui quais lojas o sistema considera na sugestão de balanço de estoque
          (botão "Sugerir realinhamento" nos cards da aba Distribuição). Lojas marcadas
          como "não cede" não vão aparecer como ORIGEM de transferências. Lojas marcadas
          como "não recebe" não vão aparecer como DESTINO.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
        <div className="bg-emerald-50 border border-emerald-200 rounded p-2">
          <div className="text-xs font-bold text-emerald-700 uppercase">Cede + Recebe</div>
          <div className="text-2xl font-bold text-emerald-700">{stats.both}</div>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded p-2">
          <div className="text-xs font-bold text-blue-700 uppercase">Só cede</div>
          <div className="text-2xl font-bold text-blue-700">{stats.sendOnly}</div>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded p-2">
          <div className="text-xs font-bold text-amber-700 uppercase">Só recebe</div>
          <div className="text-2xl font-bold text-amber-700">{stats.receiveOnly}</div>
        </div>
        <div className="bg-slate-100 border border-slate-300 rounded p-2">
          <div className="text-xs font-bold text-slate-600 uppercase">Não participa</div>
          <div className="text-2xl font-bold text-slate-600">{stats.none}</div>
        </div>
      </div>

      {/* Tabela */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="px-3 py-2 text-left text-[11px] uppercase font-bold text-slate-600 tracking-wider">Código</th>
              <th className="px-3 py-2 text-left text-[11px] uppercase font-bold text-slate-600 tracking-wider">Cidade / Nome</th>
              <th className="px-3 py-2 text-left text-[11px] uppercase font-bold text-slate-600 tracking-wider">Tipo</th>
              <th className="px-3 py-2 text-right text-[11px] uppercase font-bold text-slate-600 tracking-wider">Prioridade</th>
              <th className="px-3 py-2 text-center text-[11px] uppercase font-bold text-emerald-700 tracking-wider">Pode CEDER</th>
              <th className="px-3 py-2 text-center text-[11px] uppercase font-bold text-blue-700 tracking-wider">Pode RECEBER</th>
              <th className="px-3 py-2 text-center text-[11px] uppercase font-bold text-fuchsia-700 tracking-wider" title="Score (0-200) usado pra escolher loja destino na CONSOLIDAÇÃO de grade. Maior = mais ímã.">Score Consol.</th>
              <th className="px-3 py-2 text-center text-[11px] uppercase font-bold text-orange-700 tracking-wider" title="Loja OUTLET: recebe peças velhas (>X dias) prioritariamente.">Outlet</th>
              <th className="px-3 py-2 text-center text-[11px] uppercase font-bold text-slate-600 tracking-wider">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const status =
                it.canSendRealign && it.canReceiveRealign
                  ? { label: 'Cede + Recebe', cls: 'bg-emerald-100 text-emerald-800' }
                  : it.canSendRealign
                  ? { label: 'Só cede', cls: 'bg-blue-100 text-blue-800' }
                  : it.canReceiveRealign
                  ? { label: 'Só recebe', cls: 'bg-amber-100 text-amber-800' }
                  : { label: 'Não participa', cls: 'bg-slate-100 text-slate-600' };
              return (
                <tr key={it.code} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono font-bold text-slate-700">{it.code}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900">{it.city || it.name}</div>
                    {it.city && it.name !== it.city && (
                      <div className="text-xs text-slate-500">{it.name}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      it.tipo === 'FILIAL' ? 'bg-violet-100 text-violet-700' : 'bg-stone-100 text-stone-700'
                    }`}>
                      {it.tipo}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{it.priorityScore}</td>
                  <td className="px-3 py-2 text-center">
                    <ToggleSwitch checked={it.canSendRealign} onChange={() => toggleSend(it.code)} color="emerald" />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <ToggleSwitch checked={it.canReceiveRealign} onChange={() => toggleReceive(it.code)} color="blue" />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input
                      type="number"
                      min={0}
                      max={200}
                      step={10}
                      value={it.consolidationScore ?? 50}
                      onChange={(e) => setConsolidationScore(it.code, Number(e.target.value))}
                      className="w-16 px-2 py-1 text-center text-sm font-mono font-bold text-fuchsia-700 border border-fuchsia-200 rounded focus:border-fuchsia-500 focus:outline-none focus:ring-1 focus:ring-fuchsia-400"
                      title="0 a 200. Maior = loja mais 'ímã' pra concentrar grades."
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <ToggleSwitch checked={!!it.isOutlet} onChange={() => toggleOutlet(it.code)} color="orange" />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${status.cls}`}>
                      {status.label}
                    </span>
                    {it.isOutlet && (
                      <div className="text-[9px] font-bold text-orange-700 mt-0.5">🏷️ OUTLET</div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Save bar */}
      <div className="flex items-center gap-3 sticky bottom-2 bg-white border border-slate-200 rounded-lg p-3 shadow-md">
        {saveResult && (
          <div
            className={`text-xs flex-1 ${
              saveResult.ok ? 'text-emerald-700' : 'text-rose-700'
            }`}
          >
            {saveResult.msg}
          </div>
        )}
        <button
          onClick={load}
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-sm font-medium disabled:opacity-50"
        >
          Descartar
        </button>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="px-6 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 disabled:bg-slate-300 text-white text-sm font-bold flex items-center gap-2"
        >
          {saving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Salvando…
            </>
          ) : (
            <>💾 Salvar config ({items.length} lojas)</>
          )}
        </button>
      </div>
    </div>
  );
}

function ToggleSwitch({
  checked,
  onChange,
  color,
}: {
  checked: boolean;
  onChange: () => void;
  color: 'emerald' | 'blue' | 'orange' | 'fuchsia';
}) {
  const onBg =
    color === 'emerald' ? 'bg-emerald-500'
    : color === 'orange' ? 'bg-orange-500'
    : color === 'fuchsia' ? 'bg-fuchsia-500'
    : 'bg-blue-500';
  return (
    <button
      onClick={onChange}
      className={`relative w-11 h-6 rounded-full transition ${checked ? onBg : 'bg-slate-300'}`}
      title={checked ? 'Ativado' : 'Desativado'}
    >
      <span
        className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

/* Bolinha colorida — escala visual do estoque */
function Bolinha({ qty }: { qty: number }) {
  let bg = 'bg-red-500'; // 0
  if (qty === 1) bg = 'bg-orange-500';
  else if (qty === 2) bg = 'bg-yellow-400';
  else if (qty >= 3 && qty <= 4) bg = 'bg-green-500';
  else if (qty >= 5 && qty <= 9) bg = 'bg-blue-500';
  else if (qty >= 10) bg = 'bg-purple-600';

  // Texto branco em fundos escuros; preto em amarelo
  const textColor = qty === 2 ? 'text-stone-900' : 'text-white';

  return (
    <span
      className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold tabular-nums ${bg} ${textColor} shadow-sm`}
      title={`${qty} unidade${qty === 1 ? '' : 's'}`}
    >
      {qty}
    </span>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   RefRootView — Sprint 1 + 2 + 3
   Visão RAIZ: 1 linha por REF+COR. Filtros: data cadastro, categoria,
   subgrupo, busca por token. Cada linha mostra:
     - DESCRICAOCOMPLETA + REF · COR
     - Grupo / Subgrupo / DATAALT (idade da peça em dias)
     - tamanhos com estoque
     - Lojas com estoque (X/14)
     - Total de peças
     - MODO recomendado (Equilibrar / Consolidar / Outlet) — Sprint 2
     - Ação: ver detalhes (drill-down) ou consolidar (Sprint 3)
   ════════════════════════════════════════════════════════════════════════ */

type RefRow = {
  ref: string;
  cor: string | null;
  descricao: string;
  preco: number;
  dataAlt: string | null;
  grupoCodigo: number | null;
  subgrupoCodigo: number | null;
  grupoNome: string | null;
  subgrupoNome: string | null;
  tamanhos: string[];
  variacoes: number;
  lojasComEstoque: number;
  estoquePorLoja: Record<string, number>;
  total: number;
};

type RefDistribution = {
  refs: RefRow[];
  lojas: string[];
  totalRows: number;
  truncated: boolean;
};

type ModoRecomendado = 'EQUILIBRAR' | 'CONSOLIDAR' | 'OUTLET' | 'OK';

/**
 * Sprint 2 — Detector de modo automático.
 * Regras simples (configuráveis no futuro):
 *   - OUTLET:     DATAALT > 180 dias + total < 15
 *   - CONSOLIDAR: total < 12 + fragmentado em 5+ lojas
 *                 OU lojas com estoque = lojas-total mas todas com 1 peça
 *   - OK:         distribuição equilibrada (ninguém com 0 + max-min <= 1)
 *   - EQUILIBRAR: default (tem desequilíbrio)
 */
function detectarModo(r: RefRow, totalLojasAtivas: number): ModoRecomendado {
  // Calcula idade em dias
  const idadeDias = r.dataAlt
    ? Math.floor((Date.now() - new Date(r.dataAlt).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  // OUTLET: peça velha + pouco estoque restante
  if (idadeDias > 180 && r.total < 15) return 'OUTLET';

  // Estatísticas das lojas
  const vals = Object.values(r.estoquePorLoja).filter((v) => v > 0);
  if (vals.length === 0) return 'OK';

  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const allOnes = vals.every((v) => v === 1);

  // CONSOLIDAR: muito fragmentado (5+ lojas, todas com 1 peça)
  // OU pouca peça total espalhada em muitas lojas
  if ((vals.length >= 5 && allOnes) || (r.total < 12 && vals.length >= 4)) {
    return 'CONSOLIDAR';
  }

  // OK: distribuição já equilibrada (max-min <= 1 e total cobre lojas ativas)
  if (max - min <= 1 && vals.length >= totalLojasAtivas - 2) return 'OK';

  return 'EQUILIBRAR';
}

function RefRootView({ stores, grupos }: { stores: Store[]; grupos: GrupoItem[] }) {
  // ── Estado ──
  const [data, setData] = useState<RefDistribution | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Filtros ──
  const [grupoSelected, setGrupoSelected] = useState<number | null>(null);
  const [subgrupos, setSubgrupos] = useState<GrupoItem[]>([]);
  const [subgrupoSelected, setSubgrupoSelected] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [diasMax, setDiasMax] = useState<number | ''>(''); // peças NOVAS
  const [diasMin, setDiasMin] = useState<number | ''>(''); // peças VELHAS
  const [modeFilter, setModeFilter] = useState<'imbalanced' | 'all'>('imbalanced');
  const [minTotal, setMinTotal] = useState(2);
  const [drawerRef, setDrawerRef] = useState<RefRow | null>(null);
  const [consolidateRef, setConsolidateRef] = useState<RefRow | null>(null);

  // Filter local de modo (após detectar)
  const [filterMode, setFilterMode] = useState<'TODOS' | ModoRecomendado>('TODOS');

  // Subgrupos cascata
  useEffect(() => {
    if (!grupoSelected) {
      setSubgrupos([]);
      setSubgrupoSelected(null);
      return;
    }
    api<GrupoItem[]>(`/intelligence/subgrupos?grupo=${grupoSelected}`)
      .then(setSubgrupos)
      .catch(() => setSubgrupos([]));
  }, [grupoSelected]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (grupoSelected) params.set('grupo', String(grupoSelected));
      if (subgrupoSelected) params.set('subgrupo', String(subgrupoSelected));
      if (search.trim()) params.set('search', search.trim());
      params.set('mode', modeFilter);
      params.set('minTotal', String(minTotal));
      if (diasMax !== '' && diasMax > 0) params.set('diasMax', String(diasMax));
      if (diasMin !== '' && diasMin > 0) params.set('diasMin', String(diasMin));
      params.set('limit', '3000');

      const r = await api<RefDistribution>(`/intelligence/stock-distribution-by-ref?${params}`);
      setData(r);
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar visão raiz');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [grupoSelected, subgrupoSelected, search, modeFilter, minTotal, diasMax, diasMin]);

  // Classifica refs com modo recomendado
  const totalLojasAtivas = stores.filter((s) => s.active && !['SITE', 'PF'].includes(s.code)).length;
  const refsComModo = useMemo(() => {
    if (!data) return [];
    return data.refs.map((r) => ({ ...r, modo: detectarModo(r, totalLojasAtivas) }));
  }, [data, totalLojasAtivas]);

  // Filtro local por modo
  const refsFiltradas = useMemo(() => {
    if (filterMode === 'TODOS') return refsComModo;
    return refsComModo.filter((r) => r.modo === filterMode);
  }, [refsComModo, filterMode]);

  // KPIs por modo
  const kpis = useMemo(() => {
    const out = { equilibrar: 0, consolidar: 0, outlet: 0, ok: 0, total: 0, pecas: 0 };
    for (const r of refsComModo) {
      if (r.modo === 'EQUILIBRAR') out.equilibrar++;
      else if (r.modo === 'CONSOLIDAR') out.consolidar++;
      else if (r.modo === 'OUTLET') out.outlet++;
      else out.ok++;
      out.pecas += r.total;
    }
    out.total = refsComModo.length;
    return out;
  }, [refsComModo]);

  const idadeStr = (dataAlt: string | null) => {
    if (!dataAlt) return '—';
    const dias = Math.floor((Date.now() - new Date(dataAlt).getTime()) / (1000 * 60 * 60 * 24));
    if (dias < 1) return 'hoje';
    if (dias < 30) return `${dias}d`;
    if (dias < 365) return `${Math.floor(dias / 30)}m`;
    return `${(dias / 365).toFixed(1)}a`;
  };

  return (
    <div className="space-y-3">
      {/* Filtros */}
      <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
          <select
            value={grupoSelected || ''}
            onChange={(e) => setGrupoSelected(e.target.value ? Number(e.target.value) : null)}
            className="md:col-span-2 px-2 py-1.5 text-sm border border-slate-300 rounded focus:border-fuchsia-500 focus:outline-none"
          >
            <option value="">Todas categorias</option>
            {grupos.map((g) => (
              <option key={g.codigo} value={g.codigo}>{g.nome}</option>
            ))}
          </select>
          <select
            value={subgrupoSelected || ''}
            onChange={(e) => setSubgrupoSelected(e.target.value ? Number(e.target.value) : null)}
            disabled={!grupoSelected || subgrupos.length === 0}
            className="md:col-span-2 px-2 py-1.5 text-sm border border-slate-300 rounded focus:border-fuchsia-500 focus:outline-none disabled:bg-slate-100 disabled:text-slate-400"
          >
            <option value="">Todos subgrupos</option>
            {subgrupos.map((s) => (
              <option key={s.codigo} value={s.codigo}>{s.nome}</option>
            ))}
          </select>
          <div className="md:col-span-3 relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Buscar (REF, descrição, cor…)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchData()}
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-slate-300 rounded focus:border-fuchsia-500 focus:outline-none"
            />
          </div>
          <div className="md:col-span-2 flex items-center gap-1">
            <input
              type="number"
              min={1}
              placeholder="Novas: ≤dias"
              value={diasMax}
              onChange={(e) => setDiasMax(e.target.value ? Number(e.target.value) : '')}
              title="Filtrar peças cadastradas nos últimos X dias (DATAALT)"
              className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:border-fuchsia-500 focus:outline-none"
            />
            <input
              type="number"
              min={1}
              placeholder="Velhas: ≥dias"
              value={diasMin}
              onChange={(e) => setDiasMin(e.target.value ? Number(e.target.value) : '')}
              title="Filtrar peças cadastradas há mais de X dias"
              className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:border-fuchsia-500 focus:outline-none"
            />
          </div>
          <button
            onClick={fetchData}
            disabled={loading}
            className="md:col-span-2 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-fuchsia-600 hover:bg-fuchsia-700 disabled:opacity-50 text-white text-sm font-bold rounded"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Buscar
          </button>
          <button
            onClick={() => {
              setGrupoSelected(null);
              setSubgrupoSelected(null);
              setSearch('');
              setDiasMax('');
              setDiasMin('');
              setFilterMode('TODOS');
            }}
            className="md:col-span-1 px-2 py-1.5 text-sm text-slate-600 hover:text-slate-900 border border-slate-200 rounded hover:bg-slate-50"
          >
            Limpar
          </button>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500 pt-1">
          <span>Modo:</span>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={modeFilter === 'imbalanced'}
              onChange={() => setModeFilter('imbalanced')}
            />
            Só desequilibradas
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={modeFilter === 'all'}
              onChange={() => setModeFilter('all')}
            />
            Todas
          </label>
          <span className="ml-3">Min. peças total:</span>
          <input
            type="number"
            min={0}
            value={minTotal}
            onChange={(e) => setMinTotal(Math.max(0, Number(e.target.value) || 0))}
            className="w-14 px-1.5 py-0.5 border border-slate-300 rounded"
          />
        </div>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-lg p-3 text-sm">
          ❌ {error}
        </div>
      )}

      {/* KPIs por modo */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <button
          onClick={() => setFilterMode('TODOS')}
          className={`text-left rounded-lg p-3 border transition ${
            filterMode === 'TODOS'
              ? 'bg-slate-200 border-slate-400 shadow-inner'
              : 'bg-white border-slate-200 hover:bg-slate-50'
          }`}
        >
          <div className="text-xs font-bold text-slate-600 uppercase">Total REFs</div>
          <div className="text-2xl font-bold text-slate-800">{kpis.total}</div>
          <div className="text-[10px] text-slate-500">{kpis.pecas} peças</div>
        </button>
        <button
          onClick={() => setFilterMode('EQUILIBRAR')}
          className={`text-left rounded-lg p-3 border transition ${
            filterMode === 'EQUILIBRAR'
              ? 'bg-violet-200 border-violet-400 shadow-inner'
              : 'bg-violet-50 border-violet-200 hover:bg-violet-100'
          }`}
          title="Distribuir entre as lojas (tem estoque suficiente)"
        >
          <div className="text-xs font-bold text-violet-700 uppercase">⚖️ Equilibrar</div>
          <div className="text-2xl font-bold text-violet-800">{kpis.equilibrar}</div>
        </button>
        <button
          onClick={() => setFilterMode('CONSOLIDAR')}
          className={`text-left rounded-lg p-3 border transition ${
            filterMode === 'CONSOLIDAR'
              ? 'bg-orange-200 border-orange-400 shadow-inner'
              : 'bg-orange-50 border-orange-200 hover:bg-orange-100'
          }`}
          title="Juntar fragmentos em 1 loja só (montar grade completa)"
        >
          <div className="text-xs font-bold text-orange-700 uppercase">🧲 Consolidar</div>
          <div className="text-2xl font-bold text-orange-800">{kpis.consolidar}</div>
        </button>
        <button
          onClick={() => setFilterMode('OUTLET')}
          className={`text-left rounded-lg p-3 border transition ${
            filterMode === 'OUTLET'
              ? 'bg-amber-200 border-amber-400 shadow-inner'
              : 'bg-amber-50 border-amber-200 hover:bg-amber-100'
          }`}
          title="Peça antiga, mandar pra loja outlet"
        >
          <div className="text-xs font-bold text-amber-700 uppercase">🏷️ Outlet</div>
          <div className="text-2xl font-bold text-amber-800">{kpis.outlet}</div>
        </button>
        <button
          onClick={() => setFilterMode('OK')}
          className={`text-left rounded-lg p-3 border transition ${
            filterMode === 'OK'
              ? 'bg-emerald-200 border-emerald-400 shadow-inner'
              : 'bg-emerald-50 border-emerald-200 hover:bg-emerald-100'
          }`}
          title="Já está distribuído, sem ação necessária"
        >
          <div className="text-xs font-bold text-emerald-700 uppercase">✅ OK</div>
          <div className="text-2xl font-bold text-emerald-800">{kpis.ok}</div>
        </button>
      </div>

      {/* Tabela RAIZ */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {!data && !loading && (
          <div className="p-12 text-center text-slate-500">
            <Package className="w-12 h-12 mx-auto text-slate-300 mb-2" />
            <div className="text-sm font-bold mb-1">Use os filtros e clique Buscar</div>
            <div className="text-xs">Visão por REF+COR (1 linha por referência). Clique numa linha pra ver os tamanhos.</div>
          </div>
        )}
        {loading && (
          <div className="p-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin text-fuchsia-600 mx-auto" />
            <div className="text-sm text-slate-500 mt-2">Carregando…</div>
          </div>
        )}
        {data && refsFiltradas.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-3 py-2 text-left text-[11px] uppercase font-bold text-slate-600 tracking-wider">Descrição / REF · COR</th>
                <th className="px-3 py-2 text-left text-[11px] uppercase font-bold text-slate-600 tracking-wider">Grupo / Subgrupo</th>
                <th className="px-3 py-2 text-center text-[11px] uppercase font-bold text-slate-600 tracking-wider" title="Tempo desde DATAALT (cadastro/alteração)">Idade</th>
                <th className="px-3 py-2 text-center text-[11px] uppercase font-bold text-slate-600 tracking-wider">Tamanhos</th>
                <th className="px-3 py-2 text-right text-[11px] uppercase font-bold text-slate-600 tracking-wider">Total</th>
                <th className="px-3 py-2 text-center text-[11px] uppercase font-bold text-slate-600 tracking-wider">Lojas c/ estoque</th>
                <th className="px-3 py-2 text-right text-[11px] uppercase font-bold text-slate-600 tracking-wider">Preço</th>
                <th className="px-3 py-2 text-center text-[11px] uppercase font-bold text-slate-600 tracking-wider">Modo sugerido</th>
                <th className="px-3 py-2 text-center text-[11px] uppercase font-bold text-slate-600 tracking-wider">Ação</th>
              </tr>
            </thead>
            <tbody>
              {refsFiltradas.map((r, idx) => {
                const modoConfig = {
                  EQUILIBRAR: { label: '⚖️ Equilibrar', cls: 'bg-violet-100 text-violet-800', acaoCls: 'bg-violet-600 hover:bg-violet-700' },
                  CONSOLIDAR: { label: '🧲 Consolidar', cls: 'bg-orange-100 text-orange-800', acaoCls: 'bg-orange-600 hover:bg-orange-700' },
                  OUTLET:     { label: '🏷️ Outlet',     cls: 'bg-amber-100 text-amber-800',  acaoCls: 'bg-amber-600 hover:bg-amber-700' },
                  OK:         { label: '✅ OK',          cls: 'bg-emerald-100 text-emerald-800', acaoCls: 'bg-slate-300 cursor-not-allowed' },
                };
                const mc = modoConfig[r.modo];
                return (
                  <tr key={`${r.ref}-${r.cor}-${idx}`} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-900">{r.descricao}</div>
                      <div className="text-[11px] font-mono text-slate-500">
                        REF <span className="font-bold">{r.ref}</span>
                        {r.cor && <span className="ml-1">· {r.cor}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-xs text-slate-700 font-semibold">{r.grupoNome || '—'}</div>
                      <div className="text-[11px] text-slate-500">{r.subgrupoNome || '—'}</div>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className="text-xs font-mono text-slate-600" title={r.dataAlt || ''}>
                        {idadeStr(r.dataAlt)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      <div className="flex flex-wrap gap-1 justify-center">
                        {r.tamanhos.slice(0, 8).map((t) => (
                          <span key={t} className="px-1.5 py-0.5 bg-slate-100 text-slate-700 rounded text-[10px] font-bold">{t}</span>
                        ))}
                        {r.tamanhos.length > 8 && (
                          <span className="text-[10px] text-slate-500">+{r.tamanhos.length - 8}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums">{r.total}</td>
                    <td className="px-3 py-2 text-center">
                      <span className="text-xs font-mono text-slate-700">
                        {r.lojasComEstoque}<span className="text-slate-400">/{totalLojasAtivas}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-xs font-mono text-slate-700">{brl(r.preco)}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${mc.cls}`}>{mc.label}</span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <div className="flex items-center gap-1 justify-center">
                        <button
                          onClick={() => setDrawerRef(r)}
                          className="px-2 py-1 text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded"
                          title="Ver tamanhos + matriz por loja"
                        >
                          Detalhes
                        </button>
                        {(r.modo === 'CONSOLIDAR' || r.modo === 'OUTLET') && (
                          <button
                            onClick={() => setConsolidateRef(r)}
                            className={`px-2 py-1 text-xs font-bold text-white rounded ${mc.acaoCls}`}
                            title={r.modo === 'OUTLET' ? 'Consolidar pra loja OUTLET' : 'Consolidar grade numa loja'}
                          >
                            {r.modo === 'OUTLET' ? 'Outlet' : 'Consolidar'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {data && refsFiltradas.length === 0 && (
          <div className="p-12 text-center text-slate-500">
            <CheckCircle2 className="w-12 h-12 mx-auto text-emerald-300 mb-2" />
            <div className="text-sm">Nenhuma REF encontrada com esse filtro.</div>
          </div>
        )}
        {data && data.truncated && (
          <div className="bg-amber-50 border-t border-amber-200 px-3 py-2 text-xs text-amber-800">
            ⚠️ Resultado truncado (limite 3000 REFs). Refina os filtros pra ver mais.
          </div>
        )}
      </div>

      {/* Drawer detalhes (puxa a matriz de tamanhos da REF clicada) */}
      {drawerRef && (
        <RefDetailsDrawer
          refRow={drawerRef}
          stores={stores}
          onClose={() => setDrawerRef(null)}
        />
      )}

      {/* Drawer consolidação (Sprint 3) */}
      {consolidateRef && (
        <ConsolidateDrawer
          refRow={consolidateRef}
          stores={stores}
          isOutletMode={detectarModo(consolidateRef, totalLojasAtivas) === 'OUTLET'}
          onClose={() => setConsolidateRef(null)}
          onSuccess={() => {
            setConsolidateRef(null);
            fetchData();
          }}
        />
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   RefDetailsDrawer — drill-down: mostra matriz de tamanhos x lojas da REF
   ════════════════════════════════════════════════════════════════════════ */
function RefDetailsDrawer({
  refRow,
  stores,
  onClose,
}: {
  refRow: RefRow;
  stores: Store[];
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<Distribution | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set('search', refRow.ref);
    params.set('mode', 'all');
    params.set('minTotal', '0');
    params.set('limit', '500');
    api<Distribution>(`/intelligence/stock-distribution?${params}`)
      .then((r) => {
        // filtra só os da cor solicitada
        const filtered = {
          ...r,
          rows: r.rows.filter((row) =>
            (row.cor || '').trim().toUpperCase() === (refRow.cor || '').trim().toUpperCase(),
          ),
        };
        setDetail(filtered);
      })
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [refRow]);

  const lojasAtivas = stores
    .filter((s) => s.active && !['SITE', 'PF'].includes(s.code))
    .sort((a, b) => a.code.localeCompare(b.code));

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-30 backdrop-blur-sm" onClick={onClose} />
      <aside className="fixed right-0 top-0 bottom-0 w-full md:w-[900px] bg-white shadow-2xl z-40 overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-slate-200 px-5 py-3 flex items-center justify-between z-10">
          <div>
            <div className="font-bold text-lg text-slate-800">{refRow.descricao}</div>
            <div className="text-xs font-mono text-slate-500">
              REF <span className="font-bold">{refRow.ref}</span>
              {refRow.cor && <span className="ml-1">· {refRow.cor}</span>}
              <span className="ml-3 text-fuchsia-600 font-bold">{brl(refRow.preco)}</span>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>
        <div className="p-5">
          {loading && (
            <div className="text-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-fuchsia-600 mx-auto" />
            </div>
          )}
          {detail && detail.rows.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-2 py-1.5 text-left text-[10px] uppercase font-bold text-slate-600">Tam</th>
                  {lojasAtivas.map((s) => (
                    <th key={s.code} className="px-1.5 py-1.5 text-center text-[10px] uppercase font-bold text-slate-600">{s.code}</th>
                  ))}
                  <th className="px-2 py-1.5 text-right text-[10px] uppercase font-bold text-slate-600">Tot</th>
                </tr>
              </thead>
              <tbody>
                {detail.rows.map((row) => (
                  <tr key={row.codigo} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-2 py-1.5 font-bold text-slate-800">{row.tamanho}</td>
                    {lojasAtivas.map((s) => {
                      const qty = row.estoquePorLoja[s.code] || 0;
                      return (
                        <td key={s.code} className="px-1 py-1.5 text-center">
                          <Bolinha qty={qty} />
                        </td>
                      );
                    })}
                    <td className="px-2 py-1.5 text-right font-bold tabular-nums">{row.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {detail && detail.rows.length === 0 && !loading && (
            <div className="text-center py-12 text-slate-500 text-sm">
              Sem variações encontradas.
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   ConsolidateDrawer — Sprint 3
   Calcula plano de consolidação: TODAS as peças dessa REF+COR vão pra
   1 loja consolidadora. Escolha:
     1. Modo OUTLET → loja com isOutlet=true e maior consolidationScore
     2. Modo CONSOLIDAR → loja com maior consolidationScore (+ histórico de
        venda como tiebreaker se disponível)
   Gera N moves (X loja → loja consolidadora) por tamanho.
   ════════════════════════════════════════════════════════════════════════ */
function ConsolidateDrawer({
  refRow,
  stores,
  isOutletMode,
  onClose,
  onSuccess,
}: {
  refRow: RefRow;
  stores: Store[];
  isOutletMode: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [detail, setDetail] = useState<Distribution | null>(null);
  const [loading, setLoading] = useState(true);
  const [configLojas, setConfigLojas] = useState<RealignConfigItem[]>([]);
  const [selectedDestino, setSelectedDestino] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [salesByStore, setSalesByStore] = useState<Map<string, number>>(new Map());

  // Carrega: detalhes da REF + config lojas + vendas (Sprint 4)
  useEffect(() => {
    const params = new URLSearchParams();
    params.set('search', refRow.ref);
    params.set('mode', 'all');
    params.set('minTotal', '0');
    params.set('limit', '500');

    Promise.all([
      api<Distribution>(`/intelligence/stock-distribution?${params}`),
      api<RealignConfigItem[]>('/stores/realign-config/list'),
      api<{ vendas: Array<{ loja: string; qty: number }> }>(`/intelligence/ref-sales?ref=${encodeURIComponent(refRow.ref)}`).catch(() => ({ vendas: [] })),
    ])
      .then(([dist, config, sales]) => {
        const filtered = {
          ...dist,
          rows: dist.rows.filter(
            (r) => (r.cor || '').trim().toUpperCase() === (refRow.cor || '').trim().toUpperCase(),
          ),
        };
        setDetail(filtered);
        setConfigLojas(config);
        const salesMap = new Map<string, number>();
        for (const v of sales.vendas || []) salesMap.set(v.loja, v.qty);
        setSalesByStore(salesMap);

        // Escolhe destino padrão
        const candidatas = config.filter((c) => c.canReceiveRealign);
        let destinoEscolhido: string | null = null;
        if (isOutletMode) {
          const outlets = candidatas.filter((c) => c.isOutlet);
          if (outlets.length > 0) {
            outlets.sort((a, b) => (b.consolidationScore ?? 50) - (a.consolidationScore ?? 50));
            destinoEscolhido = outlets[0].code;
          }
        }
        if (!destinoEscolhido) {
          // Sem outlet (ou modo não-outlet): score + vendas como tiebreaker
          const ranked = candidatas
            .map((c) => ({
              code: c.code,
              score: (c.consolidationScore ?? 50) + (salesMap.get(c.code) || 0) * 0.5,
            }))
            .sort((a, b) => b.score - a.score);
          if (ranked.length > 0) destinoEscolhido = ranked[0].code;
        }
        setSelectedDestino(destinoEscolhido);
      })
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [refRow, isOutletMode]);

  // Lojas elegíveis pra ceder (canSendRealign)
  const sendableCodes = useMemo(
    () => new Set(configLojas.filter((c) => c.canSendRealign).map((c) => c.code)),
    [configLojas],
  );

  // Calcula moves: tudo de TODAS as lojas (sendable) → destino selecionado, por tamanho
  const moves = useMemo(() => {
    if (!detail || !selectedDestino) return [] as Array<{
      sku: string; ref: string; cor: string; tamanho: string; desc: string;
      from: string; to: string; qty: number;
    }>;
    const out: Array<any> = [];
    for (const row of detail.rows) {
      for (const [loja, qty] of Object.entries(row.estoquePorLoja)) {
        if (qty <= 0) continue;
        if (loja === selectedDestino) continue;
        if (!sendableCodes.has(loja)) continue;
        out.push({
          sku: row.codigo,
          ref: row.ref,
          cor: row.cor || '',
          tamanho: row.tamanho || '',
          desc: row.descricao,
          from: loja,
          to: selectedDestino,
          qty,
        });
      }
    }
    return out;
  }, [detail, selectedDestino, sendableCodes]);

  const totalQty = moves.reduce((s, m) => s + m.qty, 0);
  const lojasOrigem = new Set(moves.map((m) => m.from)).size;

  const apply = async () => {
    if (moves.length === 0 || !selectedDestino) return;
    if (
      !confirm(
        `Vai criar ${moves.length} transferências (${totalQty} peças) DE ${lojasOrigem} lojas PARA ${selectedDestino}.\n\n` +
          `Toda essa REF/COR vai ser consolidada em ${selectedDestino}.\n\nConfirma?`,
      )
    ) return;

    setApplying(true);
    setResult(null);
    try {
      // Mesmo endpoint que o realinhamento normal usa: /realignment/confirm
      // Diferença é só o note (rastreabilidade) — operacionalmente as lojas
      // veem cards idênticos na tela /minha-loja/realinhamento.
      const plan = moves.map((m) => ({
        sku: m.sku,
        ref: m.ref,
        cor: m.cor || null,
        tamanho: m.tamanho,
        desc: m.desc,
        fromCode: m.from,
        toCode: m.to,
        qty: m.qty,
      }));
      const modeLabel = isOutletMode ? 'OUTLET' : 'CONSOLIDAÇÃO';
      const res = await api<{ created: number; errors?: any[] }>(
        '/realignment/confirm',
        {
          method: 'POST',
          body: JSON.stringify({
            plan,
            note: `${modeLabel} · REF ${refRow.ref} ${refRow.cor || ''} · destino ${selectedDestino}`,
          }),
        },
      );
      setResult({ ok: true, msg: `✓ ${res.created || moves.length} ordens criadas. Lojas origem já notificadas.` });
      setTimeout(onSuccess, 2000);
    } catch (e: any) {
      setResult({ ok: false, msg: e?.message || 'Erro ao aplicar' });
    } finally {
      setApplying(false);
    }
  };

  const lojasReceptoras = configLojas.filter((c) => c.canReceiveRealign);

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-30 backdrop-blur-sm" onClick={onClose} />
      <aside className="fixed right-0 top-0 bottom-0 w-full md:w-[900px] bg-white shadow-2xl z-40 overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-slate-200 px-5 py-3 z-10">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                  isOutletMode ? 'bg-amber-100 text-amber-800' : 'bg-orange-100 text-orange-800'
                }`}>
                  {isOutletMode ? '🏷️ MODO OUTLET' : '🧲 CONSOLIDAR GRADE'}
                </span>
              </div>
              <div className="font-bold text-lg text-slate-800 mt-1">{refRow.descricao}</div>
              <div className="text-xs font-mono text-slate-500">
                REF <span className="font-bold">{refRow.ref}</span>
                {refRow.cor && <span className="ml-1">· {refRow.cor}</span>}
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded">
              <X className="w-5 h-5 text-slate-500" />
            </button>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {loading && (
            <div className="text-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-orange-600 mx-auto" />
              <div className="text-sm text-slate-500 mt-2">Calculando plano…</div>
            </div>
          )}

          {!loading && (
            <>
              {/* Seleção de destino */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <div className="text-xs font-bold text-slate-600 uppercase mb-2">
                  Loja de destino (consolidadora)
                </div>
                <select
                  value={selectedDestino || ''}
                  onChange={(e) => setSelectedDestino(e.target.value || null)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded focus:border-orange-500 focus:outline-none"
                >
                  <option value="">Selecione…</option>
                  {lojasReceptoras
                    .map((c) => {
                      const score = c.consolidationScore ?? 50;
                      const vendas = salesByStore.get(c.code) || 0;
                      const total = score + vendas * 0.5;
                      return { ...c, _score: score, _vendas: vendas, _total: total };
                    })
                    .sort((a, b) => b._total - a._total)
                    .map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.isOutlet ? '🏷️ ' : ''}
                        {c.code} {c.name}
                        {' · score '}{c._score}
                        {c._vendas > 0 ? ` · vendeu ${c._vendas}` : ''}
                      </option>
                    ))}
                </select>
                <div className="text-[11px] text-slate-500 mt-1">
                  Ranking: consolidationScore + 0.5 × vendas históricas.
                  {isOutletMode && ' Modo OUTLET prioriza lojas com flag isOutlet=true.'}
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-3 gap-2 text-sm">
                <div className="bg-orange-50 border border-orange-200 rounded p-2">
                  <div className="text-[10px] font-bold text-orange-700 uppercase">Movimentos</div>
                  <div className="text-xl font-bold text-orange-800">{moves.length}</div>
                </div>
                <div className="bg-orange-50 border border-orange-200 rounded p-2">
                  <div className="text-[10px] font-bold text-orange-700 uppercase">Peças</div>
                  <div className="text-xl font-bold text-orange-800">{totalQty}</div>
                </div>
                <div className="bg-orange-50 border border-orange-200 rounded p-2">
                  <div className="text-[10px] font-bold text-orange-700 uppercase">Origens</div>
                  <div className="text-xl font-bold text-orange-800">{lojasOrigem}</div>
                </div>
              </div>

              {/* Preview moves */}
              {moves.length > 0 && (
                <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                  <div className="bg-slate-50 px-3 py-1.5 text-[10px] font-bold uppercase text-slate-600 border-b border-slate-200">
                    Pré-visualização ({moves.length} movimentos)
                  </div>
                  <div className="max-h-96 overflow-y-auto">
                    <table className="w-full text-xs">
                      <tbody>
                        {moves.slice(0, 50).map((m, i) => (
                          <tr key={i} className="border-b border-slate-100">
                            <td className="px-2 py-1.5 font-mono text-slate-500">{m.from}</td>
                            <td className="px-2 py-1.5 text-slate-400">→</td>
                            <td className="px-2 py-1.5 font-mono text-orange-700 font-bold">{m.to}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums font-bold">{m.qty}</td>
                            <td className="px-2 py-1.5 text-slate-600">Tam {m.tamanho}</td>
                          </tr>
                        ))}
                        {moves.length > 50 && (
                          <tr>
                            <td colSpan={5} className="px-2 py-1.5 text-center text-slate-500 italic">
                              + {moves.length - 50} movimentos…
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {moves.length === 0 && selectedDestino && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-800">
                  ✓ Tudo já está em {selectedDestino}. Nada pra consolidar.
                </div>
              )}

              {result && (
                <div className={`rounded-lg p-3 text-sm ${
                  result.ok ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-rose-50 border border-rose-200 text-rose-800'
                }`}>
                  {result.msg}
                </div>
              )}
            </>
          )}
        </div>

        <div className="sticky bottom-0 bg-white border-t border-slate-200 px-5 py-3 flex items-center justify-between">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded">
            Cancelar
          </button>
          <button
            onClick={apply}
            disabled={applying || moves.length === 0 || !selectedDestino}
            className="flex items-center gap-2 px-5 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-slate-300 text-white text-sm font-bold rounded"
          >
            {applying ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Criando ordens…</>
            ) : (
              <><Shuffle className="w-4 h-4" /> Consolidar {moves.length} movimento{moves.length === 1 ? '' : 's'}</>
            )}
          </button>
        </div>
      </aside>
    </>
  );
}
