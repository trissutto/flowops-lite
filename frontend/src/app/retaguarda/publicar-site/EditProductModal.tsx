'use client';

/**
 * EditProductModal — painel lateral de edição do enriquecimento.
 *
 * Layout Notion-like:
 *   - Right drawer (largo, ocupa 80% da tela no desktop, tela cheia no mobile)
 *   - Topo: título editável inline + chip de status + botões (IA, Salvar, Publicar)
 *   - Corpo scrollável com seções:
 *        1) Dados Wincred (readonly — contexto)
 *        2) Título + descrições (long/curta) + tags
 *        3) Categorias WC (checkboxes em árvore)
 *        4) Atributos (lista editável)
 *        5) Imagens (URL + ordem + alt)
 *        6) Preço + promo + peso/dimensões
 *
 * Cada salvar é um PATCH. Botão Publicar só fica habilitado quando todos
 * os campos obrigatórios estão preenchidos (título, descrição, 1 categoria, 1 imagem).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  X, Sparkles, Save, Upload, Trash2, GripVertical, Send, Image as ImageIcon,
  Loader2, AlertCircle, CheckCircle2, Tag, FolderTree, Ruler, DollarSign,
  Type, FileText, Wand2, Plus,
} from 'lucide-react';
import { api } from '@/lib/api';

// ─── Tipos ──────────────────────────────────────────────────────────────

type QueueItem = {
  id: string;
  refCode: string;
  cor: string;
  status: string;
  descricaoSnapshot?: string;
  fornecedor: string | null;
  grupo: string | null;
  subgrupo: string | null;
  custoMedio: string | null;
  precoSugerido: string | null;
  estoqueTotal: number | null;
  tamanhos: Array<{ tamanho: string | null; codigo: string; estoque: number; ean: string | null }>;
  gigaCodes?: string[];
  // Fase 2
  wcTitulo?: string | null;
  wcCategoryIds?: number[] | null;
  wcTags?: string[] | null;
  wcAtributos?: Array<{ nome: string; valor: string }> | null;
  wcDescricao?: string | null;
  wcDescricaoCurta?: string | null;
  wcImagens?: Array<{ id?: number; url: string; alt?: string }> | null;
  wcPesoKg?: string | null;
  wcDimensoesCm?: { comprimento?: number; largura?: number; altura?: number } | null;
  wcPrecoVenda?: string | null;
  wcPrecoPromo?: string | null;
  aiGeneratedAt?: string | null;
  // Fase 3
  wcProductId?: number | null;
  publishedAt?: string | null;
  errorMessage?: string | null;
};

type WcCategory = { id: number; name: string; slug: string; parent: number; count: number };

type IntegrationStatus = { aiEnabled: boolean; mediaUploadEnabled: boolean };

type Props = {
  itemId: string;
  onClose: () => void;
  onSaved: () => void;        // chamado depois de salvar/publicar pra recarregar a fila
};

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Monta árvore de categorias WC. Para dropdown simples, usamos indent visual
 * baseado no parent (profundidade 0, 1, 2).
 */
function flattenCategoriesWithDepth(cats: WcCategory[]): Array<WcCategory & { depth: number }> {
  const byId = new Map<number, WcCategory>();
  cats.forEach((c) => byId.set(c.id, c));

  const depthOf = (c: WcCategory, seen = new Set<number>()): number => {
    if (c.parent === 0) return 0;
    if (seen.has(c.id)) return 0; // ciclo — defensivo
    seen.add(c.id);
    const parent = byId.get(c.parent);
    if (!parent) return 0;
    return 1 + depthOf(parent, seen);
  };

  // Ordena: pais primeiro, filhos depois — mantém hierarquia visual
  const withDepth = cats.map((c) => ({ ...c, depth: depthOf(c) }));
  withDepth.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.name.localeCompare(b.name);
  });
  return withDepth;
}

// ─── Componente ─────────────────────────────────────────────────────────

