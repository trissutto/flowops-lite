'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Plus, Pencil, Trash2, Store as StoreIcon, X } from 'lucide-react';

interface Store {
  id: string;
  code: string;
  name: string;
  cep?: string;
  city?: string;
  state?: string;
  whatsapp?: string;
  contactName?: string;
  active: boolean;
  priorityScore: number;
  tipo?: 'REDE' | 'FILIAL' | string | null;
}

const EMPTY: Partial<Store> = {
  code: '', name: '', cep: '', city: '', state: '', whatsapp: '', contactName: '',
  active: true, priorityScore: 50, tipo: 'REDE',
};

export default function LojasPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [editing, setEditing] = useState<Partial<Store> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const data = await api<Store[]>('/stores');
      setStores(data);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload: any = {
        code: editing!.code,
        name: editing!.name,
        cep: editing!.cep || undefined,
        city: editing!.city || undefined,
        state: editing!.state || undefined,
        whatsapp: (editing!.whatsapp || '').replace(/\D/g, '') || undefined,
        contactName: editing!.contactName || undefined,
        active: editing!.active ?? true,
        priorityScore: Number(editing!.priorityScore ?? 50),
        tipo: (editing!.tipo === 'FILIAL' ? 'FILIAL' : 'REDE'),
      };
      if ((editing as any).id) {
        await api(`/stores/${(editing as any).id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await api('/stores', { method: 'POST', body: JSON.stringify(payload) });
      }
      setEditing(null);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function desativar(id: string) {
    if (!confirm('Desativar esta loja? Ela nao sera mais considerada no roteamento.')) return;
    await api(`/stores/${id}`, { method: 'DELETE' });
    await load();
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <StoreIcon className="w-6 h-6" /> Lojas ({stores.length})
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Configure lojas, WhatsApp de contato e prioridade no roteamento.
          </p>
        </div>
        <button
          onClick={() => setEditing(EMPTY)}
          className="bg-brand text-white px-4 py-2 rounded hover:bg-brand-dark flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> Nova loja
        </button>
      </div>

      {error && <div className="bg-red-50 text-red-700 p-3 rounded mb-4 text-sm">{error}</div>}

      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-3 text-left">Código</th>
              <th className="p-3 text-left">Nome</th>
              <th className="p-3 text-center">Tipo</th>
              <th className="p-3 text-left">Cidade/UF</th>
              <th className="p-3 text-left">CEP</th>
              <th className="p-3 text-left">WhatsApp</th>
              <th className="p-3 text-right">Prioridade</th>
              <th className="p-3 text-center">Ativa</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {stores.length === 0 && (
              <tr><td colSpan={9} className="p-8 text-center text-slate-400">Nenhuma loja cadastrada.</td></tr>
            )}
            {stores.map((s) => {
              const tipo = (s.tipo || 'REDE') as 'REDE' | 'FILIAL';
              return (
              <tr key={s.id} className={`border-t hover:bg-slate-50 ${!s.active ? 'opacity-40' : ''}`}>
                <td className="p-3 font-mono">{s.code}</td>
                <td className="p-3 font-medium">{s.name}</td>
                <td className="p-3 text-center">
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                      tipo === 'FILIAL'
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-blue-100 text-blue-800'
                    }`}
                  >
                    {tipo}
                  </span>
                </td>
                <td className="p-3">{s.city || '—'} / {s.state || '—'}</td>
                <td className="p-3">{s.cep || '—'}</td>
                <td className="p-3 font-mono text-xs">{s.whatsapp || '—'}</td>
                <td className="p-3 text-right">
                  <span className="inline-block w-10 bg-slate-100 rounded overflow-hidden">
                    <span
                      className="block bg-brand h-5 text-xs text-white font-bold text-center"
                      style={{ width: `${s.priorityScore}%`, minWidth: '18px' }}
                    >{s.priorityScore}</span>
                  </span>
                </td>
                <td className="p-3 text-center">{s.active ? '✓' : '—'}</td>
                <td className="p-3 text-right whitespace-nowrap">
                  <button onClick={() => setEditing(s)} className="text-slate-600 hover:text-brand p-1" title="Editar">
                    <Pencil className="w-4 h-4" />
                  </button>
                  {s.active && (
                    <button onClick={() => desativar(s.id)} className="text-slate-600 hover:text-red-600 p-1 ml-1" title="Desativar">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Modal editar/criar */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-bold text-lg">
                {(editing as any).id ? 'Editar loja' : 'Nova loja'}
              </h3>
              <button onClick={() => setEditing(null)}><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="p-5 space-y-3 text-sm max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium mb-1">Código *</label>
                  <input
                    className="w-full border rounded px-3 py-2"
                    placeholder="LJ01"
                    value={editing.code ?? ''}
                    onChange={(e) => setEditing({ ...editing, code: e.target.value })}
                  />
                  <p className="text-xs text-slate-500 mt-1">Deve bater com o código no ERP</p>
                </div>
                <div>
                  <label className="block font-medium mb-1">Nome *</label>
                  <input
                    className="w-full border rounded px-3 py-2"
                    placeholder="Loja Matriz"
                    value={editing.name ?? ''}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  />
                </div>
              </div>

              {/* Tipo REDE / FILIAL — define se transferência gera obrigação financeira */}
              <div>
                <label className="block font-medium mb-1">Tipo da loja *</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing({ ...editing, tipo: 'REDE' })}
                    className={`px-3 py-2 rounded border-2 text-sm font-bold transition-colors ${
                      (editing.tipo || 'REDE') === 'REDE'
                        ? 'border-blue-600 bg-blue-50 text-blue-800'
                        : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    REDE (própria)
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing({ ...editing, tipo: 'FILIAL' })}
                    className={`px-3 py-2 rounded border-2 text-sm font-bold transition-colors ${
                      editing.tipo === 'FILIAL'
                        ? 'border-amber-600 bg-amber-50 text-amber-800'
                        : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    FILIAL (franquia)
                  </button>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Transferências REDE↔FILIAL geram obrigação financeira automática (preço Giga ÷ 2,5).
                  REDE↔REDE e FILIAL↔FILIAL não cobram.
                </p>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block font-medium mb-1">Cidade</label>
                  <input
                    className="w-full border rounded px-3 py-2"
                    value={editing.city ?? ''}
                    onChange={(e) => setEditing({ ...editing, city: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">UF</label>
                  <input
                    maxLength={2} className="w-full border rounded px-3 py-2 uppercase"
                    value={editing.state ?? ''}
                    onChange={(e) => setEditing({ ...editing, state: e.target.value.toUpperCase() })}
                  />
                </div>
              </div>

              <div>
                <label className="block font-medium mb-1">CEP</label>
                <input
                  className="w-full border rounded px-3 py-2"
                  placeholder="01001-000"
                  value={editing.cep ?? ''}
                  onChange={(e) => setEditing({ ...editing, cep: e.target.value })}
                />
              </div>

              <div>
                <label className="block font-medium mb-1">WhatsApp da loja</label>
                <input
                  className="w-full border rounded px-3 py-2"
                  placeholder="+55 11 99999-9999"
                  value={editing.whatsapp ?? ''}
                  onChange={(e) => setEditing({ ...editing, whatsapp: e.target.value })}
                />
                <p className="text-xs text-slate-500 mt-1">Será usado pra disparar o pedido. DDD incluído.</p>
              </div>

              <div>
                <label className="block font-medium mb-1">Nome do contato (opcional)</label>
                <input
                  className="w-full border rounded px-3 py-2"
                  placeholder="Nome do gerente / responsável"
                  value={editing.contactName ?? ''}
                  onChange={(e) => setEditing({ ...editing, contactName: e.target.value })}
                />
              </div>

              <div>
                <label className="block font-medium mb-1">Prioridade ({editing.priorityScore ?? 50}/100)</label>
                <input
                  type="range" min="0" max="100"
                  className="w-full"
                  value={editing.priorityScore ?? 50}
                  onChange={(e) => setEditing({ ...editing, priorityScore: Number(e.target.value) })}
                />
                <p className="text-xs text-slate-500 mt-1">
                  Quanto maior, mais preferida pelo roteamento quando houver empate.
                </p>
              </div>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={editing.active ?? true}
                  onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                />
                Loja ativa (participa do roteamento)
              </label>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t bg-slate-50">
              <button onClick={() => setEditing(null)} className="px-4 py-2 border rounded hover:bg-white">
                Cancelar
              </button>
              <button
                onClick={save}
                disabled={saving || !editing.code || !editing.name}
                className="px-4 py-2 bg-brand text-white rounded hover:bg-brand-dark disabled:opacity-50"
              >
                {saving ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
