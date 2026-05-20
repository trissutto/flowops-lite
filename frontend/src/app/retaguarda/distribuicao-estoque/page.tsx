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
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar distribuição');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [grupoSelected, subgrupoSelected, searchDebounce, tamanhos, mode, minTotal]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-md text-sm font-bold disabled:opacity-50"
          >
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
                placeholder="Buscar REF, descrição ou CODIGO..."
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
          ) : !data || data.rows.length === 0 ? (
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
              onRealinhar={realinharGrupo}
            />
          )}
        </div>

        {/* Legenda */}
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

function VariationMapView({
  rows,
  lojas,
  storeNameByCode,
  onRealinhar,
}: {
  rows: Row[];
  lojas: string[];
  storeNameByCode: Map<string, string>;
  onRealinhar: (group: GroupDrawer) => void;
}) {
  const groups = useMemo<GroupDrawer[]>(() => {
    const map = new Map<string, GroupDrawer>();
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
    }
    // Ordena tamanhos numericamente dentro de cada grupo
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
    // Ordena grupos: primeiro os com mais criticidade ALTA, depois por total
    return Array.from(map.values()).sort((a, b) => {
      if (b.criticidadeAlta !== a.criticidadeAlta)
        return b.criticidadeAlta - a.criticidadeAlta;
      return b.totalRede - a.totalRede;
    });
  }, [rows]);

  return (
    <div className="overflow-auto max-h-[calc(100vh-280px)] p-3 space-y-3 bg-slate-50">
      {groups.map((g) => (
        <VariationCard
          key={g.key}
          group={g}
          lojas={lojas}
          storeNameByCode={storeNameByCode}
          onRealinhar={onRealinhar}
        />
      ))}
    </div>
  );
}

