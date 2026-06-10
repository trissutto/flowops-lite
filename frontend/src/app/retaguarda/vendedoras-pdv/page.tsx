'use client';

/**
 * /retaguarda/vendedoras-pdv
 *
 * Whitelist de vendedoras ATIVAS no PDV por loja (PdvActiveSeller).
 * Fase 3 da migração — espelha funcionários do Wincred no PostgreSQL
 * pra ficar disponível mesmo depois do cut-over 30/06.
 *
 * Diferente de /retaguarda/vendedoras (que é cadastro Seller pra
 * atribuição de pedidos online), esta tela cuida da whitelist do PDV físico.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, Users, Loader2, CheckCircle2, Plus, X } from 'lucide-react';
import { api } from '@/lib/api';

const LOJAS_GERENCIADAS = ['INDAIATUBA', 'ITANHAEM', 'MOEMA', 'SOROCABA', 'SANTOS'];

type Seller = { id: string; storeCode: string; codigo: string; nome: string };
type WincredSeller = { codigo: string; nome: string; apelido: string | null; storeCode: string };

export default function VendedorasPdvPage() {
  const router = useRouter();
  const [selectedStore, setSelectedStore] = useState<string>(LOJAS_GERENCIADAS[0]);
  const [localSellers, setLocalSellers] = useState<Seller[]>([]);
  const [wincredSellers, setWincredSellers] = useState<WincredSeller[]>([]);
  const [loadingLocal, setLoadingLocal] = useState(false);
  const [loadingWincred, setLoadingWincred] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<any[] | null>(null);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) router.push('/login');
  }, [router]);

  const loadLocal = async () => {
    setLoadingLocal(true);
    try {
      const r = await api<Seller[]>(`/pdv/vendedoras-ativas?storeCode=${selectedStore}`);
      setLocalSellers(r || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingLocal(false);
    }
  };

  const loadWincred = async () => {
    setLoadingWincred(true);
    try {
      const r = await api<WincredSeller[]>(`/pdv/vendedoras-ativas/wincred?storeCode=${selectedStore}`);
      setWincredSellers(r || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingWincred(false);
    }
  };

  useEffect(() => {
    loadLocal();
    loadWincred();
    // eslint-disable-next-line
  }, [selectedStore]);

  const syncOne = async (storeCode: string) => {
    if (!confirm(`Sincronizar vendedoras de ${storeCode} do Wincred? Vai SUBSTITUIR a lista atual.`)) return;
    setSyncing(storeCode);
    setSyncResult(null);
    try {
      const r = await api<{ results: any[] }>('/pdv/vendedoras-ativas/sync-from-wincred', {
        method: 'POST',
        body: JSON.stringify({ storeCodes: [storeCode] }),
      });
      setSyncResult(r.results || []);
      if (selectedStore === storeCode) await loadLocal();
    } catch (e: any) {
      alert('Erro: ' + (e?.message || 'falhou'));
    } finally {
      setSyncing(null);
    }
  };

  const syncAll = async () => {
    if (!confirm('Sincronizar TODAS as 5 lojas? Vai SUBSTITUIR todas as listas.')) return;
    setSyncing('all');
    setSyncResult(null);
    try {
      const r = await api<{ results: any[] }>('/pdv/vendedoras-ativas/sync-from-wincred', {
        method: 'POST',
        body: JSON.stringify({ storeCodes: LOJAS_GERENCIADAS }),
      });
      setSyncResult(r.results || []);
      await loadLocal();
    } catch (e: any) {
      alert('Erro: ' + (e?.message || 'falhou'));
    } finally {
      setSyncing(null);
    }
  };

  const removeOne = async (id: string) => {
    if (!confirm('Remover essa vendedora da lista ativa?')) return;
    try {
      await api(`/pdv/vendedoras-ativas/${id}`, { method: 'DELETE' });
      await loadLocal();
    } catch (e: any) {
      alert('Erro: ' + e?.message);
    }
  };

  const addOne = async (w: WincredSeller) => {
    try {
      await api('/pdv/vendedoras-ativas', {
        method: 'POST',
        body: JSON.stringify({
          storeCode: selectedStore,
          codigo: w.codigo,
          nome: w.apelido || w.nome,
        }),
      });
      await loadLocal();
    } catch (e: any) {
      alert('Erro: ' + e?.message);
    }
  };

  const activeCodigos = new Set(localSellers.map((s) => s.codigo));

  return (
    <div className="min-h-screen bg-slate-50 pb-12">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="p-2 rounded hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="font-bold text-lg flex items-center gap-2">
              <Users className="w-5 h-5" /> Vendedoras Ativas no PDV
            </h1>
            <p className="text-xs text-slate-500">
              Fase 3 — espelho dos funcionários do Wincred no PostgreSQL
            </p>
          </div>
          <button
            onClick={syncAll}
            disabled={syncing !== null}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded text-sm flex items-center gap-2 disabled:opacity-50"
          >
            {syncing === 'all'
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Sincronizando...</>
              : <><RefreshCw className="w-4 h-4" /> Sync TODAS</>}
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {LOJAS_GERENCIADAS.map((sc) => (
            <button
              key={sc}
              onClick={() => setSelectedStore(sc)}
              className={`rounded-xl border-2 p-3 transition text-left ${
                selectedStore === sc
                  ? 'bg-blue-50 border-blue-400'
                  : 'bg-white border-slate-200 hover:border-blue-300'
              }`}
            >
              <div className="font-bold">{sc}</div>
              <button
                onClick={(e) => { e.stopPropagation(); syncOne(sc); }}
                disabled={syncing !== null}
                className="mt-2 w-full px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-[10px] font-bold disabled:opacity-50"
              >
                {syncing === sc
                  ? <Loader2 className="w-3 h-3 inline animate-spin" />
                  : '🔄 Sync esta'}
              </button>
            </button>
          ))}
        </div>

        {syncResult && (
          <div className="bg-emerald-50 border border-emerald-300 rounded-xl p-3">
            <div className="font-bold text-emerald-900 mb-2 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> Sync concluído
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
              {syncResult.map((r) => (
                <div key={r.storeCode} className={`p-2 rounded border ${
                  r.error ? 'bg-rose-50 border-rose-300' : 'bg-white border-emerald-200'
                }`}>
                  <div className="font-bold">{r.storeCode}</div>
                  {r.error ? (
                    <div className="text-rose-700 text-[10px]">{r.error}</div>
                  ) : (
                    <div>{r.total} vendedoras</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-4">
          <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200">
              <div className="font-bold">
                ✅ Ativas no flowops — {selectedStore}
                <span className="text-xs text-slate-500 ml-2">({localSellers.length})</span>
              </div>
            </div>
            {loadingLocal ? (
              <div className="p-6 text-center text-slate-400">
                <Loader2 className="w-5 h-5 animate-spin mx-auto" />
              </div>
            ) : localSellers.length === 0 ? (
              <div className="p-6 text-center text-slate-400 text-sm italic">
                Nenhuma vendedora ativa. Sincronize do Wincred ou adicione manualmente.
              </div>
            ) : (
              <div className="max-h-[500px] overflow-y-auto divide-y divide-slate-100">
                {localSellers.map((s) => (
                  <div key={s.id} className="px-3 py-2 hover:bg-slate-50 flex items-center gap-2">
                    <span className="text-xs font-mono text-slate-400 w-12">{s.codigo}</span>
                    <span className="flex-1 text-sm font-medium">{s.nome}</span>
                    <button
                      onClick={() => removeOne(s.id)}
                      className="p-1 text-rose-500 hover:bg-rose-50 rounded"
                      title="Remover"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <div className="font-bold">
                📋 Funcionários Wincred — {selectedStore}
                <span className="text-xs text-slate-500 ml-2">({wincredSellers.length})</span>
              </div>
              <button
                onClick={loadWincred}
                disabled={loadingWincred}
                className="p-1 hover:bg-slate-100 rounded"
              >
                <RefreshCw className={`w-4 h-4 ${loadingWincred ? 'animate-spin' : ''}`} />
              </button>
            </div>
            {loadingWincred ? (
              <div className="p-6 text-center text-slate-400">
                <Loader2 className="w-5 h-5 animate-spin mx-auto" />
              </div>
            ) : wincredSellers.length === 0 ? (
              <div className="p-6 text-center text-slate-400 text-sm italic">
                Wincred não retornou funcionários pra esta loja.
              </div>
            ) : (
              <div className="max-h-[500px] overflow-y-auto divide-y divide-slate-100">
                {wincredSellers.map((w) => {
                  const isActive = activeCodigos.has(w.codigo);
                  return (
                    <div key={w.codigo} className={`px-3 py-2 flex items-center gap-2 ${
                      isActive ? 'bg-emerald-50/30' : 'hover:bg-slate-50'
                    }`}>
                      <span className="text-xs font-mono text-slate-400 w-12">{w.codigo}</span>
                      <div className="flex-1">
                        <div className="text-sm font-medium">{w.apelido || w.nome}</div>
                        {w.apelido && w.apelido !== w.nome && (
                          <div className="text-[10px] text-slate-400">{w.nome}</div>
                        )}
                      </div>
                      {isActive ? (
                        <span className="text-[10px] text-emerald-700 font-bold">✓ ATIVA</span>
                      ) : (
                        <button
                          onClick={() => addOne(w)}
                          className="p-1 text-blue-500 hover:bg-blue-50 rounded"
                          title="Adicionar como ativa"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900 space-y-1">
          <div className="font-bold">Como funciona</div>
          <div>• <strong>Coluna esquerda</strong>: vendedoras que aparecem no PDV pra serem selecionadas.</div>
          <div>• <strong>Coluna direita</strong>: funcionários cadastrados no Wincred (fonte original).</div>
          <div>• <strong>Sync esta</strong>: substitui a lista local pela lista atual do Wincred (perde adições manuais).</div>
          <div>• <strong>+</strong>: adiciona uma vendedora individual sem fazer sync completo.</div>
          <div>• <strong>X</strong>: remove apenas localmente, sem afetar o Wincred.</div>
        </div>
      </main>
    </div>
  );
}