export default function EditProductModal({ itemId, onClose, onSaved }: Props) {
  const [item, setItem] = useState<QueueItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [integration, setIntegration] = useState<IntegrationStatus | null>(null);

  // Form state (desacoplado do item pra permitir edição sem autosave)
  const [titulo, setTitulo] = useState('');
  const [descricao, setDescricao] = useState('');
  const [descricaoCurta, setDescricaoCurta] = useState('');
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [atributos, setAtributos] = useState<Array<{ nome: string; valor: string }>>([]);
  const [imagens, setImagens] = useState<Array<{ id?: number; url: string; alt?: string }>>([]);
  const [imgUrlInput, setImgUrlInput] = useState('');
  const [imgAltInput, setImgAltInput] = useState('');
  const [precoVenda, setPrecoVenda] = useState('');
  const [precoPromo, setPrecoPromo] = useState('');
  const [pesoKg, setPesoKg] = useState('');
  const [comprimento, setComprimento] = useState('');
  const [largura, setLargura] = useState('');
  const [altura, setAltura] = useState('');

  // Catálogo WC (carrega uma vez)
  const [categories, setCategories] = useState<WcCategory[]>([]);
  const [catsLoading, setCatsLoading] = useState(false);
  const [catFilter, setCatFilter] = useState('');

  // ─── Carga inicial ───────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [it, stat] = await Promise.all([
          api<QueueItem>(`/site-publish/queue/${itemId}`),
          api<IntegrationStatus>('/site-publish/status').catch(() => null),
        ]);
        setItem(it);
        setIntegration(stat);
        // Hydrate form state
        setTitulo(it.wcTitulo || '');
        setDescricao(it.wcDescricao || '');
        setDescricaoCurta(it.wcDescricaoCurta || '');
        setCategoryIds(Array.isArray(it.wcCategoryIds) ? it.wcCategoryIds : []);
        setTags(Array.isArray(it.wcTags) ? it.wcTags : []);
        setAtributos(Array.isArray(it.wcAtributos) ? it.wcAtributos : []);
        setImagens(Array.isArray(it.wcImagens) ? it.wcImagens : []);
        setPrecoVenda(it.wcPrecoVenda ? String(it.wcPrecoVenda) : it.precoSugerido ? String(it.precoSugerido) : '');
        setPrecoPromo(it.wcPrecoPromo ? String(it.wcPrecoPromo) : '');
        setPesoKg(it.wcPesoKg ? String(it.wcPesoKg) : '');
        setComprimento(it.wcDimensoesCm?.comprimento ? String(it.wcDimensoesCm.comprimento) : '');
        setLargura(it.wcDimensoesCm?.largura ? String(it.wcDimensoesCm.largura) : '');
        setAltura(it.wcDimensoesCm?.altura ? String(it.wcDimensoesCm.altura) : '');
      } catch (e: any) {
        setError(`Falha ao carregar: ${e?.message || e}`);
      } finally {
        setLoading(false);
      }
    })();
  }, [itemId]);

  // Categorias WC — carrega lazy ao abrir a seção
  const loadCategories = async () => {
    if (categories.length) return;
    setCatsLoading(true);
    try {
      const cats = await api<WcCategory[]>('/site-publish/wc/categories');
      setCategories(cats);
    } catch (e: any) {
      setToast(`Falha ao listar categorias WC: ${e?.message}`);
      setTimeout(() => setToast(null), 4000);
    } finally {
      setCatsLoading(false);
    }
  };
  useEffect(() => {
    loadCategories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sortedCats = useMemo(() => flattenCategoriesWithDepth(categories), [categories]);
  const visibleCats = useMemo(() => {
    if (!catFilter.trim()) return sortedCats;
    const needle = catFilter.toLowerCase();
    return sortedCats.filter(
      (c) => c.name.toLowerCase().includes(needle) || c.slug.toLowerCase().includes(needle),
    );
  }, [sortedCats, catFilter]);

  // ─── Ações ───────────────────────────────────────────────────────────

  const save = async (opts: { silent?: boolean } = {}) => {
    setSaving(true);
    try {
      const payload: any = {
        wcTitulo: titulo.trim() || null,
        wcDescricao: descricao || null,
        wcDescricaoCurta: descricaoCurta || null,
        wcCategoryIds: categoryIds,
        wcTags: tags,
        wcAtributos: atributos.filter((a) => a.nome && a.valor),
        wcImagens: imagens.filter((i) => i.url),
        wcPrecoVenda: precoVenda ? Number(precoVenda) : null,
        wcPrecoPromo: precoPromo ? Number(precoPromo) : null,
        wcPesoKg: pesoKg ? Number(pesoKg) : null,
        wcDimensoesCm:
          comprimento || largura || altura
            ? {
                comprimento: comprimento ? Number(comprimento) : undefined,
                largura: largura ? Number(largura) : undefined,
                altura: altura ? Number(altura) : undefined,
              }
            : null,
      };
      const updated = await api<QueueItem>(`/site-publish/queue/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setItem(updated);
      if (!opts.silent) setToast('✓ Salvo');
      onSaved();
    } catch (e: any) {
      setToast(`Erro ao salvar: ${e?.message || e}`);
    } finally {
      setSaving(false);
      setTimeout(() => setToast(null), 2500);
    }
  };

  const runAi = async () => {
    if (!integration?.aiEnabled) {
      setToast('IA desabilitada. Configure ANTHROPIC_API_KEY no backend.');
      setTimeout(() => setToast(null), 4000);
      return;
    }
    const force = !!(titulo || descricao);
    if (force && !confirm('Já existe conteúdo. Sobrescrever com IA?')) return;

    setAiRunning(true);
    try {
      const res = await api<{ item: QueueItem; generated: any }>(`/site-publish/queue/${itemId}/ai`, {
        method: 'POST',
        body: JSON.stringify({ force }),
      });
      const it = res.item;
      setItem(it);
      setTitulo(it.wcTitulo || '');
      setDescricao(it.wcDescricao || '');
      setDescricaoCurta(it.wcDescricaoCurta || '');
      setTags(Array.isArray(it.wcTags) ? it.wcTags : []);
      setAtributos(Array.isArray(it.wcAtributos) ? it.wcAtributos : []);
      setToast('✨ IA gerou conteúdo — revise e salve.');
      onSaved();
    } catch (e: any) {
      setToast(`Erro IA: ${e?.message || e}`);
    } finally {
      setAiRunning(false);
      setTimeout(() => setToast(null), 4000);
    }
  };

  const addImage = async () => {
    const url = imgUrlInput.trim();
    if (!url) return;

    // Valida: só aceita URL pública (http/https). Caminho local (C:\, file://,
    // /Users/, etc.) NUNCA funciona — WC não consegue fetchar arquivo da máquina
    // do CEO. Mensagem clara pra evitar a confusão de publicar e dar erro 400.
    const isPublicUrl = /^https?:\/\//i.test(url);
    if (!isPublicUrl) {
      setToast(
        'Só funciona URL pública (https://...). Caminho local (C:\\... ou arquivo no PC) não dá — suba a imagem num host público ou configure WP_APP_USER no .env pra upload direto.',
      );
      setTimeout(() => setToast(null), 7000);
      return;
    }
    // Formatos que o WP padrão NÃO aceita (AVIF/HEIC exigem suporte GD/Imagick
    // específico — a maioria dos hosts não tem). Avisa mas deixa o CEO escolher.
    if (/\.(avif|heic|heif)(\?|$)/i.test(url)) {
      const ok = confirm(
        'Essa imagem é .avif/.heic — o WordPress geralmente NÃO aceita esse formato.\n\n' +
          'Vai provavelmente falhar na hora de publicar com "Sem permissão para enviar esse tipo de arquivo".\n\n' +
          'Recomendo usar a versão .jpg que o WP gera automaticamente (miniaturas).\n\n' +
          'Quer adicionar mesmo assim?',
      );
      if (!ok) return;
    }

    // Se upload habilitado, tenta fazer upload; senão salva URL direta
    if (integration?.mediaUploadEnabled) {
      try {
        const res = await api<{ wcImagens: any[] }>(`/site-publish/queue/${itemId}/image`, {
          method: 'POST',
          body: JSON.stringify({ sourceUrl: url, alt: imgAltInput.trim() }),
        });
        setImagens(res.wcImagens);
        setImgUrlInput('');
        setImgAltInput('');
        setToast('✓ Imagem enviada pro WP');
      } catch (e: any) {
        setToast(`Upload falhou: ${e?.message}. Salvando só a URL.`);
        setImagens((prev) => [...prev, { url, alt: imgAltInput.trim() }]);
        setImgUrlInput('');
        setImgAltInput('');
      }
    } else {
      setImagens((prev) => [...prev, { url, alt: imgAltInput.trim() }]);
      setImgUrlInput('');
      setImgAltInput('');
    }
    setTimeout(() => setToast(null), 3000);
  };

  const removeImage = (idx: number) => {
    setImagens((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveImage = (from: number, to: number) => {
    if (to < 0 || to >= imagens.length) return;
    setImagens((prev) => {
      const n = [...prev];
      const [spliced] = n.splice(from, 1);
      n.splice(to, 0, spliced);
      return n;
    });
  };

  const addTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    if (tags.includes(t)) return;
    setTags((prev) => [...prev, t]);
    setTagInput('');
  };

  const removeTag = (t: string) => setTags((prev) => prev.filter((x) => x !== t));

  const addAtributo = () => setAtributos((prev) => [...prev, { nome: '', valor: '' }]);
  const updateAtributo = (idx: number, field: 'nome' | 'valor', val: string) => {
    setAtributos((prev) => prev.map((a, i) => (i === idx ? { ...a, [field]: val } : a)));
  };
  const removeAtributo = (idx: number) => setAtributos((prev) => prev.filter((_, i) => i !== idx));

  const toggleCategory = (id: number) => {
    setCategoryIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const publish = async () => {
    // Salva antes de publicar pra garantir que banco tá sincronizado com form
    await save({ silent: true });
    if (!confirm(`Publicar "${titulo || item?.refCode}" como RASCUNHO no site? CEO vai precisar clicar Publish no WC admin depois.`)) {
      return;
    }
    setPublishing(true);
    try {
      const res = await api<QueueItem>(`/site-publish/queue/${itemId}/publish`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setItem(res);
      setToast(`✓ Publicado! WC #${res.wcProductId}`);
      onSaved();
    } catch (e: any) {
      setToast(`Erro ao publicar: ${e?.message || e}`);
    } finally {
      setPublishing(false);
      setTimeout(() => setToast(null), 5000);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────
  const statusColors: Record<string, string> = {
    queued: 'bg-slate-100 text-slate-700',
    enriched: 'bg-blue-100 text-blue-700',
    publishing: 'bg-amber-100 text-amber-700',
    published: 'bg-emerald-100 text-emerald-700',
    failed: 'bg-rose-100 text-rose-700',
  };

  // Imagem é opcional — vai como draft, CEO pode anexar depois no WC admin.
  const ready = titulo.trim() && descricao.trim() && categoryIds.length > 0;

  return (
    <div className="fixed inset-0 z-[100] flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/40" onClick={onClose} />

      {/* Drawer */}
      <div className="w-full md:w-[800px] lg:w-[900px] bg-white h-full overflow-y-auto shadow-2xl flex flex-col">
        {/* Topo fixo */}
        <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-gray-100 rounded"
              aria-label="Fechar"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono bg-gray-100 px-2 py-0.5 rounded">
                  {item?.refCode || '…'}
                </span>
                <span className="text-xs font-medium text-gray-600">{item?.cor}</span>
                {item?.status && (
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[item.status] || 'bg-gray-100 text-gray-700'}`}>
                    {item.status}
                  </span>
                )}
                {item?.wcProductId && (
                  <a
                    href={`${(process.env.NEXT_PUBLIC_WC_ADMIN_URL || 'https://www.lurds.com.br')}/wp-admin/post.php?post=${item.wcProductId}&action=edit`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-blue-600 hover:underline"
                  >
                    abrir no WC →
                  </a>
                )}
              </div>
              <h2 className="text-sm text-gray-500 truncate">
                {item?.grupo || '—'}{item?.subgrupo ? ` · ${item.subgrupo}` : ''}
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={runAi}
              disabled={aiRunning || loading || !integration?.aiEnabled}
              title={integration?.aiEnabled ? 'Gerar título/descrição/tags/atributos com Claude' : 'Configure ANTHROPIC_API_KEY'}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {aiRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              IA
            </button>
            <button
              onClick={() => save()}
              disabled={saving || loading}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Salvar
            </button>
            <button
              onClick={publish}
              disabled={!ready || publishing || item?.status === 'published'}
              title={
                item?.status === 'published'
                  ? 'Já publicado'
                  : !ready
                  ? 'Faltam campos (título, descrição, categoria, imagem)'
                  : 'Publicar como rascunho no WC'
              }
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {publishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Publicar
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
          </div>
        ) : error ? (
          <div className="p-5">
            <div className="bg-rose-50 border border-rose-200 rounded-lg p-4 text-rose-800 text-sm flex items-start gap-2">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              {error}
            </div>
          </div>
        ) : item ? (
          <div className="flex-1 px-5 py-4 space-y-6">
            {/* Banner de erro/sucesso de publicação */}
            {item.status === 'failed' && item.errorMessage && (
              <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-sm text-rose-800 flex items-start gap-2">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold">Última publicação falhou</div>
                  <div className="text-xs mt-1">{item.errorMessage}</div>
                </div>
              </div>
            )}
            {item.status === 'published' && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-800 flex items-start gap-2">
                <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
                <div>
                  Produto publicado como RASCUNHO no WC (id {item.wcProductId}). Revise no admin e clique em "Publish".
                </div>
              </div>
            )}

            {/* Dados Wincred (readonly) */}
            <div className="bg-slate-50 rounded-lg p-4 text-sm">
              <h3 className="font-semibold text-slate-700 mb-2 flex items-center gap-2">
                <FileText className="w-4 h-4" />
                Snapshot Wincred
              </h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <dt className="text-slate-500">REF:</dt><dd className="font-mono">{item.refCode}</dd>
                <dt className="text-slate-500">Cor:</dt><dd>{item.cor}</dd>
                <dt className="text-slate-500">Estoque total:</dt><dd>{item.estoqueTotal}</dd>
                <dt className="text-slate-500">Tamanhos:</dt>
                <dd>{item.tamanhos.map((t) => t.tamanho || '?').join(', ')}</dd>
                {item.custoMedio && <><dt className="text-slate-500">Custo médio:</dt><dd>R$ {item.custoMedio}</dd></>}
                {item.precoSugerido && <><dt className="text-slate-500">Preço Wincred:</dt><dd>R$ {item.precoSugerido}</dd></>}
              </dl>
            </div>

            {/* Título */}
            <Section icon={<Type className="w-4 h-4" />} label="Título (otimizado para SEO)">
              <input
                type="text"
                value={titulo}
                onChange={(e) => setTitulo(e.target.value)}
                placeholder="Ex: Vestido Plus Size Midi Azul Marinho - Lurds 46 ao 60"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
              <div className="text-xs text-gray-400 mt-1">{titulo.length} chars · ideal entre 50-80</div>
            </Section>

            {/* Descrição curta */}
            <Section icon={<Type className="w-4 h-4" />} label="Descrição curta (aparece no topo do produto)">
              <textarea
                value={descricaoCurta}
                onChange={(e) => setDescricaoCurta(e.target.value)}
                rows={2}
                placeholder="1 frase vendedora curta, até 120 chars"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
              <div className="text-xs text-gray-400 mt-1">{descricaoCurta.length} / 120 chars</div>
            </Section>

            {/* Descrição longa */}
            <Section icon={<FileText className="w-4 h-4" />} label="Descrição longa (HTML simples)">
              <textarea
                value={descricao}
                onChange={(e) => setDescricao(e.target.value)}
                rows={8}
                placeholder="Aceita <p>, <strong>, <br>. 4-7 linhas com benefício, tecido, caimento, ocasião, CTA."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </Section>

            {/* Categorias WC */}
            <Section
              icon={<FolderTree className="w-4 h-4" />}
              label={`Categorias WooCommerce (${categoryIds.length} selecionadas)`}
            >
              {catsLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <Loader2 className="w-4 h-4 animate-spin" /> Carregando categorias do site…
                </div>
              ) : (
                <>
                  <input
                    type="text"
                    value={catFilter}
                    onChange={(e) => setCatFilter(e.target.value)}
                    placeholder="Filtrar categorias…"
                    className="w-full px-3 py-2 mb-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <div className="max-h-56 overflow-y-auto border border-gray-200 rounded-lg">
                    {visibleCats.length === 0 && (
                      <div className="p-3 text-xs text-gray-400">Nenhuma categoria.</div>
                    )}
                    {visibleCats.map((c) => (
                      <label
                        key={c.id}
                        className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 cursor-pointer"
                        style={{ paddingLeft: `${12 + c.depth * 16}px` }}
                      >
                        <input
                          type="checkbox"
                          checked={categoryIds.includes(c.id)}
                          onChange={() => toggleCategory(c.id)}
                        />
                        <span>{c.name}</span>
                        {c.count > 0 && (
                          <span className="text-xs text-gray-400">({c.count})</span>
                        )}
                      </label>
                    ))}
                  </div>
                </>
              )}
            </Section>

            {/* Tags */}
            <Section icon={<Tag className="w-4 h-4" />} label="Tags (pressione Enter pra adicionar)">
              <div className="flex flex-wrap gap-1.5 mb-2">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 rounded-full text-xs"
                  >
                    {t}
                    <button onClick={() => removeTag(t)} className="hover:text-rose-600">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag();
                  }
                }}
                placeholder="plus size, vestido longo, casual…"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </Section>

            {/* Atributos */}
            <Section icon={<Wand2 className="w-4 h-4" />} label="Atributos (tecido, caimento, etc)">
              <div className="space-y-1.5">
                {atributos.map((a, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      type="text"
                      value={a.nome}
                      onChange={(e) => updateAtributo(i, 'nome', e.target.value)}
                      placeholder="Nome"
                      className="w-40 px-2 py-1.5 border border-gray-300 rounded text-sm"
                    />
                    <input
                      type="text"
                      value={a.valor}
                      onChange={(e) => updateAtributo(i, 'valor', e.target.value)}
                      placeholder="Valor"
                      className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-sm"
                    />
                    <button
                      onClick={() => removeAtributo(i)}
                      className="p-1.5 text-rose-600 hover:bg-rose-50 rounded"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={addAtributo}
                className="mt-2 flex items-center gap-1 text-xs text-purple-600 hover:text-purple-800"
              >
                <Plus className="w-3.5 h-3.5" /> adicionar atributo
              </button>
            </Section>

            {/* Imagens */}
            <Section icon={<ImageIcon className="w-4 h-4" />} label={`Imagens (${imagens.length})`}>
              <div className="space-y-2 mb-3">
                {imagens.map((img, i) => (
                  <div key={i} className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg">
                    <GripVertical className="w-4 h-4 text-gray-400" />
                    <img
                      src={img.url}
                      alt={img.alt || ''}
                      className="w-14 h-14 object-cover rounded border"
                      onError={(e) => (e.currentTarget.style.opacity = '0.3')}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-mono truncate">{img.url}</div>
                      {img.alt && <div className="text-xs text-gray-500 truncate">{img.alt}</div>}
                      {img.id && <div className="text-xs text-emerald-600">✓ WP media #{img.id}</div>}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <button onClick={() => moveImage(i, i - 1)} disabled={i === 0} className="text-xs disabled:opacity-30 hover:text-blue-600">▲</button>
                      <button onClick={() => moveImage(i, i + 1)} disabled={i === imagens.length - 1} className="text-xs disabled:opacity-30 hover:text-blue-600">▼</button>
                    </div>
                    <button
                      onClick={() => removeImage(i)}
                      className="p-1.5 text-rose-600 hover:bg-rose-50 rounded"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="border border-dashed border-gray-300 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-2">
                  {integration?.mediaUploadEnabled ? (
                    <span>
                      Cole URL <strong>pública</strong> (https://…) — será uploadada pro WP Media.
                    </span>
                  ) : (
                    <span>
                      Upload direto do PC <strong>desligado</strong>. Cole URL pública (https://…)
                      ou configure <code className="bg-gray-100 px-1 rounded">WP_APP_USER</code> +{' '}
                      <code className="bg-gray-100 px-1 rounded">WP_APP_PASSWORD</code> no .env pra
                      subir arquivo direto.{' '}
                      <strong className="text-rose-700">
                        Caminho local do PC (C:\…) não funciona.
                      </strong>
                    </span>
                  )}
                </div>
                <div className="flex gap-2 mb-2">
                  <input
                    type="url"
                    value={imgUrlInput}
                    onChange={(e) => setImgUrlInput(e.target.value)}
                    placeholder="https://…/imagem.jpg"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm"
                  />
                  <input
                    type="text"
                    value={imgAltInput}
                    onChange={(e) => setImgAltInput(e.target.value)}
                    placeholder="Alt (opcional)"
                    className="w-48 px-3 py-2 border border-gray-300 rounded text-sm"
                  />
                </div>
                <button
                  onClick={addImage}
                  disabled={!imgUrlInput.trim()}
                  className="flex items-center gap-1 px-3 py-1.5 bg-purple-600 text-white rounded text-sm hover:bg-purple-700 disabled:opacity-50"
                >
                  <Upload className="w-3.5 h-3.5" /> Adicionar
                </button>
              </div>
            </Section>

            {/* Preço + peso/dimensões */}
            <Section icon={<DollarSign className="w-4 h-4" />} label="Preço e envio">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Preço de venda (R$)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={precoVenda}
                    onChange={(e) => setPrecoVenda(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Preço promocional (opcional)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={precoPromo}
                    onChange={(e) => setPrecoPromo(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Peso (kg)</label>
                  <input
                    type="number"
                    step="0.001"
                    value={pesoKg}
                    onChange={(e) => setPesoKg(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                  />
                </div>
                <div className="flex gap-1.5">
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">C (cm)</label>
                    <input type="number" value={comprimento} onChange={(e) => setComprimento(e.target.value)} className="w-full px-2 py-2 border border-gray-300 rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">L</label>
                    <input type="number" value={largura} onChange={(e) => setLargura(e.target.value)} className="w-full px-2 py-2 border border-gray-300 rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">A</label>
                    <input type="number" value={altura} onChange={(e) => setAltura(e.target.value)} className="w-full px-2 py-2 border border-gray-300 rounded text-sm" />
                  </div>
                </div>
              </div>
            </Section>
          </div>
        ) : null}

        {toast && (
          <div className="fixed bottom-6 right-6 bg-slate-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-[110]">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Subcomponentes ─────────────────────────────────────────────────────

function Section({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 mb-1.5 uppercase tracking-wide">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}
