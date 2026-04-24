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
  AlertCircle, Send, Sparkles, Shirt,
} from 'lucide-react';

interface RealignmentItem {
  id: string;
  refCode: string;
  descricao: string | null;
  cor: string | null;
  tamanho: string | null;
  qtyOrigem: number;
  lojaDestinoCode: string;
  lojaDestinoName: string;
  solicitanteNome: string;
  mensagem: string;
  createdAt: string;
}

/** Title-case pra descrição — o Giga devolve tudo maiúsculo, fica elegante
 *  em "Vestido Midi Estampa Preto" ao invés de gritando. */
function toTitleCase(s: string): string {
  const SMALL = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'com', 'em', 'para', 'pra']);
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      if (i > 0 && SMALL.has(w)) return w;
      // preserva dígitos e abreviações
      if (/\d/.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
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
            // Descrição: pega a primeira não-vazia (todas as variações da mesma
            // REF compartilham a descrição base do produto)
            const rawDesc = list.find((it) => it.descricao && it.descricao.trim())?.descricao || '';
            const descricao = rawDesc ? toTitleCase(rawDesc) : '';
            return { ref, descricao, cores, tams, matrix, totalQty, items: list };
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
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-violet-50/40 to-fuchsia-50/30 pb-16 relative">
      {/* Decor blob sutil — visual moderno sem poluir. */}
      <div className="fixed top-40 -left-32 w-96 h-96 rounded-full bg-gradient-to-br from-violet-300/30 to-fuchsia-300/20 blur-3xl pointer-events-none" />
      <div className="fixed bottom-20 -right-32 w-[28rem] h-[28rem] rounded-full bg-gradient-to-tl from-indigo-300/20 to-pink-300/20 blur-3xl pointer-events-none" />

      {/* Header — glass sutil com gradiente. Sticky pra manter contexto. */}
      <header className="bg-gradient-to-r from-indigo-700 via-violet-700 to-fuchsia-700 text-white sticky top-0 z-30 shadow-2xl relative overflow-hidden">
        {/* Textura de brilho no canto */}
        <div className="absolute -top-10 -right-10 w-64 h-64 rounded-full bg-white/10 blur-2xl pointer-events-none" />
        <div className="absolute top-20 left-1/3 w-40 h-40 rounded-full bg-fuchsia-400/20 blur-3xl pointer-events-none" />

        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3 relative">
          <Link
            href="/minha-loja"
            className="p-2 hover:bg-white/15 rounded-lg transition backdrop-blur"
            title="Voltar"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-11 h-11 rounded-2xl bg-white/20 backdrop-blur-md flex items-center justify-center shrink-0 ring-1 ring-white/20 shadow-lg">
            <Shuffle className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <div className="font-black text-xl leading-tight truncate tracking-tight">
                Realinhamento
              </div>
              <Sparkles className="w-4 h-4 opacity-70" />
            </div>
            <div className="text-xs opacity-85 truncate font-medium">
              {me?.storeName ?? ''} · separe e envie pras lojas irmãs
            </div>
          </div>
          <button
            onClick={loadItems}
            className="p-2 hover:bg-white/15 rounded-lg transition backdrop-blur"
            title="Atualizar"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* KPIs grandes — visibilidade imediata do volume, glass effect. */}
        <div className="max-w-6xl mx-auto px-4 pb-5 grid grid-cols-2 gap-3 relative">
          <div className="group bg-gradient-to-br from-amber-300 to-amber-400 text-amber-950 rounded-2xl px-5 py-4 shadow-xl flex items-center gap-4 ring-1 ring-white/40 hover:scale-[1.02] transition">
            <div className="w-12 h-12 rounded-xl bg-white/40 backdrop-blur flex items-center justify-center shrink-0 shadow-inner">
              <Package className="w-6 h-6" />
            </div>
            <div>
              <div className="text-4xl font-black tabular-nums leading-none tracking-tight">{totalPending}</div>
              <div className="text-xs font-black opacity-80 mt-1.5 uppercase tracking-wider">Peças pendentes</div>
            </div>
          </div>
          <div className="group bg-gradient-to-br from-emerald-300 to-emerald-400 text-emerald-950 rounded-2xl px-5 py-4 shadow-xl flex items-center gap-4 ring-1 ring-white/40 hover:scale-[1.02] transition">
            <div className="w-12 h-12 rounded-xl bg-white/40 backdrop-blur flex items-center justify-center shrink-0 shadow-inner">
              <Send className="w-6 h-6" />
            </div>
            <div>
              <div className="text-4xl font-black tabular-nums leading-none tracking-tight">{totalUnits}</div>
              <div className="text-xs font-black opacity-80 mt-1.5 uppercase tracking-wider">Unidades no total</div>
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
              className="bg-white/90 backdrop-blur rounded-3xl border border-slate-200/80 shadow-xl overflow-hidden relative"
            >
              {/* Header destino — gradiente mais sofisticado + glass accents. */}
              <div className="bg-gradient-to-r from-emerald-500 via-teal-600 to-cyan-600 text-white px-5 py-5 flex items-center gap-4 relative overflow-hidden">
                <div className="absolute -top-8 -right-8 w-40 h-40 rounded-full bg-white/15 blur-2xl" />
                <div className="absolute bottom-0 left-1/3 w-32 h-32 rounded-full bg-cyan-300/20 blur-3xl" />
                <div className="w-14 h-14 rounded-2xl bg-white/20 backdrop-blur-md flex items-center justify-center shrink-0 ring-1 ring-white/30 shadow-lg relative">
                  <Send className="w-7 h-7" />
                </div>
                <div className="min-w-0 flex-1 relative">
                  <div className="text-[11px] font-black uppercase tracking-[0.15em] opacity-80">
                    Pilha pra
                  </div>
                  <div className="font-black text-2xl sm:text-3xl leading-tight truncate tracking-tight mt-0.5">
                    <span className="font-mono bg-white/25 backdrop-blur rounded-lg px-2.5 py-0.5 text-xl mr-2 ring-1 ring-white/30">
                      {d.code}
                    </span>
                    {d.name}
                  </div>
                </div>
                <div className="text-right shrink-0 relative">
                  <div className="text-4xl font-black tabular-nums leading-none tracking-tight">
                    {d.totalUnits}
                  </div>
                  <div className="text-[11px] font-black uppercase tracking-wider opacity-85 mt-1.5">
                    unidades
                  </div>
                </div>
              </div>

              {/* Grupos por REF */}
              <div className="divide-y divide-slate-100">
                {d.refGroups.map((g) => (
                  <div key={g.ref} className="p-4 sm:p-6 space-y-4">
                    {/* Header do REF — card elegante com REF grande + descrição. */}
                    <div className="flex items-start gap-3 flex-wrap">
                      <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center shrink-0 shadow-lg shadow-fuchsia-500/20">
                        <Shirt className="w-6 h-6 text-white" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="font-mono font-black text-2xl sm:text-3xl text-slate-900 tracking-tight uppercase leading-none">
                            {g.ref.toUpperCase()}
                          </div>
                          <span className="text-xs bg-gradient-to-r from-indigo-50 to-violet-50 text-indigo-800 border border-indigo-200 rounded-full px-3 py-1 font-black uppercase tracking-wider shadow-sm">
                            {g.items.length} × {g.totalQty}un
                          </span>
                        </div>
                        {g.descricao && (
                          <div className="text-sm text-slate-600 font-medium mt-1.5 leading-snug line-clamp-2">
                            {g.descricao}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Grade Cor × Tamanho — formato idêntico à tela /consultar.
                        Header de tamanhos tipo tabela compacta + bolinha de cor +
                        coluna/linha Total. Células clicáveis pra marcar ENVIEI. */}
                    <RealignGrid
                      g={g}
                      sendingIds={sendingIds}
                      onSend={markSent}
                    />
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

/**
 * RealignGrid — grade Cor × Tamanho no MESMO formato da tela /consultar.
 *
 * Estrutura:
 *   thead: Cor | [tamanhos] | Total
 *   tbody: ● [COR]  | [células clicáveis amber] | [row total]
 *   tfoot: Total    | [col totals]              | [grand total]
 *
 * Diferença do /consultar: as células aqui representam peças A ENVIAR.
 * Clicar na célula = marcar "ENVIEI" (dispara onSend). Durante o envio,
 * mostra spinner. Células sem peça (aquele cor/tam não veio no lote) ficam
 * "—" em slate, não são clicáveis.
 */
function RealignGrid({
  g,
  sendingIds,
  onSend,
}: {
  g: {
    ref: string;
    descricao: string;
    cores: string[];
    tams: string[];
    matrix: Record<string, Record<string, RealignmentItem | null>>;
    totalQty: number;
    items: RealignmentItem[];
  };
  sendingIds: Set<string>;
  onSend: (id: string) => void;
}) {
  // Totais por cor (linha) e por tamanho (coluna) — ignora células vazias.
  const totalsByColor = new Map<string, number>();
  const totalsBySize = new Map<string, number>();
  for (const c of g.cores) {
    let rowTotal = 0;
    for (const t of g.tams) {
      const it = g.matrix[c][t];
      if (it) {
        rowTotal += it.qtyOrigem;
        totalsBySize.set(t, (totalsBySize.get(t) || 0) + it.qtyOrigem);
      }
    }
    totalsByColor.set(c, rowTotal);
  }

  return (
    <>
      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-slate-100 border-b border-slate-200">
              <th className="text-left px-3 py-2 font-bold text-slate-700 sticky left-0 bg-slate-100 z-10 min-w-[100px]">
                Cor
              </th>
              {g.tams.map((s) => (
                <th
                  key={s}
                  className="px-2 py-2 text-center font-bold text-slate-700 min-w-[56px]"
                >
                  {s}
                </th>
              ))}
              <th className="px-2 py-2 text-center font-bold text-slate-700 min-w-[56px] bg-slate-200">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {g.cores.map((cor) => {
              const colorTotal = totalsByColor.get(cor) || 0;
              return (
                <tr
                  key={cor}
                  className="transition border-b border-slate-100 hover:bg-slate-50"
                >
                  <td className="px-3 py-2 font-semibold text-slate-800 sticky left-0 z-10 bg-white border-r border-slate-100">
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                          colorTotal > 0 ? 'bg-emerald-500' : 'bg-slate-300'
                        }`}
                      />
                      <span
                        className="truncate max-w-[110px] uppercase tracking-wide"
                        title={cor}
                      >
                        {cor}
                      </span>
                    </div>
                  </td>
                  {g.tams.map((s) => {
                    const it = g.matrix[cor]?.[s] ?? null;
                    return (
                      <td key={s} className="p-0.5 text-center">
                        <RealignCell
                          item={it}
                          sending={it ? sendingIds.has(it.id) : false}
                          onSend={onSend}
                        />
                      </td>
                    );
                  })}
                  <td
                    className={`px-2 py-2 text-center font-bold ${
                      colorTotal > 0 ? 'text-emerald-700' : 'text-slate-400'
                    } bg-slate-50`}
                  >
                    {colorTotal}
                  </td>
                </tr>
              );
            })}
            {/* Linha totais por tamanho */}
            <tr className="bg-slate-100 border-t-2 border-slate-300">
              <td className="px-3 py-2 font-bold text-slate-700 sticky left-0 bg-slate-100 z-10 border-r border-slate-200">
                Total
              </td>
              {g.tams.map((s) => {
                const t = totalsBySize.get(s) || 0;
                return (
                  <td
                    key={s}
                    className={`px-2 py-2 text-center font-bold ${
                      t > 0 ? 'text-slate-800' : 'text-slate-400'
                    }`}
                  >
                    {t}
                  </td>
                );
              })}
              <td className="px-2 py-2 text-center font-extrabold text-emerald-700 bg-slate-200">
                {g.totalQty}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Legenda — mesmo estilo da /consultar, contexto adaptado. */}
      <div className="flex flex-wrap items-center gap-3 mt-2 px-1 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-amber-100 border border-amber-300 inline-block" />
          a enviar · toque pra marcar
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-emerald-200 border border-emerald-400 inline-block" />
          enviando...
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-slate-50 border border-slate-200 inline-block" />
          sem peça neste lote
        </span>
      </div>
    </>
  );
}

/**
 * Célula individual da grade de realinhamento.
 *   - Com item:  amber, clicável (mostra qty grande + "ENVIEI" pequeno)
 *   - Sem item:  "—" slate, não clicável
 *   - Enviando:  emerald + spinner
 */
function RealignCell({
  item,
  sending,
  onSend,
}: {
  item: RealignmentItem | null;
  sending: boolean;
  onSend: (id: string) => void;
}) {
  const base =
    'mx-auto w-full h-12 rounded flex flex-col items-center justify-center font-extrabold relative transition select-none';

  if (!item) {
    return (
      <div className={`${base} bg-slate-50 text-slate-300 text-base`}>
        —
      </div>
    );
  }

  if (sending) {
    return (
      <div className={`${base} bg-emerald-200 text-emerald-900 border border-emerald-400`}>
        <Loader2 className="w-4 h-4 animate-spin" />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSend(item.id)}
      title={`Marcar como ENVIEI — ${item.qtyOrigem}un`}
      className={`${base} bg-amber-100 text-amber-900 border border-amber-300 hover:bg-amber-200 active:scale-95 cursor-pointer`}
    >
      <span className="text-lg leading-none tabular-nums">{item.qtyOrigem}</span>
      <span className="text-[9px] font-black uppercase tracking-wider opacity-75 mt-0.5">
        enviei
      </span>
    </button>
  );
}
