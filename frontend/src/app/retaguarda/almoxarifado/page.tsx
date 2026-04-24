'use client';

/**
 * /retaguarda/almoxarifado
 *
 * Matriz cadastra e gerencia os itens que as filiais podem pedir:
 * saquinhos, durex, bobina, etiquetas, etc.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Package2, Plus, Search, Edit3, Power, PowerOff, X, Save, RefreshCw,
  Warehouse, ShoppingCart,
} from 'lucide-react';
import { api } from '@/lib/api';

// Origem de compra/separação do material.
// MATRIZ         → sai do estoque interno da matriz (separação normal)
// MERCADO_LIVRE  → matriz precisa comprar online sob demanda (lead time)
type SupplyOrigin = 'MATRIZ' | 'MERCADO_LIVRE';

type SupplyItem = {
  id: string;
  sku: string | null;
  name: string;
  category: string | null;
  unit: string;
  description: string | null;
  imageUrl: string | null;
  active: boolean;
  minQty: number | null;
  origin: SupplyOrigin;
};

/**
 * Badge visual pra origem do item — usado aqui na tabela.
 * Next App Router não deixa exportar componentes arbitrários de um page.tsx,
 * então mantemos este local. A tela /retaguarda/materiais tem sua própria
 * cópia idêntica (mesma aparência).
 * MATRIZ       → indigo (estoque interno, fluxo normal)
 * MERCADO_LIVRE → amber (compra sob demanda, lead time extra)
 */
function OriginBadge({ origin }: { origin: SupplyOrigin }) {
  if (origin === 'MERCADO_LIVRE') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wide bg-amber-100 text-amber-900 border border-amber-300 px-2 py-0.5 rounded">
        <ShoppingCart className="w-3 h-3" />
        Mercado Livre
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wide bg-indigo-100 text-indigo-900 border border-indigo-300 px-2 py-0.5 rounded">
      <Warehouse className="w-3 h-3" />
      Matriz
    </span>
  );
}

