'use client';

/**
 * /retaguarda/vendedoras-ativas
 *
 * Admin marca quais vendedoras (do Wincred) ficam ATIVAS no PDV de cada loja.
 *
 * Sem essa whitelist, o PDV abre o modal Vendedora puxando todos os 80+
 * funcionários da tabela `funcionarios`. Aqui o admin selecionaa só as 3-5
 * que realmente atendem em cada loja.
 *
 * Fluxo:
 *  1. Escolhe a loja
 *  2. Vê lista atual de vendedoras ativas (esquerda)
 *  3. Busca em funcionarios do Wincred (direita)
 *  4. Click pra adicionar/remover
 *  5. Click "Salvar lista" → PUT /pdv/vendedoras-ativas/bulk
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, Search, Trash2, Plus, Save, Check, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

type Store = { code: string; name: string };
type ActiveSeller = { id: string; storeCode: string; codigo: string; nome: string };
type FuncResult = { codigo: string; nome: string; loja?: string };

export default function VendedorasAtivasPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeCode, setStoreCode] = useState('');
  const [actives, setActives] = useState<ActiveSeller[]>([]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<FuncResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [pending, setPending] = useState<FuncResult[]>([]); // adições não salvas

  // Carrega lojas ativas
  useEffect(() => {
    api<Store[]>('/stores')
      .then((s) => {
        const list = (s || []).filter((st: any) => st.active !== false);
        setStores(list);
        if (list.length > 0) setStoreCode(list[0].code);
      })
      .catch(() => setStores([]));
  }, []);

  // Carrega vendedoras ativas da loja selecionada
  const reload = useCallback(async () => {
    if (!storeCode) return;
    setLoading(true);
    try {
      const r = await api<ActiveSeller[]>(`/pdv/vendedoras-ativas?storeCode=${encodeURIComponent(storeCode)}`);
      setActives(r || []);
      setPending([]);
    } catch {
      setActives([]);
    } finally {
      setLoading(false);
    }
  }, [storeCode]);
  useEffect(() => { reload(); }, [reload]);

  // Busca funcionários no Wincred
  useEffect(() => {
    if (!storeCode) return;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api<{ results: FuncResult[] }>(
          `/pdv/funcionarios-search?q=${encodeURIComponent(search)}&limit=50&loja=${encodeURIComponent(storeCode)}`,
        );
        setResults(r.results || []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [search, storeCode]);

  // Marca uma funcionária como ativa (vai pra lista de pending)
  const adicionar = (f: FuncResult) => {
    if (actives.find((a) => a.codigo === f.codigo) || pending.find((p) => p.codigo === f.codigo)) {
      return; // já está
    }
    setPending((p) => [...p, f]);
  };

  // Remove uma já salva (marca pra remover) ou pending
  const remover = (codigo: string) => {
    setActives((a) => a.filter((x) => x.codigo !== codigo));
    setPending((p) => p.filter((x) => x.codigo !== codigo));
  };

  const salvar = async () => {
    if (!storeCode) return;
    setSaving(true);
    try {
      const merged = [
        ...actives.map((a) => ({ codigo: a.codigo, nome: a.nome })),
        ...pending.map((p) => ({ codigo: p.codigo, nome: p.nome })),
      ];
      await api(`/pdv/vendedoras-ativas/bulk`, {
        method: 'PUT',
        body: JSON.stringify({ storeCode, sellers: merged }),
      });
      setSavedAt(new Date());
      await reload();
    } catch (e: any) {
      alert(`Falha ao salvar: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  const totalAtivas = actives.length + pending.length;

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-6">
      <div className="max-w-6xl mx-auto">
        <Link
          href="/retaguarda"
          className="inline-flex items-center gap-2 text-rose-700 hover:text-rose-900 mb-4"
        >
          <ArrowLeft size={18} /> Voltar pra retaguarda
        </Link>

        <h1 className="text-2xl md:text-3xl font-bold text-rose-900 mb-2">
          Vendedoras ativas no PDV
        </h1>
        <p className="text-sm text-slate-600 mb-6">
          Marca quais vendedoras aparecem no modal "Quem está atendendo?" do PDV.
          Quem não estiver na lista não aparece no PDV — evita confusão e clique errado.
        </p>

        {/* Seletor de loja */}
        <div className="bg-white rounded-2xl shadow-sm p-4 mb-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <label className="text-sm font-semibold text-slate-700 shrink-0">Loja:</label>
          <select
            value={storeCode}
            onChange={(e) => setStoreCode(e.target.value)}
            className="flex-1 px-3 py-2 border-2 border-slate-200 rounded-lg font-bold text-slate-800 focus:border-rose-400 focus:outline-none"
          >
            {stores.map((s) => (
              <option key={s.code} value={s.code}>
                {s.code} — {s.name}
              </option>
            ))}
          </select>
          <div className="text-sm text-slate-500 shrink-0">
            <strong>{totalAtivas}</strong> vendedora{totalAtivas === 1 ? '' : 's'} ativa{totalAtivas === 1 ? '' : 's'}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* COLUNA ESQUERDA — Ativas */}
          <div className="bg-white rounded-2xl shadow-sm p-4">
            <h2 className="font-bold text-emerald-800 mb-3 flex items-center gap-2">
              <Check size={18} /> Ativas no PDV
              {pending.length > 0 && (
                <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-bold">
                  +{pending.length} pendente
                </span>
              )}
            </h2>
            {loading ? (
              <div className="text-slate-500 text-sm flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
              </div>
            ) : totalAtivas === 0 ? (
              <div className="text-slate-500 text-sm italic py-4 text-center">
                Nenhuma vendedora ativa nessa loja.
                <br />
                Adiciona da lista da direita →
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[480px] overflow-y-auto">
                {[...actives, ...pending].map((s) => {
                  const isPending = !!pending.find((p) => p.codigo === s.codigo);
                  return (
                    <div
                      key={s.codigo}
                      className={`flex items-center justify-between p-2.5 rounded-lg border-2 ${
                        isPending
                          ? 'bg-amber-50 border-amber-300'
                          : 'bg-emerald-50 border-emerald-200'
                      }`}
                    >
                      <div>
                        <div className="font-bold text-slate-800 text-sm">{s.nome}</div>
                        <div className="text-[10px] text-slate-500 font-mono">cod {s.codigo}</div>
                      </div>
                      <button
                        onClick={() => remover(s.codigo)}
                        className="p-1.5 text-rose-600 hover:bg-rose-100 rounded transition"
                        title="Remover"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Botão Salvar */}
            <button
              onClick={salvar}
              disabled={saving}
              className="mt-4 w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
              Salvar lista
            </button>
            {savedAt && (
              <div className="text-[11px] text-emerald-700 mt-1 text-center">
                ✓ Salvo às {savedAt.toLocaleTimeString('pt-BR')}
              </div>
            )}
          </div>

          {/* COLUNA DIREITA — Buscar e adicionar */}
          <div className="bg-white rounded-2xl shadow-sm p-4">
            <h2 className="font-bold text-slate-800 mb-3 flex items-center gap-2">
              <Search size={18} /> Buscar funcionária
            </h2>
            <input
              type="text"
              placeholder="Digita o nome da vendedora…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-3 py-2 border-2 border-slate-200 rounded-lg focus:border-rose-400 focus:outline-none mb-3"
            />

            {searching ? (
              <div className="text-slate-500 text-sm flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Buscando…
              </div>
            ) : results.length === 0 ? (
              <div className="text-slate-500 text-sm italic py-4 text-center">
                Nenhuma funcionária encontrada
              </div>
            ) : (
              <div className="space-y-1 max-h-[480px] overflow-y-auto">
                {results.map((f) => {
                  const jaAtiva =
                    !!actives.find((a) => a.codigo === f.codigo) ||
                    !!pending.find((p) => p.codigo === f.codigo);
                  return (
                    <button
                      key={f.codigo}
                      onClick={() => adicionar(f)}
                      disabled={jaAtiva}
                      className={`w-full text-left flex items-center justify-between p-2.5 rounded-lg border-2 transition ${
                        jaAtiva
                          ? 'bg-slate-100 border-slate-200 cursor-not-allowed opacity-60'
                          : 'bg-white border-slate-200 hover:border-emerald-400 hover:bg-emerald-50'
                      }`}
                    >
                      <div>
                        <div className="font-bold text-slate-800 text-sm">{f.nome}</div>
                        <div className="text-[10px] text-slate-500 font-mono">cod {f.codigo}</div>
                      </div>
                      {jaAtiva ? (
                        <Check size={18} className="text-emerald-600" />
                      ) : (
                        <Plus size={18} className="text-slate-400" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
