'use client';

/**
 * BulkEditModal — aplica o MESMO patch em vários itens da fila.
 *
 * Caso de uso principal: CEO acabou de enfileirar 8 cores da mesma REF e
 * quer setar título-base, descrição, categorias, tags, atributos, peso e
 * preço de uma vez só. Depois ajusta particularidades (cor no título) em
 * cada item abrindo o modal individual.
 *
 * Só mexe em campos que o CEO marcar — campos em branco ficam intocados.
 * NÃO edita imagens nem snapshot Wincred (esses são específicos por cor).
 *
 * Placeholders suportados no título:
 *   {cor}   → substitui pela cor do item
 *   {ref}   → substitui pelo refCode
 *
 * Ex: "Calça Jeans Plus Size {cor} - Lurds 46 ao 60"
 *   → aplica com item.cor="AZUL" → "Calça Jeans Plus Size AZUL - Lurds..."
 */

import { useEffect, useState } from 'react';
import { X, Save, Loader2, Tag as TagIcon, FolderTree, Sparkles, Info } from 'lucide-react';
import { api } from '@/lib/api';

type WcCategory = { id: number; name: string; slug: string; parent: number; count: number };

type Props = {
  ids: string[];
  onClose: () => void;
  onSaved: () => void;
};

function flattenCats(cats: WcCategory[]): Array<WcCategory & { depth: number }> {
  const byId = new Map<number, WcCategory>();
  cats.forEach((c) => byId.set(c.id, c));
  const depthOf = (c: WcCategory, seen = new Set<number>()): number => {
    if (c.parent === 0) return 0;
    if (seen.has(c.id)) return 0;
    seen.add(c.id);
    const p = byId.get(c.parent);
    if (!p) return 0;
    return 1 + depthOf(p, seen);
  };
  const arr = cats.map((c) => ({ ...c, depth: depthOf(c) }));
  arr.sort((a, b) => (a.depth - b.depth) || a.name.localeCompare(b.name));
  return arr;
}