export default function AlmoxarifadoPage() {
  const [items, setItems] = useState<SupplyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<SupplyItem | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<SupplyItem[]>('/supplies/items');
      setItems(Array.isArray(data) ? data : []);
    } catch (err: any) {
      const msg = String(err?.message || err);
      setError(msg.includes('403') ? 'Acesso restrito à matriz.' : 'Falha ao carregar itens.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (!showInactive && !i.active) return false;
      if (!q) return true;
      return (
        i.name.toLowerCase().includes(q) ||
        (i.category || '').toLowerCase().includes(q) ||
        (i.sku || '').toLowerCase().includes(q)
      );
    });
  }, [items, search, showInactive]);

  const grouped = useMemo(() => {
    const map = new Map<string, SupplyItem[]>();
    filtered.forEach((it) => {
      const cat = it.category || 'Outros';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(it);
    });
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const toggle = async (item: SupplyItem) => {
    try {
      if (item.active) {
        // Soft delete
        await api(`/supplies/items/${item.id}`, { method: 'DELETE' });
      } else {
        // Reativa
        await api(`/supplies/items/${item.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ active: true }),
        });
      }
      await load();
    } catch (err: any) {
      alert('Falha: ' + (err?.message || err));
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Package2 className="w-6 h-6 text-brand" />
            Almoxarifado
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Catálogo de materiais que as filiais podem pedir (saquinho, durex, bobina…)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-sm flex items-center gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
          <button
            onClick={() => { setCreating(true); setEditing(null); }}
            className="px-4 py-2 rounded-lg bg-brand text-white font-bold hover:opacity-90 flex items-center gap-2 shadow"
          >
            <Plus className="w-4 h-4" />
            Novo item
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[250px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, categoria ou SKU…"
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 bg-white focus:border-brand focus:outline-none text-sm"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Mostrar inativos
        </label>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-3 text-sm">{error}</div>
      )}

      {loading && items.length === 0 ? (
        <div className="text-center py-10 text-slate-500 text-sm">Carregando…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <Package2 className="w-12 h-12 mx-auto text-slate-300 mb-3" />
          <p className="font-bold text-slate-700">
            {items.length === 0 ? 'Nenhum item cadastrado ainda' : 'Sem resultados'}
          </p>
          <p className="text-sm text-slate-500 mt-1">
            {items.length === 0 ? 'Clique em "Novo item" pra cadastrar o primeiro.' : 'Ajuste a busca ou mostre inativos.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(([cat, list]) => (
            <section key={cat} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <header className="px-4 py-2 bg-slate-50 border-b border-slate-200 text-sm font-bold uppercase tracking-wide text-slate-600 flex items-center justify-between">
                <span>{cat}</span>
                <span className="text-xs font-normal text-slate-400">{list.length} {list.length === 1 ? 'item' : 'itens'}</span>
              </header>
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="text-left px-4 py-2">Nome</th>
                    <th className="text-left px-4 py-2">SKU</th>
                    <th className="text-left px-4 py-2">Unid.</th>
                    <th className="text-left px-4 py-2">Origem</th>
                    <th className="text-left px-4 py-2">Status</th>
                    <th className="text-right px-4 py-2">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {list.map((it) => (
                    <tr key={it.id} className={it.active ? '' : 'opacity-60'}>
                      <td className="px-4 py-2.5">
                        <div className="font-semibold text-slate-900">{it.name}</div>
                        {it.description && (
                          <div className="text-xs text-slate-500 mt-0.5">{it.description}</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 font-mono text-xs">{it.sku || '—'}</td>
                      <td className="px-4 py-2.5 text-slate-700">{it.unit}</td>
                      <td className="px-4 py-2.5">
                        <OriginBadge origin={it.origin} />
                      </td>
                      <td className="px-4 py-2.5">
                        {it.active ? (
                          <span className="inline-flex items-center gap-1 text-xs font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
                            <Power className="w-3 h-3" /> Ativo
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-bold bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                            <PowerOff className="w-3 h-3" /> Inativo
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <button
                          onClick={() => { setEditing(it); setCreating(false); }}
                          className="p-1.5 text-slate-600 hover:bg-slate-100 rounded"
                          title="Editar"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => toggle(it)}
                          className={`p-1.5 rounded ${it.active ? 'text-red-600 hover:bg-red-50' : 'text-emerald-600 hover:bg-emerald-50'}`}
                          title={it.active ? 'Desativar' : 'Reativar'}
                        >
                          {it.active ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      )}

      {/* Modal criar/editar */}
      {(creating || editing) && (
        <ItemFormModal
          item={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function ItemFormModal({
  item, onClose, onSaved,
}: { item: SupplyItem | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(item?.name || '');
  const [sku, setSku] = useState(item?.sku || '');
  const [category, setCategory] = useState(item?.category || '');
  const [unit, setUnit] = useState(item?.unit || 'un');
  const [description, setDescription] = useState(item?.description || '');
  const [minQty, setMinQty] = useState<string>(item?.minQty?.toString() || '');
  const [active, setActive] = useState(item?.active !== false);
  const [origin, setOrigin] = useState<SupplyOrigin>(item?.origin || 'MATRIZ');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (saving) return;
    if (!name.trim() || name.trim().length < 2) {
      setError('Nome é obrigatório.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload: any = {
        name: name.trim(),
        sku: sku.trim() || null,
        category: category.trim() || null,
        unit: unit.trim() || 'un',
        description: description.trim() || null,
        active,
        minQty: minQty.trim() ? parseInt(minQty, 10) : null,
        origin,
      };
      if (item) {
        await api(`/supplies/items/${item.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await api('/supplies/items', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      onSaved();
    } catch (err: any) {
      setError('Falha ao salvar: ' + (err?.message || err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-slate-900/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">{item ? 'Editar item' : 'Novo item'}</h3>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <div>
          <label className="text-xs font-bold uppercase tracking-wide text-slate-600 block mb-1">
            Nome <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Saquinho 30x40 transparente"
            className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:border-brand focus:outline-none"
            autoFocus
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-600 block mb-1">
              Categoria
            </label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Embalagem"
              list="supply-categories"
              className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:border-brand focus:outline-none"
            />
            <datalist id="supply-categories">
              <option value="Embalagem" />
              <option value="Impressão" />
              <option value="Limpeza" />
              <option value="Escritório" />
              <option value="Identificação" />
              <option value="Ferramenta" />
            </datalist>
          </div>
          <div>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-600 block mb-1">
              Unidade
            </label>
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:border-brand focus:outline-none bg-white"
            >
              <option value="un">un (unidade)</option>
              <option value="pacote">pacote</option>
              <option value="rolo">rolo</option>
              <option value="caixa">caixa</option>
              <option value="m">metro</option>
              <option value="kg">kg</option>
              <option value="fardo">fardo</option>
              <option value="cento">cento</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-600 block mb-1">
              SKU / Código
            </label>
            <input
              type="text"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="Opcional"
              className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:border-brand focus:outline-none font-mono"
            />
          </div>
          <div>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-600 block mb-1">
              Estoque mínimo
            </label>
            <input
              type="number"
              min={0}
              value={minQty}
              onChange={(e) => setMinQty(e.target.value)}
              placeholder="Opcional"
              className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:border-brand focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label className="text-xs font-bold uppercase tracking-wide text-slate-600 block mb-1">
            Descrição
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Opcional. Ex: Para peças até tam 46"
            className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:border-brand focus:outline-none resize-none"
          />
        </div>

        {/* Origem — onde a matriz busca esse material. MATRIZ = estoque próprio,
            MERCADO_LIVRE = compra online sob demanda. Dois botões grandes pra
            fica óbvio no cadastro. */}
        <div>
          <label className="text-xs font-bold uppercase tracking-wide text-slate-600 block mb-1">
            Origem
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setOrigin('MATRIZ')}
              className={`flex items-center justify-center gap-2 p-3 rounded-lg border-2 text-sm font-bold transition ${
                origin === 'MATRIZ'
                  ? 'border-indigo-600 bg-indigo-50 text-indigo-800'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              }`}
            >
              <Warehouse className="w-4 h-4" />
              MATRIZ
            </button>
            <button
              type="button"
              onClick={() => setOrigin('MERCADO_LIVRE')}
              className={`flex items-center justify-center gap-2 p-3 rounded-lg border-2 text-sm font-bold transition ${
                origin === 'MERCADO_LIVRE'
                  ? 'border-amber-600 bg-amber-50 text-amber-800'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              }`}
            >
              <ShoppingCart className="w-4 h-4" />
              MERCADO LIVRE
            </button>
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {origin === 'MATRIZ'
              ? 'Sai do estoque da matriz — separa na hora.'
              : 'Matriz compra no ML sob demanda — tem lead time.'}
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span className="font-semibold text-slate-700">Item ativo</span>
          <span className="text-xs text-slate-500">(aparece no catálogo das filiais)</span>
        </label>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-2 text-xs">
            {error}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 rounded-lg border border-slate-200 text-slate-700 font-semibold hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="flex-[1.3] px-4 py-2.5 rounded-lg bg-brand text-white font-bold hover:opacity-90 disabled:bg-slate-300 flex items-center justify-center gap-2"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Salvando…' : item ? 'Salvar alterações' : 'Cadastrar'}
          </button>
        </div>
      </div>
    </div>
  );
}
