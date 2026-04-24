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
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-violet-50 pb-16">
      {/* Header — compacto + sticky. Max width maior pra aproveitar desktop. */}
      <header className="bg-gradient-to-r from-indigo-700 via-violet-700 to-fuchsia-700 text-white sticky top-0 z-30 shadow-xl">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link
            href="/minha-loja"
            className="p-2 hover:bg-white/15 rounded-lg transition"
            title="Voltar"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center shrink-0">
            <Shuffle className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-black text-lg leading-tight truncate">Realinhamento</div>
            <div className="text-xs opacity-85 truncate">
              {me?.storeName ?? ''} · separe e envie pras lojas irmãs
            </div>
          </div>
          <button
            onClick={loadItems}
            className="p-2 hover:bg-white/15 rounded-lg transition"
            title="Atualizar"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* KPIs grandes — visibilidade imediata do volume. */}
        <div className="max-w-6xl mx-auto px-4 pb-4 grid grid-cols-2 gap-3">
          <div className="bg-amber-400 text-amber-950 rounded-xl px-4 py-3 shadow-md flex items-center gap-3">
            <Package className="w-8 h-8 shrink-0 opacity-80" />
            <div>
              <div className="text-3xl font-black tabular-nums leading-none">{totalPending}</div>
              <div className="text-xs font-bold opacity-80 mt-1">Peças pendentes</div>
            </div>
          </div>
          <div className="bg-emerald-400 text-emerald-950 rounded-xl px-4 py-3 shadow-md flex items-center gap-3">
            <Send className="w-8 h-8 shrink-0 opacity-80" />
            <div>
              <div className="text-3xl font-black tabular-nums leading-none">{totalUnits}</div>
              <div className="text-xs font-bold opacity-80 mt-1">Unidades no total</div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 space-y-5">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 flex items-start gap-2">
            <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
            <div className="text-sm">{error}</div>
          </div>
        )}

        {byDestination.length === 0 ? (
          <div className="bg-white rounded-2xl border-2 border-dashed border-slate-300 p-12 text-center shadow-sm">
            <div className="w-20 h-20 mx-auto rounded-full bg-emerald-50 flex items-center justify-center mb-4">
              <CheckCircle2 className="w-12 h-12 text-emerald-500" />
            </div>
            <div className="text-xl font-black text-slate-800">
              Nenhuma peça pendente
            </div>
            <div className="text-sm text-slate-500 mt-2 max-w-md mx-auto">
              Quando a matriz despachar um realinhamento, ele aparece aqui na
              hora. Enquanto isso, fica tranquila.
            </div>
          </div>
        ) : (
          byDestination.map((d) => (
            <section
              key={d.code}
              className="bg-white rounded-2xl border border-slate-200 shadow-md overflow-hidden"
            >
              {/* Header destino — grande, claro e com info útil de pilha. */}
              <div className="bg-gradient-to-r from-emerald-500 via-emerald-600 to-teal-600 text-white px-5 py-4 flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-white/20 backdrop-blur flex items-center justify-center shrink-0">
                  <Send className="w-6 h-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-bold uppercase tracking-wider opacity-85">
                    Pilha pra
                  </div>
                  <div className="font-black text-2xl leading-tight truncate">
                    <span className="font-mono bg-white/20 rounded px-2 py-0.5 text-lg mr-2">
                      {d.code}
                    </span>
                    {d.name}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-3xl font-black tabular-nums leading-none">
                    {d.totalUnits}
                  </div>
                  <div className="text-[11px] font-bold uppercase tracking-wider opacity-85 mt-1">
                    unidades
                  </div>
                </div>
              </div>

              {/* Grupos por REF */}
              <div className="divide-y-2 divide-slate-100">
                {d.refGroups.map((g) => (
                  <div key={g.ref} className="p-4 sm:p-5 space-y-3">
                    {/* Header do REF — REF em destaque tipo tag grande (uppercase). */}
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="font-mono font-black text-2xl sm:text-3xl text-slate-900 bg-slate-100 rounded-lg px-4 py-2 border-2 border-slate-300 uppercase tracking-wide">
                          {g.ref.toUpperCase()}
                        </div>
                        <span className="text-sm bg-indigo-50 text-indigo-800 border border-indigo-200 rounded-full px-3 py-1 font-bold">
                          {g.items.length} linha(s) · {g.totalQty}un
                        </span>
                      </div>
                    </div>

                    {/* Grade Cor × Tamanho — células grandes, toque fácil. */}
                    <div className="overflow-x-auto -mx-4 px-4 sm:-mx-5 sm:px-5">
                      <table className="w-full text-sm border-separate border-spacing-0">
                        <thead>
                          <tr>
                            <th className="text-left px-3 py-3 text-sm font-black uppercase tracking-wider text-slate-600 bg-slate-50 rounded-tl-lg min-w-[160px] sticky left-0 z-10">
                              Cor
                            </th>
                            {g.tams.map((t, idx) => (
                              <th
                                key={t}
                                className={`text-center px-2 py-3 text-2xl font-black text-slate-900 bg-slate-50 min-w-[110px] ${
                                  idx === g.tams.length - 1 ? 'rounded-tr-lg' : ''
                                }`}
                              >
                                {String(t).toUpperCase()}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {g.cores.map((c, rowIdx) => (
                            <tr key={c}>
                              <td
                                className={`px-3 py-2 font-bold text-slate-800 bg-white sticky left-0 z-10 border-t ${
                                  rowIdx === 0 ? 'border-transparent' : 'border-slate-100'
                                }`}
                              >
                                <span className="inline-block bg-slate-100 text-slate-900 rounded-lg px-3 py-1.5 border-2 border-slate-300 uppercase text-base font-black tracking-wide">
                                  {String(c).toUpperCase()}
                                </span>
                              </td>
                              {g.tams.map((t) => {
                                const it = g.matrix[c][t];
                                if (!it) {
                                  return (
                                    <td
                                      key={t}
                                      className={`px-2 py-2 text-center text-slate-300 border-t ${
                                        rowIdx === 0 ? 'border-transparent' : 'border-slate-100'
                                      }`}
                                    >
                                      <span className="text-2xl">·</span>
                                    </td>
                                  );
                                }
                                const sending = sendingIds.has(it.id);
                                return (
                                  <td
                                    key={t}
                                    className={`px-1.5 py-1.5 align-middle border-t ${
                                      rowIdx === 0 ? 'border-transparent' : 'border-slate-100'
                                    }`}
                                  >
                                    <button
                                      onClick={() => markSent(it.id)}
                                      disabled={sending}
                                      className="group w-full min-h-[72px] flex flex-col items-center justify-center gap-1 border-2 border-amber-400 bg-gradient-to-br from-amber-50 to-amber-100 hover:from-emerald-100 hover:to-emerald-200 hover:border-emerald-600 hover:shadow-lg active:scale-95 disabled:opacity-60 disabled:cursor-wait rounded-xl px-2 py-2 transition-all shadow-sm"
                                      title="Marcar como enviada"
                                    >
                                      <span className="text-2xl font-black text-amber-900 group-hover:text-emerald-800 tabular-nums leading-none">
                                        {it.qtyOrigem}
                                      </span>
                                      <span className="flex items-center gap-1 text-[11px] font-black text-amber-800 group-hover:text-emerald-800 uppercase tracking-wide leading-none">
                                        {sending ? (
                                          <>
                                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                            enviando
                                          </>
                                        ) : (
                                          <>
                                            <CheckCircle2 className="w-3.5 h-3.5" />
                                            enviei
                                          </>
                                        )}
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

        {/* Info card — menor e muted, só referência. */}
        {byDestination.length > 0 && (
          <div className="bg-indigo-50/60 border border-indigo-200 rounded-xl p-4 flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0">
              <Package className="w-4 h-4 text-indigo-700" />
            </div>
            <div className="text-xs text-indigo-900 leading-relaxed">
              <b className="text-sm">Como operar:</b><br />
              Pegue a peça na arara · toque na célula com a quantidade e{' '}
              <b>&quot;ENVIEI&quot;</b> · ela some da grade e a matriz vê na
              hora. Se não tiver a peça fisicamente, simplesmente não clica.
            </div>
          </div>
        )}
      </main>

      {/* Toasts */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 space-y-2 z-50 w-full max-w-md px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="bg-slate-900 text-white px-4 py-3 rounded-lg shadow-2xl text-sm font-semibold text-center"
          >
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
