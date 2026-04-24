'use client';

/**
 * /minha-loja/realinhamento — Tela onde a FILIAL separa as ordens de
 * realinhamento que a matriz despachou.
 *
 * Fluxo:
 *   1. GET /realignment/mine → lista tudo que tá pending pra essa loja ORIGEM.
 *   2. Agrupa por LOJA DESTINO → cada card = "pra qual loja vai".
 *   3. Dentro do card, agrupa por REF mostrando grade Cor × Tamanho (estilo
 *      /consultar) pra vendedora achar as peças rápido na arara.
 *   4. Botão "Enviei esta peça" por linha → PATCH /realignment/:id/sent.
 *      Remove da lista, emite socket pra matriz acompanhar.
 *   5. Socket 'realignment:new' → adiciona ordens novas em tempo real.
 *   6. Socket 'realignment:sent' → sincroniza se marcar enviado em outra aba.
 *
 * Motivo do design: a vendedora na loja não tem paciência pra ficar rolando
 * uma lista longa. Agrupando por DESTINO ela faz uma pilha por loja, e
 * agrupando por REF dentro dela consegue pegar todas as cores+tamanhos da
 * mesma referência em uma ida só na arara.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import {
  ArrowLeft, Shuffle, CheckCircle2, Loader2, RefreshCw, Package,
  AlertCircle, Send,
} from 'lucide-react';

interface RealignmentItem {
  id: string;
  refCode: string;
  cor: string | null;
  tamanho: string | null;
  qtyOrigem: number;
  lojaDestinoCode: string;
  lojaDestinoName: string;
  solicitanteNome: string;
  mensagem: string;
  createdAt: string;
}

interface MeProfile {
  userId: string;
  email: string;
  role: 'admin' | 'operator' | 'store';
  storeId: string | null;
  storeCode: string | null;
  storeName: string | null;
}

// Ordenação de tamanhos igual da tela /consultar: numéricos asc depois letras
const SIZE_ORDER = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'EG', 'EGG'];
function sortSizes(a: string | null, b: string | null): number {
  const A = (a || '').toUpperCase().trim();
  const B = (b || '').toUpperCase().trim();
  const na = Number(A);
  const nb = Number(B);
  const aIsNum = !Number.isNaN(na);
  const bIsNum = !Number.isNaN(nb);
  if (aIsNum && bIsNum) return na - nb;
  if (aIsNum) return -1;
  if (bIsNum) return 1;
  const ia = SIZE_ORDER.indexOf(A);
  const ib = SIZE_ORDER.indexOf(B);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return A.localeCompare(B);
}

export default function MinhaLojaRealinhamentoPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeProfile | null>(null);
  const [items, setItems] = useState<RealignmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sendingIds, setSendingIds] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Array<{ id: string; msg: string }>>([]);

  const pushToast = useCallback((msg: string) => {
    const id = String(Date.now() + Math.random());
    setToasts((prev) => [...prev, { id, msg }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const loadItems = useCallback(async () => {
    try {
      const data = await api<RealignmentItem[]>('/realignment/mine');
      setItems(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Erro ao carregar ordens');
    }
  }, []);

  // Auth + initial load
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    (async () => {
      try {
        const profile = await api<MeProfile>('/auth/me');
        if (profile.role !== 'store') {
          router.push('/');
          return;
        }
        setMe(profile);
        await loadItems();
      } catch (err: any) {
        setError(err?.message ?? 'Erro ao carregar');
        if (String(err?.message ?? '').startsWith('401')) router.push('/login');
      } finally {
        setLoading(false);
      }
    })();
  }, [router, loadItems]);

  // Socket
  useEffect(() => {
    if (!me) return;
    const socket = getSocket();

    const onNew = (payload: any) => {
      if (!payload?.items || !Array.isArray(payload.items)) return;
      // Merge: adiciona só as que não temos ainda (dedup por id)
      setItems((prev) => {
        const existingIds = new Set(prev.map((p) => p.id));
        const fresh = payload.items.filter((it: any) => !existingIds.has(it.id));
        if (fresh.length === 0) return prev;
        pushToast(`+${fresh.length} peça(s) de realinhamento chegaram`);
        return [...fresh, ...prev];
      });
    };

    const onSent = (payload: any) => {
      if (!payload?.transferId) return;
      // Sincroniza: remove da lista se outra aba marcou
      setItems((prev) => prev.filter((i) => i.id !== payload.transferId));
    };

    socket.on('realignment:new', onNew);
    socket.on('realignment:sent', onSent);
    return () => {
      socket.off('realignment:new', onNew);
      socket.off('realignment:sent', onSent);
    };
  }, [me, pushToast]);

  async function markSent(itemId: string) {
    setSendingIds((prev) => new Set(prev).add(itemId));
    try {
      await api(`/realignment/${itemId}/sent`, { method: 'PATCH' });
      setItems((prev) => prev.filter((i) => i.id !== itemId));
      pushToast('Marcado como enviado ✓');
    } catch (err: any) {
      pushToast(`Erro: ${err?.message ?? 'falha ao marcar'}`);
    } finally {
      setSendingIds((prev) => {
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      });
    }
  }

  // Agrupa por destino → dentro dele, por REF, com grade Cor × Tamanho
  const byDestination = useMemo(() => {
    const dests = new Map<string, { code: string; name: string; items: RealignmentItem[] }>();
    for (const it of items) {
      if (!dests.has(it.lojaDestinoCode)) {
        dests.set(it.lojaDestinoCode, {
          code: it.lojaDestinoCode,
          name: it.lojaDestinoName,
          items: [],
        });
      }
      dests.get(it.lojaDestinoCode)!.items.push(it);
    }
    // Converte cada destino pra grupos por REF, e dentro agrupa por Cor+Tam
    return Array.from(dests.values())
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((d) => {
        const byRef = new Map<string, RealignmentItem[]>();
        for (const it of d.items) {
          if (!byRef.has(it.refCode)) byRef.set(it.refCode, []);
          byRef.get(it.refCode)!.push(it);
        }
        const refGroups = Array.from(byRef.entries())
          .map(([ref, list]) => {
            // Organiza em matriz: linhas = cor, colunas = tamanho
            const cores = Array.from(new Set(list.map((x) => x.cor || '—'))).sort();
            const tams = Array.from(new Set(list.map((x) => x.tamanho || '—'))).sort(sortSizes);
            // Para cada (cor, tam) → item (ou null)
            const matrix: Record<string, Record<string, RealignmentItem | null>> = {};
            for (const c of cores) {
              matrix[c] = {};
              for (const t of tams) matrix[c][t] = null;
            }
            for (const it of list) {
              matrix[it.cor || '—'][it.tamanho || '—'] = it;
            }
            const totalQty = list.reduce((a, it) => a + it.qtyOrigem, 0);
            return { ref, cores, tams, matrix, totalQty, items: list };
          })
          .sort((a, b) => a.ref.localeCompare(b.ref));

        const totalItems = d.items.length;
        const totalUnits = d.items.reduce((a, it) => a + it.qtyOrigem, 0);
        return { code: d.code, name: d.name, refGroups, totalItems, totalUnits };
      });
  }, [items]);

  const totalPending = items.length;
  const totalUnits = useMemo(() => items.reduce((a, it) => a + it.qtyOrigem, 0), [items]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500">
        <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Carregando ordens...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-indigo-50 pb-10">
      {/* Header */}
      <header className="bg-gradient-to-r from-indigo-700 to-violet-700 text-white sticky top-0 z-20 shadow-lg">
        <div className="max-w-3xl mx-auto px-3 py-3 flex items-center gap-3">
          <Link
            href="/minha-loja"
            className="p-2 hover:bg-white/10 rounded"
            title="Voltar"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Shuffle className="w-5 h-5 shrink-0" />
            <div className="min-w-0">
              <div className="font-bold truncate">Realinhamento</div>
              <div className="text-[11px] opacity-80 truncate">
                {me?.storeName ?? ''} · enviar pras lojas irmãs
              </div>
            </div>
          </div>
          <button
            onClick={loadItems}
            className="p-2 hover:bg-white/10 rounded"
            title="Atualizar"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
        {/* Contadores */}
        <div className="px-4 pb-3 max-w-3xl mx-auto grid grid-cols-2 gap-2 text-slate-900">
          <div className="bg-amber-300 rounded-lg px-3 py-2">
            <div className="text-2xl font-bold tabular-nums">{totalPending}</div>
            <div className="text-[11px] font-semibold opacity-80">Peças pendentes</div>
          </div>
          <div className="bg-emerald-300 rounded-lg px-3 py-2">
            <div className="text-2xl font-bold tabular-nums">{totalUnits}</div>
            <div className="text-[11px] font-semibold opacity-80">Unidades</div>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-3 space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 flex items-start gap-2">
            <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
            <div className="text-sm">{error}</div>
          </div>
        )}

        {byDestination.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
            <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-3" />
            <div className="text-lg font-bold text-slate-800">
              Nenhuma peça pendente
            </div>
            <div className="text-sm text-slate-500 mt-1">
              Quando a matriz despachar um realinhamento, ele aparece aqui.
            </div>
          </div>
        ) : (
          byDestination.map((d) => (
            <section
              key={d.code}
              className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden"
            >
              {/* Header do destino */}
              <div className="bg-gradient-to-r from-emerald-500 to-teal-600 text-white px-4 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <Send className="w-4 h-4 shrink-0" />
                  <div className="min-w-0">
                    <div className="font-bold leading-tight">
                      Pra <span className="font-mono">{d.code}</span> · {d.name}
                    </div>
                    <div className="text-[11px] opacity-90">
                      {d.totalItems} peça(s) · {d.totalUnits}un
                    </div>
                  </div>
                </div>
              </div>

              {/* Grupos por REF */}
              <div className="divide-y divide-slate-100">
                {d.refGroups.map((g) => (
                  <div key={g.ref} className="p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="font-mono font-bold text-slate-800">{g.ref}</div>
                      <span className="text-xs bg-indigo-50 text-indigo-800 border border-indigo-200 rounded-full px-2 py-0.5 font-semibold">
                        {g.items.length} linha(s) · {g.totalQty}un
                      </span>
                    </div>
                    {/* Grade Cor × Tamanho */}
                    <div className="overflow-x-auto -mx-3 px-3">
                      <table className="w-full text-sm border-separate border-spacing-0">
                        <thead>
                          <tr>
                            <th className="text-left px-2 py-1.5 text-xs text-slate-500 bg-slate-50 rounded-l">
                              Cor
                            </th>
                            {g.tams.map((t) => (
                              <th
                                key={t}
                                className="text-center px-2 py-1.5 text-xs font-bold text-slate-700 bg-slate-50 min-w-[70px]"
                              >
                                {t}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {g.cores.map((c) => (
                            <tr key={c} className="border-t border-slate-100">
                              <td className="px-2 py-1.5 font-semibold text-slate-700 text-xs">
                                {c}
                              </td>
                              {g.tams.map((t) => {
                                const it = g.matrix[c][t];
                                if (!it) {
                                  return (
                                    <td
                                      key={t}
                                      className="px-2 py-1.5 text-center text-slate-300 text-xs"
                                    >
                                      —
                                    </td>
                                  );
                                }
                                const sending = sendingIds.has(it.id);
                                return (
                                  <td
                                    key={t}
                                    className="px-1 py-1 text-center align-middle"
                                  >
                                    <button
                                      onClick={() => markSent(it.id)}
                                      disabled={sending}
                                      className="w-full flex flex-col items-center gap-0.5 border-2 border-amber-400 bg-amber-50 hover:bg-emerald-100 hover:border-emerald-500 disabled:opacity-60 rounded-lg px-1 py-1 transition group"
                                      title="Marcar como enviada"
                                    >
                                      <span className="text-base font-black text-amber-800 group-hover:text-emerald-700 tabular-nums leading-tight">
                                        {it.qtyOrigem}
                                      </span>
                                      <span className="flex items-center gap-0.5 text-[10px] font-bold text-amber-800 group-hover:text-emerald-700 leading-tight">
                                        {sending ? (
                                          <Loader2 className="w-3 h-3 animate-spin" />
                                        ) : (
                                          <CheckCircle2 className="w-3 h-3" />
                                        )}
                                        {sending ? '...' : 'ENVIEI'}
                                      </span>
                                    </button>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))
        )}

        {/* Info card */}
        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 flex items-start gap-2">
          <Package className="w-4 h-4 text-indigo-600 mt-0.5 shrink-0" />
          <div className="text-xs text-indigo-900">
            <b>Como usar:</b> pegue a peça na arara, clique no botão com a quantidade
            e "ENVIEI". O item some da lista e a matriz fica sabendo na hora. Se
            cancelar, só não clica.
          </div>
        </div>
      </main>

      {/* Toasts */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 space-y-2 z-50">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="bg-slate-900 text-white px-4 py-2 rounded shadow-lg text-sm"
          >
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
