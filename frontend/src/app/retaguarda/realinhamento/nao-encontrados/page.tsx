'use client';

/**
 * /retaguarda/realinhamento/nao-encontrados
 *
 * Tela admin de revisão de itens que a loja origem reportou como
 * "não encontrados" durante a separação. Permite:
 *
 *   1. Cancelar definitivamente — item some, sem retentativa
 *   2. Devolver pra fila pendente — loja tenta de novo
 *   3. Trocar loja origem — outra loja com estoque assume
 *
 * Visualmente: cards agrupados por REF, com motivos visíveis e ações
 * em destaque. Lista ordenada do mais recente pra cima.
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  ArrowLeft, AlertTriangle, RefreshCw, X, Undo2, Shuffle,
  Loader2, Package, Store, Clock,
} from 'lucide-react';

type NotFoundItem = {
  id: string;
  refCode: string;
  descricao: string | null;
  cor: string | null;
  tamanho: string | null;
  qtyOrigem: number;
  lojaOrigemCode: string;
  lojaOrigemName: string;
  lojaDestinoCode: string;
  lojaDestinoName: string;
  solicitanteNome: string;
  notFoundAt: string | null;
  notFoundNote: string | null;
  createdAt: string | null;
};

type Store = { code: string; name: string };

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export default function NaoEncontradosPage() {
  const [items, setItems] = useState<NotFoundItem[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, st] = await Promise.all([
        api<NotFoundItem[]>('/realignment/not-found'),
        api<Store[]>('/stores').catch(() => []),
      ]);
      setItems(Array.isArray(data) ? data : []);
      setStores(Array.isArray(st) ? st : []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function cancelar(item: NotFoundItem) {
    if (!confirm(`Cancelar definitivamente ${item.refCode} ${item.cor || ''}/${item.tamanho || ''}?\n\nEsta peça não vai mais aparecer pra ninguém.`)) return;
    setBusyId(item.id);
    try {
      await api(`/realignment/${item.id}/cancel-not-found`, { method: 'PATCH' });
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (e: any) {
      alert(`Erro: ${e?.message || e}`);
    } finally {
      setBusyId(null);
    }
  }

  async function devolverParaFila(item: NotFoundItem) {
    if (!confirm(`Devolver ${item.refCode} ${item.cor || ''}/${item.tamanho || ''} pra fila de ${item.lojaOrigemName}?\n\nEla vai aparecer de novo na separação.`)) return;
    setBusyId(item.id);
    try {
      await api(`/realignment/${item.id}/restore-not-found`, { method: 'PATCH' });
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (e: any) {
      alert(`Erro: ${e?.message || e}`);
    } finally {
      setBusyId(null);
    }
  }

  async function trocarLoja(item: NotFoundItem) {
    const opcoes = stores
      .filter((s) => s.code !== item.lojaOrigemCode && s.code !== item.lojaDestinoCode)
      .map((s) => `${s.code} - ${s.name}`)
      .join('\n');
    const newCode = window.prompt(
      `Trocar origem de ${item.refCode} ${item.cor || ''}/${item.tamanho || ''}\n\n` +
        `Atual: ${item.lojaOrigemCode} - ${item.lojaOrigemName}\n` +
        `Destino: ${item.lojaDestinoCode} - ${item.lojaDestinoName}\n\n` +
        `Lojas disponíveis:\n${opcoes}\n\n` +
        `Digite o código da nova loja origem:`,
      '',
    );
    if (!newCode) return;
    const newCodeClean = newCode.trim();
    const newStore = stores.find((s) => s.code === newCodeClean);
    if (!newStore) {
      alert(`Loja "${newCodeClean}" não encontrada.`);
      return;
    }
    if (newCodeClean === item.lojaDestinoCode) {
      alert('Origem não pode ser a mesma loja destino.');
      return;
    }
    setBusyId(item.id);
    try {
      await api(`/realignment/${item.id}/swap-origin`, {
        method: 'PATCH',
        body: JSON.stringify({ newOriginCode: newCodeClean, newOriginName: newStore.name }),
      });
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (e: any) {
      alert(`Erro: ${e?.message || e}`);
    } finally {
      setBusyId(null);
    }
  }

  // Agrupa por loja origem (visualização melhor)
  const byOrigem = new Map<string, NotFoundItem[]>();
  for (const it of items) {
    const k = `${it.lojaOrigemCode}|${it.lojaOrigemName}`;
    if (!byOrigem.has(k)) byOrigem.set(k, []);
    byOrigem.get(k)!.push(it);
  }

  return (
    <div className="min-h-screen bg-rose-50 p-4">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-3 mb-4">
          <Link
            href="/retaguarda/realinhamento"
            className="text-rose-700 hover:text-rose-900"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <h1 className="text-2xl font-bold text-rose-900 flex items-center gap-2">
            <AlertTriangle className="w-6 h-6 text-amber-600" />
            Peças não encontradas
          </h1>
          <button
            onClick={load}
            disabled={loading}
            className="ml-auto px-3 py-1.5 bg-white border border-rose-200 rounded-lg text-sm flex items-center gap-1.5 hover:bg-rose-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>

        <div className="bg-amber-50 border-l-4 border-amber-400 text-amber-900 p-3 mb-4 rounded text-sm">
          <strong>Itens reportados pelas lojas origem.</strong> Use as ações pra
          decidir o destino: cancelar definitivamente, devolver pra mesma loja
          tentar de novo, ou trocar pra outra loja com estoque.
        </div>

        {loading && (
          <div className="text-center py-10 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin inline" />
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded mb-3">
            {error}
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className="bg-white border-2 border-dashed border-slate-300 rounded-xl p-10 text-center text-slate-500">
            <Package className="w-12 h-12 mx-auto mb-2 text-emerald-300" />
            <div className="font-bold text-lg text-slate-700">Tudo em dia!</div>
            <div className="text-sm">Nenhuma peça reportada como não encontrada.</div>
          </div>
        )}

        {!loading && items.length > 0 && (
          <div className="space-y-4">
            {Array.from(byOrigem.entries()).map(([key, list]) => {
              const [code, name] = key.split('|');
              return (
                <div key={key} className="bg-white rounded-xl shadow-sm border overflow-hidden">
                  <div className="bg-gradient-to-r from-amber-100 to-orange-100 px-4 py-2 flex items-center gap-2 border-b border-amber-200">
                    <Store className="w-4 h-4 text-amber-700" />
                    <span className="font-bold text-amber-900 text-sm">
                      {code} · {name}
                    </span>
                    <span className="text-xs text-amber-700 bg-white/60 px-2 py-0.5 rounded-full">
                      {list.length} {list.length === 1 ? 'peça' : 'peças'}
                    </span>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {list.map((it) => (
                      <div key={it.id} className="p-3 hover:bg-slate-50 transition">
                        <div className="flex items-start gap-3 flex-wrap">
                          <div className="flex-1 min-w-[200px]">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono font-bold text-base text-slate-900">
                                {it.refCode}
                              </span>
                              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-semibold">
                                {it.cor || '—'} / {it.tamanho || '—'}
                              </span>
                              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-semibold">
                                {it.qtyOrigem}un
                              </span>
                            </div>
                            {it.descricao && (
                              <div className="text-sm text-slate-600 mt-1 truncate">
                                {it.descricao}
                              </div>
                            )}
                            <div className="text-xs text-slate-500 mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                              <span>→ {it.lojaDestinoCode} {it.lojaDestinoName}</span>
                              <span>👤 {it.solicitanteNome}</span>
                              <span className="flex items-center gap-1">
                                <Clock className="w-3 h-3" /> {formatDateTime(it.notFoundAt)}
                              </span>
                            </div>
                            {it.notFoundNote && (
                              <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-2 italic">
                                💬 {it.notFoundNote}
                              </div>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            <button
                              onClick={() => devolverParaFila(it)}
                              disabled={busyId === it.id}
                              className="text-xs px-2.5 py-1.5 bg-blue-100 text-blue-800 border border-blue-300 hover:bg-blue-200 rounded font-bold flex items-center gap-1 disabled:opacity-40"
                              title="Devolver pra fila da mesma loja"
                            >
                              <Undo2 className="w-3.5 h-3.5" />
                              Tentar de novo
                            </button>
                            <button
                              onClick={() => trocarLoja(it)}
                              disabled={busyId === it.id}
                              className="text-xs px-2.5 py-1.5 bg-violet-100 text-violet-800 border border-violet-300 hover:bg-violet-200 rounded font-bold flex items-center gap-1 disabled:opacity-40"
                              title="Trocar pra outra loja com estoque"
                            >
                              <Shuffle className="w-3.5 h-3.5" />
                              Trocar loja
                            </button>
                            <button
                              onClick={() => cancelar(it)}
                              disabled={busyId === it.id}
                              className="text-xs px-2.5 py-1.5 bg-red-100 text-red-800 border border-red-300 hover:bg-red-200 rounded font-bold flex items-center gap-1 disabled:opacity-40"
                              title="Cancelar definitivamente"
                            >
                              <X className="w-3.5 h-3.5" />
                              Cancelar
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