export default function BulkEditModal({ ids, onClose, onSaved }: Props) {
  // Cada campo tem um "ativo?" (checkbox) — só envia os marcados.
  const [useTitulo, setUseTitulo] = useState(false);
  const [titulo, setTitulo] = useState('');

  const [useDescricao, setUseDescricao] = useState(false);
  const [descricao, setDescricao] = useState('');

  const [useDescricaoCurta, setUseDescricaoCurta] = useState(false);
  const [descricaoCurta, setDescricaoCurta] = useState('');

  const [useCategorias, setUseCategorias] = useState(false);
  const [categorias, setCategorias] = useState<WcCategory[]>([]);
  const [catsLoading, setCatsLoading] = useState(false);
  const [catSearch, setCatSearch] = useState('');
  const [categoryIds, setCategoryIds] = useState<number[]>([]);

  const [useTags, setUseTags] = useState(false);
  const [tagsInput, setTagsInput] = useState('');

  const [useAtributos, setUseAtributos] = useState(false);
  const [atributos, setAtributos] = useState<Array<{ nome: string; valor: string }>>([
    { nome: '', valor: '' },
  ]);

  const [usePeso, setUsePeso] = useState(false);
  const [pesoKg, setPesoKg] = useState('');

  const [useDimensoes, setUseDimensoes] = useState(false);
  const [dimC, setDimC] = useState('');
  const [dimL, setDimL] = useState('');
  const [dimA, setDimA] = useState('');

  const [usePrecoVenda, setUsePrecoVenda] = useState(false);
  const [precoVenda, setPrecoVenda] = useState('');

  const [usePrecoPromo, setUsePrecoPromo] = useState(false);
  const [precoPromo, setPrecoPromo] = useState('');

  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Carrega categorias WC ao abrir (lazy — só quando marca o checkbox)
  useEffect(() => {
    if (!useCategorias || categorias.length > 0) return;
    setCatsLoading(true);
    api<WcCategory[]>('/site-publish/wc/categories')
      .then((cats) => setCategorias(cats))
      .catch((e) => setToast(`Erro ao carregar categorias: ${e?.message || e}`))
      .finally(() => setCatsLoading(false));
  }, [useCategorias, categorias.length]);

  const toggleCat = (id: number) => {
    setCategoryIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const addAtr = () => setAtributos((prev) => [...prev, { nome: '', valor: '' }]);
  const rmAtr = (i: number) => setAtributos((prev) => prev.filter((_, idx) => idx !== i));
  const setAtr = (i: number, k: 'nome' | 'valor', v: string) =>
    setAtributos((prev) => prev.map((a, idx) => (idx === i ? { ...a, [k]: v } : a)));

  const handleSave = async () => {
    const patch: any = {};
    if (useTitulo && titulo.trim()) patch.wcTitulo = titulo.trim();
    if (useDescricao && descricao.trim()) patch.wcDescricao = descricao.trim();
    if (useDescricaoCurta && descricaoCurta.trim()) patch.wcDescricaoCurta = descricaoCurta.trim();
    if (useCategorias) patch.wcCategoryIds = categoryIds;
    if (useTags) {
      patch.wcTags = tagsInput
        .split(/[,\n]+/)
        .map((t) => t.trim())
        .filter(Boolean);
    }
    if (useAtributos) {
      patch.wcAtributos = atributos
        .map((a) => ({ nome: a.nome.trim(), valor: a.valor.trim() }))
        .filter((a) => a.nome && a.valor);
    }
    if (usePeso && pesoKg) patch.wcPesoKg = Number(pesoKg);
    if (useDimensoes) {
      patch.wcDimensoesCm = {
        comprimento: dimC ? Number(dimC) : undefined,
        largura: dimL ? Number(dimL) : undefined,
        altura: dimA ? Number(dimA) : undefined,
      };
    }
    if (usePrecoVenda && precoVenda) patch.wcPrecoVenda = Number(precoVenda);
    if (usePrecoPromo && precoPromo) patch.wcPrecoPromo = Number(precoPromo);

    if (Object.keys(patch).length === 0) {
      setToast('Marque pelo menos 1 campo pra aplicar.');
      setTimeout(() => setToast(null), 3000);
      return;
    }

    setSaving(true);
    try {
      const res = await api<{ total: number; updated: number; skipped: any[] }>(
        '/site-publish/queue/bulk',
        { method: 'PATCH', body: JSON.stringify({ ids, patch }) },
      );
      const skipMsg = res.skipped?.length ? ` · ${res.skipped.length} pulado(s)` : '';
      setToast(`✓ ${res.updated}/${res.total} atualizados${skipMsg}`);
      setTimeout(() => {
        onSaved();
        onClose();
      }, 1200);
    } catch (e: any) {
      setToast(`Erro: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  const catsFiltered = catSearch.trim()
    ? flattenCats(categorias).filter((c) => c.name.toLowerCase().includes(catSearch.toLowerCase()))
    : flattenCats(categorias);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Edição em bloco</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Aplica os campos marcados em {ids.length} {ids.length > 1 ? 'itens' : 'item'}. Itens
              já publicados não são afetados.
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Corpo */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Dica sobre placeholders */}
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2 text-xs text-amber-800">
            <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              <strong>Dica:</strong> marque o checkbox só dos campos que quer aplicar. Os outros
              ficam como estão em cada item. Dica pro <em>título</em>: é melhor gerar um por um
              pela IA pra ficar personalizado por cor.
            </div>
          </div>

          {/* Título */}
          <FieldBlock
            checked={useTitulo}
            onToggle={setUseTitulo}
            label="Título (sobrescreve pra TODOS)"
            icon={<Sparkles className="w-4 h-4" />}
          >
            <input
              type="text"
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              placeholder="Ex: Calça Jeans Plus Size Lurds 46 ao 60"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              disabled={!useTitulo}
            />
          </FieldBlock>

          {/* Descrição longa */}
          <FieldBlock
            checked={useDescricao}
            onToggle={setUseDescricao}
            label="Descrição longa"
          >
            <textarea
              rows={5}
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              placeholder="Aceita <p>, <strong>, <br>. 4-7 linhas."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
              disabled={!useDescricao}
            />
          </FieldBlock>

          {/* Descrição curta */}
          <FieldBlock
            checked={useDescricaoCurta}
            onToggle={setUseDescricaoCurta}
            label="Descrição curta"
          >
            <textarea
              rows={2}
              value={descricaoCurta}
              onChange={(e) => setDescricaoCurta(e.target.value)}
              maxLength={120}
              placeholder="1 frase até 120 chars"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              disabled={!useDescricaoCurta}
            />
          </FieldBlock>

          {/* Categorias */}
          <FieldBlock
            checked={useCategorias}
            onToggle={setUseCategorias}
            label={`Categorias WC (${categoryIds.length} selec.)`}
            icon={<FolderTree className="w-4 h-4" />}
          >
            {catsLoading && <p className="text-xs text-gray-500">Carregando...</p>}
            {!catsLoading && categorias.length > 0 && (
              <>
                <input
                  type="text"
                  value={catSearch}
                  onChange={(e) => setCatSearch(e.target.value)}
                  placeholder="Filtrar..."
                  className="w-full px-3 py-1.5 border border-gray-300 rounded text-xs mb-2"
                  disabled={!useCategorias}
                />
                <div className="border border-gray-200 rounded max-h-48 overflow-y-auto">
                  {catsFiltered.map((c) => (
                    <label
                      key={c.id}
                      className="flex items-center gap-2 px-2 py-1 hover:bg-gray-50 text-xs cursor-pointer"
                      style={{ paddingLeft: `${c.depth * 16 + 8}px` }}
                    >
                      <input
                        type="checkbox"
                        checked={categoryIds.includes(c.id)}
                        onChange={() => toggleCat(c.id)}
                        disabled={!useCategorias}
                        className="w-3.5 h-3.5 accent-blue-600"
                      />
                      <span>{c.name}</span>
                      <span className="text-gray-400 ml-auto">({c.count})</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </FieldBlock>

          {/* Tags */}
          <FieldBlock
            checked={useTags}
            onToggle={setUseTags}
            label="Tags"
            icon={<TagIcon className="w-4 h-4" />}
          >
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="plus size, jeans, 46 ao 60 (separadas por vírgula)"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              disabled={!useTags}
            />
          </FieldBlock>

          {/* Atributos */}
          <FieldBlock
            checked={useAtributos}
            onToggle={setUseAtributos}
            label="Atributos"
          >
            {atributos.map((a, i) => (
              <div key={i} className="flex gap-2 mb-2">
                <input
                  type="text"
                  value={a.nome}
                  onChange={(e) => setAtr(i, 'nome', e.target.value)}
                  placeholder="Nome (ex: Tecido)"
                  className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-sm"
                  disabled={!useAtributos}
                />
                <input
                  type="text"
                  value={a.valor}
                  onChange={(e) => setAtr(i, 'valor', e.target.value)}
                  placeholder="Valor (ex: Viscose c/ elastano)"
                  className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-sm"
                  disabled={!useAtributos}
                />
                <button
                  onClick={() => rmAtr(i)}
                  disabled={!useAtributos}
                  className="px-2 text-gray-400 hover:text-red-500 disabled:opacity-40"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              onClick={addAtr}
              disabled={!useAtributos}
              className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-40"
            >
              + atributo
            </button>
          </FieldBlock>

          {/* Peso + dimensões */}
          <FieldBlock checked={usePeso} onToggle={setUsePeso} label="Peso (kg)">
            <input
              type="number"
              step="0.01"
              value={pesoKg}
              onChange={(e) => setPesoKg(e.target.value)}
              placeholder="0.30"
              className="w-32 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              disabled={!usePeso}
            />
          </FieldBlock>

          <FieldBlock
            checked={useDimensoes}
            onToggle={setUseDimensoes}
            label="Dimensões (cm)"
          >
            <div className="flex gap-2">
              <input type="number" value={dimC} onChange={(e) => setDimC(e.target.value)} placeholder="Comp" className="w-20 px-2 py-1.5 border border-gray-300 rounded text-sm" disabled={!useDimensoes} />
              <input type="number" value={dimL} onChange={(e) => setDimL(e.target.value)} placeholder="Larg" className="w-20 px-2 py-1.5 border border-gray-300 rounded text-sm" disabled={!useDimensoes} />
              <input type="number" value={dimA} onChange={(e) => setDimA(e.target.value)} placeholder="Alt" className="w-20 px-2 py-1.5 border border-gray-300 rounded text-sm" disabled={!useDimensoes} />
            </div>
          </FieldBlock>

          {/* Preço */}
          <FieldBlock
            checked={usePrecoVenda}
            onToggle={setUsePrecoVenda}
            label="Preço de venda (R$)"
          >
            <input
              type="number"
              step="0.01"
              value={precoVenda}
              onChange={(e) => setPrecoVenda(e.target.value)}
              placeholder="159.90"
              className="w-32 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              disabled={!usePrecoVenda}
            />
          </FieldBlock>

          <FieldBlock
            checked={usePrecoPromo}
            onToggle={setUsePrecoPromo}
            label="Preço promocional (R$)"
          >
            <input
              type="number"
              step="0.01"
              value={precoPromo}
              onChange={(e) => setPrecoPromo(e.target.value)}
              placeholder="129.90"
              className="w-32 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              disabled={!usePrecoPromo}
            />
          </FieldBlock>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 flex items-center justify-between">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-60"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Aplicar em {ids.length} {ids.length > 1 ? 'itens' : 'item'}
          </button>
        </div>

        {toast && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

function FieldBlock({
  checked,
  onToggle,
  label,
  icon,
  children,
}: {
  checked: boolean;
  onToggle: (v: boolean) => void;
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border ${checked ? 'border-blue-300 bg-blue-50/30' : 'border-gray-200'} p-3`}>
      <label className="flex items-center gap-2 mb-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onToggle(e.target.checked)}
          className="w-4 h-4 accent-blue-600"
        />
        {icon}
        <span className="text-sm font-medium text-gray-800">{label}</span>
      </label>
      <div className={checked ? '' : 'opacity-50 pointer-events-none'}>{children}</div>
    </div>
  );
}
