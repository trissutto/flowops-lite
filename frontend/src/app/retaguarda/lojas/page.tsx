'use client';

/**
 * /retaguarda/lojas
 *
 * Cadastro/classificação rápida de lojas. Foco principal: marcar cada loja
 * como REDE (própria) ou FILIAL (franquia). Essa classificação determina
 * se uma transferência entre 2 lojas vira obrigação financeira automática
 * (REDE↔FILIAL gera cobrança, REDE↔REDE / FILIAL↔FILIAL não).
 *
 * Outras edições (nome, código, WhatsApp, etc.) ficam em modal de edição
 * pra não poluir a tabela principal.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, Building2, Store as StoreIcon, Loader2, Check, AlertTriangle, Edit2, X } from 'lucide-react';
import { api } from '@/lib/api';

type Store = {
  id: string;
  code: string;
  name: string;
  city?: string | null;
  state?: string | null;
  active: boolean;
  tipo?: 'REDE' | 'FILIAL' | string | null;
};

export default function LojasPage() {
  const [items, setItems] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Store | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const arr = await api<Store[]>('/stores');
      setItems(arr.sort((a, b) => a.code.localeCompare(b.code)));
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar lojas');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const setTipo = async (store: Store, newTipo: 'REDE' | 'FILIAL') => {
    if ((store.tipo || 'REDE') === newTipo) return;
    setSavingId(store.id);
    try {
      await api(`/stores/${store.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ tipo: newTipo }),
      });
      setItems((prev) => prev.map((s) => (s.id === store.id ? { ...s, tipo: newTipo } : s)));
    } catch (e: any) {
      alert(`Erro ao salvar: ${e?.message || e}`);
    } finally {
      setSavingId(null);
    }
  };

  const totalRede = items.filter((s) => (s.tipo || 'REDE') === 'REDE').length;
  const totalFilial = items.filter((s) => s.tipo === 'FILIAL').length;
  const totalAtivas = items.filter((s) => s.active).length;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/retaguarda"
          className="p-2 rounded-lg hover:bg-slate-100 text-slate-500"
          title="Voltar"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white flex items-center justify-center shadow">
          <Building2 className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900">Lojas (REDE / FRANQUIA)</h1>
          <p className="text-sm text-slate-500">
            Classifica cada loja. Transferências entre <b>REDE↔FRANQUIA</b> geram obrigação
            financeira automática (preço Giga ÷ 2,5). REDE↔REDE não cobra.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 disabled:opacity-50"
          title="Recarregar"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiBox label="Total de lojas" value={items.length} color="slate" />
        <KpiBox label="Ativas" value={totalAtivas} color="emerald" />
        <KpiBox label="REDE" value={totalRede} color="blue" />
        <KpiBox label="FRANQUIAS" value={totalFilial} color="amber" />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
          <div className="text-sm">{error}</div>
        </div>
      )}

      {/* Tabela de lojas */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
            Carregando lojas...
          </div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center text-slate-400">Nenhuma loja cadastrada.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {items.map((store) => {
              const tipo = (store.tipo || 'REDE') as 'REDE' | 'FILIAL';
              const isSaving = savingId === store.id;
              return (
                <div
                  key={store.id}
                  className={`flex items-center gap-3 px-4 py-3 hover:bg-slate-50/50 transition ${
                    !store.active ? 'opacity-50' : ''
                  }`}
                >
                  <StoreIcon className={`w-5 h-5 ${tipo === 'FILIAL' ? 'text-amber-600' : 'text-blue-600'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
                        {store.code}
                      </span>
                      <span className="font-semibold text-slate-800 truncate">{store.name}</span>
                      {!store.active && (
                        <span className="text-xs bg-slate-200 text-slate-600 px-2 py-0.5 rounded">inativa</span>
                      )}
                    </div>
                    {(store.city || store.state) && (
                      <div className="text-xs text-slate-500 mt-0.5">
                        {[store.city, store.state].filter(Boolean).join(' / ')}
                      </div>
                    )}
                  </div>

                  {/* Toggle REDE / FILIAL */}
                  <div className="flex items-center bg-slate-100 rounded-lg p-1 gap-1">
                    <button
                      type="button"
                      onClick={() => setTipo(store, 'REDE')}
                      disabled={isSaving}
                      className={`px-3 py-1.5 rounded text-xs font-bold transition ${
                        tipo === 'REDE'
                          ? 'bg-blue-600 text-white shadow'
                          : 'text-slate-600 hover:bg-white'
                      } disabled:opacity-50`}
                    >
                      REDE
                    </button>
                    <button
                      type="button"
                      onClick={() => setTipo(store, 'FILIAL')}
                      disabled={isSaving}
                      className={`px-3 py-1.5 rounded text-xs font-bold transition ${
                        tipo === 'FILIAL'
                          ? 'bg-amber-600 text-white shadow'
                          : 'text-slate-600 hover:bg-white'
                      } disabled:opacity-50`}
                    >
                      FRANQUIA
                    </button>
                  </div>

                  {isSaving && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}

                  <button
                    type="button"
                    onClick={() => setEditing(store)}
                    className="p-2 rounded-lg hover:bg-slate-100 text-slate-400"
                    title="Editar dados"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Hint */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-900 flex gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <div>
          <b>Importante:</b> a classificação afeta TODAS as transferências de realinhamento criadas
          a partir de agora. Transferências antigas (já feitas antes da classificação) não são
          retroativas. Cheque a tela <Link href="/retaguarda/financeiro/transferencias" className="underline font-bold">/financeiro/transferencias</Link> pra acompanhar as obrigações criadas.
        </div>
      </div>

      {/* Modal de edição completa */}
      {editing && (
        <EditModal
          store={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setItems((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function KpiBox({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: 'slate' | 'emerald' | 'blue' | 'amber';
}) {
  const palette: Record<string, string> = {
    slate: 'bg-slate-50 border-slate-200 text-slate-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    blue: 'bg-blue-50 border-blue-200 text-blue-800',
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
  };
  return (
    <div className={`rounded-lg border p-3 ${palette[color]}`}>
      <div className="text-xs uppercase font-semibold opacity-80">{label}</div>
      <div className="text-2xl font-bold tabular-nums mt-1">{value}</div>
    </div>
  );
}

function EditModal({
  store,
  onClose,
  onSaved,
}: {
  store: Store;
  onClose: () => void;
  onSaved: (s: Store) => void;
}) {
  const [name, setName] = useState(store.name);
  const [city, setCity] = useState(store.city || '');
  const [state, setState] = useState(store.state || '');
  const [active, setActive] = useState(store.active);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setErr(null);
    try {
      const updated = await api<Store>(`/stores/${store.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim() || undefined,
          city: city.trim(),
          state: state.trim().toUpperCase(),
          active,
        }),
      });
      onSaved(updated);
    } catch (e: any) {
      setErr(e?.message || 'Erro ao salvar');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-900">Editar loja {store.code}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="space-y-3">
          <Field label="Nome">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="Cidade">
                <input
                  type="text"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                />
              </Field>
            </div>
            <Field label="UF">
              <input
                type="text"
                value={state}
                maxLength={2}
                onChange={(e) => setState(e.target.value.toUpperCase())}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm uppercase"
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="rounded"
            />
            Loja ativa
          </label>
        </div>
        {err && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{err}</div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="px-4 py-2 text-sm rounded-lg bg-violet-600 hover:bg-violet-700 text-white font-bold flex items-center gap-1.5 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-700 mb-1">{label}</label>
      {children}
    </div>
  );
}
