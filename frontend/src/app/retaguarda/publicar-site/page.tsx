'use client';

/**
 * /retaguarda/publicar-site — FASE 1: filtro e fila de publicação no site.
 *
 * Funcionalidades:
 *   - Busca multi-filtro na tabela `produtos` do Gigasistemas (REF, descrição,
 *     grupo, subgrupo, fornecedor, dias de cadastro).
 *   - Resultados agrupados por REF → cada REF mostra suas cores, e cada cor
 *     mostra os tamanhos com estoque.
 *   - Usuário marca UMA OU MAIS cores de cada REF pra colocar na fila de
 *     publicação (cada cor vira UM produto no WooCommerce).
 *   - Fila lateral com os itens já marcados (status = queued).
 *   - Próximo passo (Fase 2): botão "Enriquecer" em cada item, que leva pra
 *     tela de legenda/categorias/imagens.
 *
 * Por que NÃO mostramos estoque por loja aqui:
 *   O objetivo desta tela é só seleção — o CEO sabe qual REF quer subir.
 *   Detalhes por loja são irrelevantes nesse ponto; ele decide com base em
 *   "essa peça entrou" ou "ela já está aparecendo na prateleira". Tempo é
 *   mais importante que granularidade.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Globe, Search, Plus, Trash2, Check, RefreshCw,
  Layers, Package, Loader2, AlertCircle, CheckCircle2,
  X, Filter, Edit3, Sparkles, ExternalLink, Send, Pencil,
} from 'lucide-react';
import { api } from '@/lib/api';
import EditProductModal from './EditProductModal';
import BulkEditModal from './BulkEditModal';

// ─── Tipos ──────────────────────────────────────────────────────────────

type GigaTamanho = {
  tamanho: string | null;
  codigo: string;
  estoque: number;
  ean: string | null;
};

type GigaCor = {
  cor: string;
  tamanhos: GigaTamanho[];
  estoqueTotal: number;
};

type GigaRef = {
  refCode: string;
  descricao: string;
  grupo: string | null;
  subgrupo: string | null;
  fornecedor: string | null;
  ncm: string | null;
  cfop: string | null;
  custo: number | null;
  preco: number | null;
  cores: GigaCor[];
  totalVariations: number;
  estoqueTotal: number;
};

type SearchResult = {
  refs: GigaRef[];
  truncated: boolean;
  schema: {
    hasGrupo: boolean;
    hasSubgrupo: boolean;
    hasFornecedor: boolean;
    hasDataCadastro: boolean;
  };
};

type Facets = {
  grupos: string[];
  subgrupos: string[];
  fornecedores: string[];
  hasGrupo: boolean;
  hasSubgrupo: boolean;
  hasFornecedor: boolean;
};

type QueueItem = {
  id: string;
  refCode: string;
  cor: string;
  status: string;
  gigaCodes: string[];
  fornecedor: string | null;
  grupo: string | null;
  subgrupo: string | null;
  custoMedio: string | null;
  precoSugerido: string | null;
  estoqueTotal: number | null;
  tamanhos: GigaTamanho[];
  wcProductId: number | null;
  publishedAt: string | null;
  createdAt: string;
};

type QueueResponse = {
  rows: QueueItem[];
  summary: Record<string, number>;
};

// ─── Helper: chave única por REF+COR ────────────────────────────────────
const keyRefCor = (ref: string, cor: string) => `${ref}__${cor.toUpperCase()}`;

// ─── Componente principal ──────────────────────────────────────────────

export default function PublicarSitePage() {
  // Filtros
  const [refs, setRefs] = useState('');
  const [term, setTerm] = useState('');
  const [grupo, setGrupo] = useState('');
  const [subgrupo, setSubgrupo] = useState('');
  const [fornecedor, setFornecedor] = useState('');
  const [diasCadastro, setDiasCadastro] = useState('');

  // Resultados / UI
  const [facets, setFacets] = useState<Facets | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [queueLoading, setQueueLoading] = useState(false);
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [selectedCors, setSelectedCors] = useState<Set<string>>(new Set());
  const [showQueue, setShowQueue] = useState(true);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  // Seleção múltipla na fila (pra publicar em massa / editar em bloco)
  const [selectedQueueIds, setSelectedQueueIds] = useState<Set<string>>(new Set());
  const [bulkEditing, setBulkEditing] = useState(false);
  const [bulkRunning, setBulkRunning] = useState<null | 'publish' | 'ai'>(null);
  const [autoAi, setAutoAi] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('lurds.publicar-site.autoAi') === '1';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('lurds.publicar-site.autoAi', autoAi ? '1' : '0');
  }, [autoAi]);

  // ─── Carga inicial: facets + fila ────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const f = await api<Facets>('/site-publish/facets');
        setFacets(f);
      } catch (e: any) {
        // Facets falha em silêncio — tela ainda funciona sem dropdown
        console.warn('facets falhou', e);
      }
      loadQueue();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadQueue = async () => {
    setQueueLoading(true);
    try {
      const q = await api<QueueResponse>('/site-publish/queue');
      setQueue(q.rows);
      setSummary(q.summary || {});
    } catch (e: any) {
      console.warn('queue load falhou', e);
    } finally {
      setQueueLoading(false);
    }
  };

  // ─── Busca ───────────────────────────────────────────────────────────
  const search = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const params = new URLSearchParams();
      if (refs.trim()) params.set('refs', refs.trim());
      if (term.trim()) params.set('term', term.trim());
      if (grupo) params.set('grupo', grupo);
      if (subgrupo) params.set('subgrupo', subgrupo);
      if (fornecedor) params.set('fornecedor', fornecedor);
      if (diasCadastro) params.set('diasCadastro', diasCadastro);
      const data = await api<SearchResult>(`/site-publish/giga-search?${params.toString()}`);
      setResult(data);
      if (!data.refs.length) {
        setError('Nenhuma REF encontrada com esses filtros.');
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
      setError(msg.includes('403') ? 'Acesso restrito à matriz.' : `Falha na busca: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  // ─── Chaves da fila (pra saber o que já foi marcado) ─────────────────
  const queuedKeys = useMemo(() => {
    const s = new Set<string>();
    for (const q of queue) s.add(keyRefCor(q.refCode, q.cor));
    return s;
  }, [queue]);

  // ─── Seleção múltipla (checkbox) ─────────────────────────────────────
  const toggleSelect = (ref: string, cor: string) => {
    const k = keyRefCor(ref, cor);
    setSelectedCors((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  };

  const selectAllCores = (ref: GigaRef) => {
    setSelectedCors((prev) => {
      const n = new Set(prev);
      for (const c of ref.cores) {
        const k = keyRefCor(ref.refCode, c.cor);
        if (!queuedKeys.has(k)) n.add(k);
      }
      return n;
    });
  };

  // Atalho: marca TODAS as cores pendentes da REF e já enfileira em batch.
  // Evita o fluxo "expandir > selecionar > clicar enfileirar" quando são
  // muitas cores (tipo 8+ num mesmo refCode).
  const queueAllCores = async (ref: GigaRef) => {
    const items = ref.cores
      .map((c) => ({ refCode: ref.refCode, cor: c.cor }))
      .filter((it) => !queuedKeys.has(keyRefCor(it.refCode, it.cor)));
    if (!items.length) {
      setToast(`${ref.refCode}: todas as cores já estão na fila.`);
      setTimeout(() => setToast(null), 2500);
      return;
    }
    setLoading(true);
    try {
      const res = await api<{ added: number; errors: any[]; ids?: string[] }>(
        '/site-publish/queue/batch',
        { method: 'POST', body: JSON.stringify({ items }) },
      );
      setToast(`✓ ${res.added} cores de ${ref.refCode} enfileiradas${autoAi ? ' — gerando IA...' : ''}`);
      if (autoAi && Array.isArray(res.ids) && res.ids.length) {
        api<{ generated: number; total: number; failed: any[] }>(
          '/site-publish/queue/ai-batch',
          { method: 'POST', body: JSON.stringify({ ids: res.ids }) },
        ).then((r) => {
          const failMsg = r.failed?.length ? ` · ${r.failed.length} erro(s) — ${r.failed[0]?.reason || ''}` : '';
          setToast(`✨ IA gerou ${r.generated}/${r.total}${failMsg}`);
          setTimeout(() => setToast(null), 6000);
          loadQueue();
        }).catch((err) => {
          setToast(`⚠ IA batch falhou: ${String(err?.message || err).slice(0, 200)}`);
          setTimeout(() => setToast(null), 6000);
        });
      }
      loadQueue();
    } catch (e: any) {
      setToast(`Erro: ${e?.message || e}`);
    } finally {
      setLoading(false);
      setTimeout(() => setToast(null), 5000);
    }
  };

  const clearSelection = () => setSelectedCors(new Set());

  // ─── Seleção múltipla na FILA ────────────────────────────────────────
  const toggleQueueSelect = (id: string) => {
    setSelectedQueueIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  // Só seleciona itens ainda não publicados — os publicados não fazem sentido
  // entrar em bulk publish/edit.
  const selectAllQueue = () => {
    const editable = queue.filter((q) => q.status !== 'published' && q.status !== 'publishing');
    setSelectedQueueIds(new Set(editable.map((q) => q.id)));
  };
  const clearQueueSelection = () => setSelectedQueueIds(new Set());

  // ─── Publicar em massa ───────────────────────────────────────────────
  const publishSelected = async () => {
    const ids = Array.from(selectedQueueIds);
    if (!ids.length) return;
    if (!confirm(`Publicar ${ids.length} ${ids.length > 1 ? 'itens' : 'item'} no WC como rascunho? Vai rodar sequencial (pode demorar alguns min).`)) return;
    setBulkRunning('publish');
    try {
      const res = await api<{ total: number; published: number; failed: any[] }>(
        '/site-publish/queue/publish-batch',
        { method: 'POST', body: JSON.stringify({ ids }) },
      );
      const failMsg = res.failed?.length
        ? ` · ${res.failed.length} erro(s): ${res.failed.slice(0, 2).map((f: any) => `${f.refCode || ''}/${f.cor || ''} (${f.reason})`).join('; ')}`
        : '';
      setToast(`✓ ${res.published}/${res.total} publicado${res.published !== 1 ? 's' : ''}${failMsg}`);
      clearQueueSelection();
      loadQueue();
    } catch (e: any) {
      setToast(`Erro bulk publish: ${e?.message || e}`);
    } finally {
      setBulkRunning(null);
      setTimeout(() => setToast(null), 8000);
    }
  };

  // ─── Gerar IA em massa ───────────────────────────────────────────────
  const aiSelected = async () => {
    const ids = Array.from(selectedQueueIds);
    if (!ids.length) return;
    setBulkRunning('ai');
    try {
      const res = await api<{ total: number; generated: number; failed: any[] }>(
        '/site-publish/queue/ai-batch',
        { method: 'POST', body: JSON.stringify({ ids }) },
      );
      const failMsg = res.failed?.length
        ? ` · ${res.failed.length} erro(s) — ${res.failed[0]?.reason || ''}`
        : '';
      setToast(`✨ ${res.generated}/${res.total} gerado${res.generated !== 1 ? 's' : ''} pela IA${failMsg}`);
      clearQueueSelection();
      loadQueue();
    } catch (e: any) {
      setToast(`Erro bulk IA: ${e?.message || e}`);
    } finally {
      setBulkRunning(null);
      setTimeout(() => setToast(null), 6000);
    }
  };

  // ─── Enfileirar individual (botão + por cor) ─────────────────────────
  const addOne = async (refCode: string, cor: string) => {
    const k = keyRefCor(refCode, cor);
    setAddingKey(k);
    try {
      const res = await api<{ id: string; status: string }>('/site-publish/queue', {
        method: 'POST',
        body: JSON.stringify({ refCode, cor }),
      });
      setToast(`✓ ${refCode} / ${cor} enfileirado${autoAi ? ' — gerando IA...' : ''}`);
      // Auto-gerar IA em background (não bloqueia UI) — Etapa 7
      if (autoAi && res?.id) {
        api(`/site-publish/queue/${res.id}/ai`, {
          method: 'POST',
          body: JSON.stringify({}),
        }).then(() => {
          setToast(`✨ ${refCode} / ${cor} — IA gerou conteúdo.`);
          setTimeout(() => setToast(null), 3000);
          loadQueue();
        }).catch((err) => {
          // Mostra o erro real — ajuda a diagnosticar ANTHROPIC_API_KEY faltando
          const msg = String(err?.message || err).slice(0, 200);
          setToast(`⚠ IA falhou em ${refCode}/${cor}: ${msg}`);
          setTimeout(() => setToast(null), 6000);
          console.warn('auto-ai falhou', err);
        });
      }
      loadQueue();
    } catch (e: any) {
      setToast(`Erro: ${e?.message || e}`);
    } finally {
      setAddingKey(null);
      setTimeout(() => setToast(null), 3000);
    }
  };

  // ─── Enfileirar em massa (batch) ─────────────────────────────────────
  const addBatch = async () => {
    if (!selectedCors.size) return;
    setLoading(true);
    try {
      const items = Array.from(selectedCors).map((k) => {
        const [refCode, cor] = k.split('__');
        return { refCode, cor };
      });
      const res = await api<{ added: number; errors: any[]; ids?: string[] }>('/site-publish/queue/batch', {
        method: 'POST',
        body: JSON.stringify({ items }),
      });
      setToast(`${res.added} itens enfileirados${res.errors.length ? `, ${res.errors.length} erros` : ''}.`);
      clearSelection();
      // Auto-gerar IA em background para todos os novos itens — usa o endpoint
      // batch pra ter resumo consolidado em vez de N chamadas soltas
      if (autoAi && Array.isArray(res.ids) && res.ids.length) {
        api<{ total: number; generated: number; failed: any[] }>(
          '/site-publish/queue/ai-batch',
          { method: 'POST', body: JSON.stringify({ ids: res.ids }) },
        ).then((r) => {
          const failMsg = r.failed?.length ? ` · ${r.failed.length} erro(s) — ${r.failed[0]?.reason || ''}` : '';
          setToast(`✨ IA gerou ${r.generated}/${r.total}${failMsg}`);
          setTimeout(() => setToast(null), 6000);
          loadQueue();
        }).catch((err) => {
          setToast(`⚠ IA batch falhou: ${String(err?.message || err).slice(0, 200)}`);
          setTimeout(() => setToast(null), 6000);
        });
      }
      loadQueue();
    } catch (e: any) {
      setToast(`Erro batch: ${e?.message || e}`);
    } finally {
      setLoading(false);
      setTimeout(() => setToast(null), 3500);
    }
  };

  // ─── Remover da fila ─────────────────────────────────────────────────
  const removeQueue = async (id: string) => {
    if (!confirm('Remover esse item da fila?')) return;
    try {
      await api(`/site-publish/queue/${id}`, { method: 'DELETE' });
      loadQueue();
    } catch (e: any) {
      setToast(`Erro: ${e?.message || e}`);
      setTimeout(() => setToast(null), 3000);
    }
  };

  // ─── Limpar filtros ──────────────────────────────────────────────────
  const clearFilters = () => {
    setRefs('');
    setTerm('');
    setGrupo('');
    setSubgrupo('');
    setFornecedor('');
    setDiasCadastro('');
    setResult(null);
    setError(null);
  };

  // ─── Render ──────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-pink-500 rounded-xl flex items-center justify-center">
              <Globe className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900">Publicar no Site</h1>
              <p className="text-xs text-gray-500">Wincred → WooCommerce · Fase 1: selecionar referências</p>
            </div>
          </div>
          <button
            onClick={() => setShowQueue(!showQueue)}
            className="flex items-center gap-2 px-3 py-1.5 bg-purple-50 text-purple-700 rounded-lg text-sm font-medium hover:bg-purple-100"
          >
            <Layers className="w-4 h-4" />
            Fila ({queue.length})
          </button>
        </div>
      </div>

      <div className={`max-w-7xl mx-auto px-4 sm:px-6 py-6 grid gap-6 ${showQueue ? 'lg:grid-cols-[1fr_380px]' : 'lg:grid-cols-1'}`}>
        {/* ─── Coluna principal: Busca + Resultados ─── */}
        <div className="space-y-6">
          {/* Filtros */}
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <div className="flex items-center gap-2 mb-4">
              <Filter className="w-5 h-5 text-gray-600" />
              <h2 className="font-semibold text-gray-900">Filtros de busca</h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* REFs (textarea — aceita várias) */}
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  REFs (separadas por vírgula ou linha)
                </label>
                <textarea
                  value={refs}
                  onChange={(e) => setRefs(e.target.value)}
                  placeholder="01010101, 01010102, VLM-222..."
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              {/* Termo livre */}
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Descrição (palavras — busca em DESCRICAOCOMPLETA)
                </label>
                <input
                  type="text"
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  placeholder="vestido longo marinho"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              {/* Grupo */}
              {facets?.hasGrupo && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Grupo</label>
                  <select
                    value={grupo}
                    onChange={(e) => setGrupo(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                  >
                    <option value="">Todos</option>
                    {facets.grupos.map((g) => (
                      <option key={g} value={g}>{g}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Subgrupo */}
              {facets?.hasSubgrupo && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Subgrupo</label>
                  <select
                    value={subgrupo}
                    onChange={(e) => setSubgrupo(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                  >
                    <option value="">Todos</option>
                    {facets.subgrupos.map((g) => (
                      <option key={g} value={g}>{g}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Fornecedor */}
              {facets?.hasFornecedor && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Fornecedor</label>
                  <select
                    value={fornecedor}
                    onChange={(e) => setFornecedor(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                  >
                    <option value="">Todos</option>
                    {facets.fornecedores.map((g) => (
                      <option key={g} value={g}>{g}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Dias de cadastro */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Cadastrados nos últimos...
                </label>
                <select
                  value={diasCadastro}
                  onChange={(e) => setDiasCadastro(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                >
                  <option value="">— qualquer data —</option>
                  <option value="1">1 dia</option>
                  <option value="7">7 dias</option>
                  <option value="15">15 dias</option>
                  <option value="30">30 dias</option>
                  <option value="60">60 dias</option>
                  <option value="90">90 dias</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 mt-4 pt-4 border-t border-gray-100">
              <button
                onClick={search}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white font-medium rounded-lg hover:bg-purple-700 disabled:opacity-60"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                Buscar
              </button>
              <button
                onClick={clearFilters}
                className="flex items-center gap-2 px-3 py-2 text-gray-600 hover:text-gray-900 text-sm"
              >
                <X className="w-4 h-4" />
                Limpar filtros
              </button>

              <label
                className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-lg text-xs font-medium text-amber-800 cursor-pointer select-none"
                title="Ao enfileirar, dispara a IA em background pra gerar título, descrição e tags"
              >
                <input
                  type="checkbox"
                  checked={autoAi}
                  onChange={(e) => setAutoAi(e.target.checked)}
                  className="w-4 h-4 accent-amber-600"
                />
                <Sparkles className="w-3.5 h-3.5" />
                Auto-gerar IA ao enfileirar
              </label>

              {selectedCors.size > 0 && (
                <div className="flex items-center gap-2 ml-auto">
                  <span className="text-sm text-gray-600">
                    {selectedCors.size} selecionado{selectedCors.size > 1 ? 's' : ''}
                  </span>
                  <button
                    onClick={addBatch}
                    disabled={loading}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-60"
                  >
                    <Plus className="w-4 h-4" />
                    Enfileirar
                  </button>
                  <button onClick={clearSelection} className="text-xs text-gray-500 hover:text-gray-700">
                    limpar
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Status */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {result?.truncated && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm text-yellow-800">
              Foram encontradas mais REFs do que o limite — refine o filtro pra ver tudo.
            </div>
          )}

          {/* Resultados */}
          {result && result.refs.length > 0 && (
            <div className="space-y-4">
              <div className="text-sm text-gray-600">
                {result.refs.length} REF{result.refs.length > 1 ? 's' : ''} encontrada{result.refs.length > 1 ? 's' : ''}
              </div>

              {result.refs.map((ref) => (
                <RefCard
                  key={ref.refCode}
                  ref_={ref}
                  queuedKeys={queuedKeys}
                  selectedCors={selectedCors}
                  toggleSelect={toggleSelect}
                  selectAllCores={selectAllCores}
                  queueAllCores={queueAllCores}
                  addOne={addOne}
                  addingKey={addingKey}
                />
              ))}
            </div>
          )}
        </div>

        {/* ─── Coluna fila ─── */}
        {showQueue && (
          <aside className="lg:sticky lg:top-24 self-start">
            <div className="bg-white rounded-2xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Layers className="w-5 h-5 text-purple-600" />
                  <h2 className="font-semibold text-gray-900">Fila de publicação</h2>
                </div>
                <button
                  onClick={loadQueue}
                  disabled={queueLoading}
                  className="text-gray-400 hover:text-gray-700"
                  title="Recarregar"
                >
                  <RefreshCw className={`w-4 h-4 ${queueLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {/* Resumo por status */}
              <div className="flex flex-wrap gap-2 mb-4">
                <StatusPill label="Aguardando" count={summary.queued || 0} color="gray" />
                <StatusPill label="Enriquecido" count={summary.enriched || 0} color="blue" />
                <StatusPill label="Publicado" count={summary.published || 0} color="green" />
                {(summary.failed || 0) > 0 && (
                  <StatusPill label="Erro" count={summary.failed || 0} color="red" />
                )}
              </div>

              {/* Barra de ações em massa — aparece quando tem itens editáveis */}
              {queue.some((q) => q.status !== 'published' && q.status !== 'publishing') && (
                <div className="mb-3 bg-gray-50 border border-gray-200 rounded-lg p-2 flex items-center gap-2 flex-wrap">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-gray-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={
                        selectedQueueIds.size > 0 &&
                        selectedQueueIds.size === queue.filter((q) => q.status !== 'published' && q.status !== 'publishing').length
                      }
                      onChange={(e) => (e.target.checked ? selectAllQueue() : clearQueueSelection())}
                      className="w-4 h-4 accent-purple-600"
                    />
                    Selecionar tudo
                  </label>
                  {selectedQueueIds.size > 0 && (
                    <>
                      <span className="text-xs text-gray-500">({selectedQueueIds.size})</span>
                      <div className="ml-auto flex items-center gap-1 flex-wrap">
                        <button
                          onClick={aiSelected}
                          disabled={bulkRunning !== null}
                          className="flex items-center gap-1 px-2 py-1 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded text-[11px] font-semibold hover:opacity-90 disabled:opacity-60"
                          title="Dispara IA em todos os selecionados (sequencial)"
                        >
                          {bulkRunning === 'ai' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                          IA
                        </button>
                        <button
                          onClick={() => setBulkEditing(true)}
                          disabled={bulkRunning !== null}
                          className="flex items-center gap-1 px-2 py-1 bg-blue-600 text-white rounded text-[11px] font-semibold hover:bg-blue-700 disabled:opacity-60"
                          title="Edita categorias/tags/descrição comum pra todos"
                        >
                          <Pencil className="w-3 h-3" />
                          Editar
                        </button>
                        <button
                          onClick={publishSelected}
                          disabled={bulkRunning !== null}
                          className="flex items-center gap-1 px-2 py-1 bg-green-600 text-white rounded text-[11px] font-semibold hover:bg-green-700 disabled:opacity-60"
                          title="Publica todos no WC como rascunho"
                        >
                          {bulkRunning === 'publish' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                          Publicar
                        </button>
                        <button
                          onClick={clearQueueSelection}
                          className="text-[10px] text-gray-500 hover:text-gray-700 px-1"
                        >
                          limpar
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {queueLoading && queue.length === 0 && (
                <div className="text-center py-8 text-sm text-gray-500">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                  Carregando...
                </div>
              )}

              {!queueLoading && queue.length === 0 && (
                <div className="text-center py-8 text-sm text-gray-500">
                  <Package className="w-10 h-10 mx-auto mb-2 text-gray-300" />
                  Nenhum item na fila ainda.<br />
                  Busque e marque as referências.
                </div>
              )}

              <div className="space-y-2 max-h-[70vh] overflow-y-auto">
                {queue.map((q) => (
                  <QueueRow
                    key={q.id}
                    item={q}
                    selected={selectedQueueIds.has(q.id)}
                    onToggleSelect={() => toggleQueueSelect(q.id)}
                    onRemove={removeQueue}
                    onEdit={() => setEditingItemId(q.id)}
                  />
                ))}
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}

      {/* Modal de edição */}
      {editingItemId && (
        <EditProductModal
          itemId={editingItemId}
          onClose={() => setEditingItemId(null)}
          onSaved={() => {
            loadQueue();
          }}
        />
      )}

      {/* Modal de edição em bloco */}
      {bulkEditing && selectedQueueIds.size > 0 && (
        <BulkEditModal
          ids={Array.from(selectedQueueIds)}
          onClose={() => setBulkEditing(false)}
          onSaved={() => {
            setBulkEditing(false);
            clearQueueSelection();
            loadQueue();
            setToast('Edição em bloco aplicada');
          }}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Subcomponentes
// ═══════════════════════════════════════════════════════════════════════

function RefCard({
  ref_,
  queuedKeys,
  selectedCors,
  toggleSelect,
  selectAllCores,
  queueAllCores,
  addOne,
  addingKey,
}: {
  ref_: GigaRef;
  queuedKeys: Set<string>;
  selectedCors: Set<string>;
  toggleSelect: (ref: string, cor: string) => void;
  selectAllCores: (ref: GigaRef) => void;
  queueAllCores: (ref: GigaRef) => void;
  addOne: (ref: string, cor: string) => void;
  addingKey: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const allColorsQueued = ref_.cores.every((c) => queuedKeys.has(keyRefCor(ref_.refCode, c.cor)));
  const pendingCount = ref_.cores.filter((c) => !queuedKeys.has(keyRefCor(ref_.refCode, c.cor))).length;

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="p-4 flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm font-semibold text-purple-700 bg-purple-50 px-2 py-0.5 rounded">
              {ref_.refCode}
            </span>
            {ref_.grupo && (
              <span className="text-xs text-gray-500">{ref_.grupo}</span>
            )}
            {ref_.subgrupo && (
              <span className="text-xs text-gray-400">· {ref_.subgrupo}</span>
            )}
            {ref_.fornecedor && (
              <span className="text-xs text-gray-400">· {ref_.fornecedor}</span>
            )}
          </div>
          <p className="text-sm text-gray-700 mt-1 line-clamp-2">
            {ref_.descricao || <em className="text-gray-400">sem descrição</em>}
          </p>
          <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
            <span>{ref_.cores.length} cor{ref_.cores.length !== 1 ? 'es' : ''}</span>
            <span>{ref_.totalVariations} variaç{ref_.totalVariations !== 1 ? 'ões' : 'ão'}</span>
            <span>Estoque total: {ref_.estoqueTotal}</span>
            {ref_.preco != null && (
              <span className="font-medium text-gray-700">R$ {Number(ref_.preco).toFixed(2)}</span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          {!allColorsQueued && (
            <button
              onClick={() => queueAllCores(ref_)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 text-white hover:bg-purple-700 rounded-lg text-xs font-semibold shadow-sm"
              title={`Enfileira todas as ${pendingCount} cores pendentes desta REF num único clique`}
            >
              <Plus className="w-3.5 h-3.5" />
              Enfileirar TODAS ({pendingCount})
            </button>
          )}
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs font-medium text-purple-600 hover:text-purple-800"
          >
            {expanded ? 'Recolher' : 'Ver cores →'}
          </button>
          {!allColorsQueued && (
            <button
              onClick={() => selectAllCores(ref_)}
              className="text-[11px] text-gray-400 hover:text-gray-600"
              title="Só marca — não enfileira"
            >
              marcar todas
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50 divide-y divide-gray-100">
          {ref_.cores.map((cor) => {
            const k = keyRefCor(ref_.refCode, cor.cor);
            const already = queuedKeys.has(k);
            const selected = selectedCors.has(k);
            return (
              <div key={k} className="p-3 flex items-center gap-3">
                <input
                  type="checkbox"
                  disabled={already}
                  checked={selected}
                  onChange={() => toggleSelect(ref_.refCode, cor.cor)}
                  className="w-4 h-4 accent-purple-600"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-gray-900 uppercase">
                      {cor.cor || <em className="text-gray-400 italic">sem cor</em>}
                    </span>
                    <span className="text-xs text-gray-500">· {cor.tamanhos.length} tamanhos · estoque {cor.estoqueTotal}</span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {cor.tamanhos.map((t) => (
                      <span
                        key={t.codigo}
                        title={`código ${t.codigo}${t.ean ? ` / ean ${t.ean}` : ''}`}
                        className={`px-2 py-0.5 text-xs rounded font-mono ${
                          t.estoque > 0 ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-500'
                        }`}
                      >
                        {t.tamanho ?? '-'}:{t.estoque}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  {already ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2 py-1 rounded-full">
                      <CheckCircle2 className="w-3 h-3" />
                      Na fila
                    </span>
                  ) : (
                    <button
                      onClick={() => addOne(ref_.refCode, cor.cor)}
                      disabled={addingKey === k}
                      className="inline-flex items-center gap-1 text-xs font-medium text-white bg-purple-600 hover:bg-purple-700 px-3 py-1.5 rounded-full disabled:opacity-50"
                    >
                      {addingKey === k ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Plus className="w-3 h-3" />
                      )}
                      Enfileirar
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function QueueRow({
  item,
  selected,
  onToggleSelect,
  onRemove,
  onEdit,
}: {
  item: QueueItem;
  selected: boolean;
  onToggleSelect: () => void;
  onRemove: (id: string) => void;
  onEdit: () => void;
}) {
  const statusLabel: Record<string, { label: string; color: string }> = {
    queued: { label: 'Aguardando', color: 'bg-gray-100 text-gray-700' },
    enriched: { label: 'Pronto pra publicar', color: 'bg-blue-100 text-blue-700' },
    publishing: { label: 'Publicando...', color: 'bg-yellow-100 text-yellow-700' },
    published: { label: 'No ar', color: 'bg-green-100 text-green-700' },
    failed: { label: 'Erro', color: 'bg-red-100 text-red-700' },
  };
  const s = statusLabel[item.status] ?? { label: item.status, color: 'bg-gray-100 text-gray-700' };
  const canRemove = item.status !== 'published' && item.status !== 'publishing';
  const isPublished = item.status === 'published';
  const wcAdminUrl =
    isPublished && item.wcProductId && process.env.NEXT_PUBLIC_WC_ADMIN_URL
      ? `${process.env.NEXT_PUBLIC_WC_ADMIN_URL.replace(/\/+$/, '')}/wp-admin/post.php?post=${item.wcProductId}&action=edit`
      : null;

  return (
    <div
      onClick={(e) => {
        // Só abre modal se não clicou em botão
        if ((e.target as HTMLElement).closest('button,a')) return;
        onEdit();
      }}
      className={`border rounded-lg p-3 hover:bg-purple-50 hover:border-purple-200 cursor-pointer transition-colors ${selected ? 'bg-purple-50 border-purple-300' : 'border-gray-200'}`}
    >
      <div className="flex items-start justify-between gap-2">
        {!isPublished && item.status !== 'publishing' && (
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => {
              e.stopPropagation();
              onToggleSelect();
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-4 h-4 accent-purple-600 mt-0.5 shrink-0"
            title="Selecionar pra ação em massa"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs font-semibold text-gray-900">{item.refCode}</span>
            <span className="text-xs font-semibold uppercase text-purple-700">{item.cor}</span>
            <span className={`text-[10px] font-medium uppercase px-1.5 py-0.5 rounded ${s.color}`}>
              {s.label}
            </span>
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5">
            {item.tamanhos?.length ?? 0} tamanhos · estoque {item.estoqueTotal ?? 0}
            {item.precoSugerido && ` · R$ ${Number(item.precoSugerido).toFixed(2)}`}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {wcAdminUrl && (
            <a
              href={wcAdminUrl}
              target="_blank"
              rel="noreferrer"
              className="text-gray-400 hover:text-green-600 p-1"
              title="Abrir no WC"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
          {!isPublished && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              className="text-purple-500 hover:text-purple-700 p-1"
              title="Editar / Enriquecer"
            >
              <Edit3 className="w-3.5 h-3.5" />
            </button>
          )}
          {canRemove && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemove(item.id);
              }}
              className="text-gray-400 hover:text-red-600 p-1"
              title="Remover da fila"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ label, count, color }: { label: string; count: number; color: 'gray' | 'blue' | 'green' | 'red' }) {
  const colors = {
    gray: 'bg-gray-100 text-gray-700',
    blue: 'bg-blue-100 text-blue-700',
    green: 'bg-green-100 text-green-700',
    red: 'bg-red-100 text-red-700',
  };
  return (
    <span className={`text-xs font-medium px-2 py-1 rounded-full ${colors[color]}`}>
      {label}: {count}
    </span>
  );
}