function VariationCard({
  group,
  lojas,
  storeNameByCode,
  onRealinhar,
}: {
  group: GroupDrawer;
  lojas: string[];
  storeNameByCode: Map<string, string>;
  onRealinhar: (group: GroupDrawer) => void;
}) {
  // Constrói matriz [loja][tamanho] → quantidade
  const matrix = useMemo(() => {
    const m: Record<string, Record<string, { qty: number; row: Row }>> = {};
    for (const lj of lojas) m[lj] = {};
    for (const it of group.items) {
      const tam = (it.tamanho || '').trim();
      for (const [lj, qty] of Object.entries(it.estoquePorLoja || {})) {
        if (!m[lj]) m[lj] = {};
        m[lj][tam] = { qty, row: it };
      }
    }
    return m;
  }, [group, lojas]);

  // Lojas presentes (com alguma quantidade ou listadas no header)
  const lojasComEstoque = lojas.filter((lj) => {
    return group.tamanhos.some((tam) => (matrix[lj]?.[tam]?.qty ?? 0) > 0);
  });
  const lojasParaMostrar = lojasComEstoque.length > 0 ? lojasComEstoque : lojas.slice(0, 8);

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Header do card */}
      <div className="px-4 py-3 bg-gradient-to-r from-slate-50 to-white border-b border-slate-100">
        <div className="flex items-baseline gap-3 mb-1">
          <span className="font-mono font-black text-lg text-slate-800">
            REF {group.ref}
          </span>
          <span className="font-bold text-slate-600 uppercase tracking-wide text-sm">
            — {group.cor}
          </span>
        </div>
        {group.descricao && (
          <div className="text-xs text-slate-600 mb-2 leading-relaxed">
            {group.descricao}
          </div>
        )}
        <div className="flex items-center gap-2 text-xs flex-wrap">
          {group.criticidadeAlta > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 font-bold">
              {group.criticidadeAlta} desequilíbrio{group.criticidadeAlta > 1 ? 's' : ''}
            </span>
          )}
          <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-mono font-bold">
            {group.totalRede} pç na rede
          </span>
          {group.preco > 0 && (
            <span className="font-mono text-slate-500">
              {brl(group.preco)}
            </span>
          )}
          <div className="ml-auto">
            <button
              onClick={() => onRealinhar(group)}
              className="px-3 py-1 rounded-md bg-violet-600 hover:bg-violet-700 text-white text-xs font-bold flex items-center gap-1"
            >
              <Shuffle className="w-3 h-3" />
              Sugerir realinhamento
            </button>
          </div>
        </div>
      </div>

      {/* Matriz LOJA × TAMANHO */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-3 py-2 text-left font-bold text-slate-600 sticky left-0 bg-slate-50 z-10 min-w-[140px]">
                Loja
              </th>
              {group.tamanhos.map((tam) => (
                <th
                  key={tam}
                  className="px-2 py-2 text-center font-bold text-slate-600 min-w-[60px]"
                >
                  {tam}
                </th>
              ))}
              <th className="px-3 py-2 text-center font-bold text-slate-600 bg-slate-100">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {lojasParaMostrar.map((lj) => {
              const nome = storeNameByCode.get(lj) || lj;
              const linhaTotal = group.tamanhos.reduce(
                (s, t) => s + (matrix[lj]?.[t]?.qty ?? 0),
                0,
              );
              return (
                <tr key={lj} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 sticky left-0 bg-white font-medium text-slate-800">
                    <span className="font-mono text-xs text-slate-400 mr-2">{lj}</span>
                    {nome.replace(/^Lurd's\s*/i, '')}
                  </td>
                  {group.tamanhos.map((tam) => {
                    const cell = matrix[lj]?.[tam];
                    const qty = cell?.qty ?? 0;
                    return (
                      <td key={tam} className="px-2 py-2 text-center">
                        <Bolinha qty={qty} />
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-center font-mono font-black text-slate-700 bg-slate-50">
                    {linhaTotal}
                  </td>
                </tr>
              );
            })}
            {/* Linha de TOTAL POR TAMANHO */}
            <tr className="border-t-2 border-slate-200 bg-slate-50">
              <td className="px-3 py-2 sticky left-0 bg-slate-50 font-bold text-slate-700 text-[11px] uppercase tracking-wider">
                Total tamanho
              </td>
              {group.tamanhos.map((tam) => {
                const tot = lojasParaMostrar.reduce(
                  (s, lj) => s + (matrix[lj]?.[tam]?.qty ?? 0),
                  0,
                );
                return (
                  <td
                    key={tam}
                    className="px-2 py-2 text-center font-mono font-bold text-slate-700"
                  >
                    {tot}
                  </td>
                );
              })}
              <td className="px-3 py-2 text-center font-mono font-black text-violet-700 bg-violet-100">
                {group.totalRede}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

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
  // Lojas elegíveis: ativas, sem SITE/PF, ordenadas por priorityScore desc
  const eligibleStores = useMemo(() => {
    const ignored = new Set(['SITE', 'PF']);
    return stores
      .filter((s) => s.active && !ignored.has(s.code))
      .sort((a, b) => ((b as any).priorityScore ?? 50) - ((a as any).priorityScore ?? 50));
  }, [stores]);

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
      // Considera só lojas eligíveis
      const totalAvailable = eligibleStores.reduce(
        (s, st) => s + (currentByStore[st.code] || 0),
        0,
      );

      // Inicializa target = 0 pra todas
      for (const s of eligibleStores) target[tam][s.code] = 0;

      // Distribui obedecendo regras
      if (totalAvailable === 0) {
        // nada a fazer
      } else if (totalAvailable >= eligibleStores.length) {
        // 1 base pra cada, sobra distribuída por prioridade
        let remaining = totalAvailable;
        for (const s of eligibleStores) {
          target[tam][s.code] = 1;
          remaining--;
        }
        let i = 0;
        while (remaining > 0) {
          target[tam][eligibleStores[i % eligibleStores.length].code]++;
          remaining--;
          i++;
        }
      } else {
        // Não dá pra todas: top N lojas pegam 1
        let remaining = totalAvailable;
        for (const s of eligibleStores) {
          if (remaining <= 0) break;
          target[tam][s.code] = 1;
          remaining--;
        }
      }

      // Calcula movimentos: surplus → deficit
      const sources: Array<{ code: string; surplus: number }> = [];
      const sinks: Array<{ code: string; deficit: number }> = [];
      for (const s of eligibleStores) {
        const cur = currentByStore[s.code] || 0;
        const tgt = target[tam][s.code] || 0;
        const diff = cur - tgt;
        if (diff > 0) sources.push({ code: s.code, surplus: diff });
        else if (diff < 0) sinks.push({ code: s.code, deficit: -diff });
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
