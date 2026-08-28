'use client';

/**
 * /loja/reposicao — Reposição de Produtos, formato CASCATA (28/08).
 *
 * Redesenho a pedido do dono ("esta tela eu acho muito ruim... poderia ser em
 * cascata"): a busca lista REFERÊNCIAS; clicar numa REF abre as CORES em
 * cascata; cada cor é uma GRADE SECA — todos os tamanhos numa LINHA só, sem
 * foto, com o campo de quantidade dentro de cada tamanho. Embaixo, a barra
 * fixa soma o que foi digitado (sobrevive a trocar de busca) e oferece os dois
 * destinos de sempre: ENTRADA no estoque + etiquetas, ou SÓ etiquetas.
 *
 * Tirar as fotos não é só estética: a versão antiga disparava ~1 request de
 * foto POR SKU (115 numa busca "BMM-100") — era isso que pendurava a tela.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Search, Loader2, Printer, Package, CheckCircle2,
  ChevronDown, ChevronRight, Trash2, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import EtiquetaPrint, { type EtiquetaConfig } from '@/components/EtiquetaPrint';

type Produto = {
  codigo: string;
  ref: string;
  cor: string;
  tamanho: string;
  preco: number;
  descricao: string;
};

type Label = {
  ref: string;
  cor: string;
  tamanho: string;
  codigo: string;
  preco: number;
  marca: string | null;
  descricao: string;
};

/** Item digitado — vive FORA dos resultados pra sobreviver a uma nova busca. */
type ItemSel = { p: Produto; qty: number };

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Ordena tamanho: numérico crescente (44..60), depois letras na ordem da casa. */
const ORD_LETRA: Record<string, number> = {
  PP: 1001, P: 1002, M: 1003, G: 1004, GG: 1005, XG: 1006, EXG: 1007, XGG: 1008, EG: 1006,
};
const ordTam = (t: string) => {
  const n = parseInt(t, 10);
  if (!isNaN(n)) return n;
  return ORD_LETRA[String(t || '').trim().toUpperCase()] ?? 2000;
};

export default function ReposicaoPage() {
  const [busca, setBusca] = useState('');
  const [loading, setLoading] = useState(false);
  const [erroBusca, setErroBusca] = useState<string | null>(null);
  const [resultados, setResultados] = useState<Produto[]>([]);
  /** REFs abertas na cascata. */
  const [abertas, setAbertas] = useState<Set<string>>(new Set());
  /** Quantidades digitadas, por CODIGO — o "carrinho" da reposição. */
  const [sel, setSel] = useState<Record<string, ItemSel>>({});
  const [confirmando, setConfirmando] = useState(false);
  const [resultado, setResultado] = useState<{ ok: boolean; total: number; labels: Label[] } | null>(null);
  const [etiquetaCfg, setEtiquetaCfg] = useState<EtiquetaConfig | undefined>(undefined);
  useEffect(() => { api<EtiquetaConfig>('/etiqueta-config').then(setEtiquetaCfg).catch(() => {}); }, []);

  // Busca com debounce. Erro NÃO vira lista vazia — busca quebrada e busca
  // vazia não podem ter a mesma cara (lição de 27/08).
  useEffect(() => {
    if (busca.trim().length < 2) {
      setResultados([]);
      setErroBusca(null);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api<Produto[]>(`/purchase-orders/reposicao/buscar?q=${encodeURIComponent(busca.trim())}`);
        setResultados(r);
        setErroBusca(null);
        // Cascata: 1 REF só no resultado → já abre; várias → fechadas.
        const refs = new Set(r.map((p) => p.ref));
        setAbertas(refs.size === 1 ? refs : new Set());
      } catch (e: any) {
        setResultados([]);
        setErroBusca(e?.message || 'não deu pra consultar o catálogo agora');
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [busca]);

  /** REF → cores → itens (tamanhos ordenados). */
  const grupos = useMemo(() => {
    const porRef = new Map<string, Produto[]>();
    for (const p of resultados) {
      if (!porRef.has(p.ref)) porRef.set(p.ref, []);
      porRef.get(p.ref)!.push(p);
    }
    return Array.from(porRef.entries()).map(([ref, prods]) => {
      const porCor = new Map<string, Produto[]>();
      for (const p of prods) {
        if (!porCor.has(p.cor)) porCor.set(p.cor, []);
        porCor.get(p.cor)!.push(p);
      }
      const cores = Array.from(porCor.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cor, itens]) => {
          const ordenados = [...itens].sort((a, b) => ordTam(a.tamanho) - ordTam(b.tamanho));
          const precos = ordenados.map((i) => i.preco).filter((v) => v > 0);
          return {
            cor,
            itens: ordenados,
            precoMin: precos.length ? Math.min(...precos) : 0,
            precoMax: precos.length ? Math.max(...precos) : 0,
          };
        });
      return { ref, descricao: prods[0]?.descricao || '', skus: prods.length, cores };
    });
  }, [resultados]);

  const toggleRef = (ref: string) => {
    setAbertas((prev) => {
      const n = new Set(prev);
      if (n.has(ref)) n.delete(ref);
      else n.add(ref);
      return n;
    });
  };

  const setQty = (p: Produto, raw: string) => {
    const qty = Math.max(0, Math.floor(Number(raw) || 0));
    setSel((prev) => {
      const n = { ...prev };
      if (qty <= 0) delete n[p.codigo];
      else n[p.codigo] = { p, qty };
      return n;
    });
  };

  const itens = useMemo(() => Object.values(sel), [sel]);
  const totalPecas = useMemo(() => itens.reduce((s, i) => s + i.qty, 0), [itens]);
  /** Resumo por REF pra barra fixa (chips com X). */
  const porRefSel = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of itens) m.set(i.p.ref, (m.get(i.p.ref) || 0) + i.qty);
    return Array.from(m.entries());
  }, [itens]);

  const limparRef = (ref: string) => {
    setSel((prev) => {
      const n: Record<string, ItemSel> = {};
      for (const [cod, it] of Object.entries(prev)) if (it.p.ref !== ref) n[cod] = it;
      return n;
    });
  };

  /** soEtiquetas=true NÃO mexe no estoque — só gera as etiquetas (reimpressão). */
  const confirmar = async (soEtiquetas: boolean) => {
    if (itens.length === 0) return;
    const msg = soEtiquetas
      ? `Gerar ${totalPecas} etiqueta(s) SEM mexer no estoque?`
      : `Dar ENTRADA de ${totalPecas} peça(s) em ${itens.length} SKU(s) e gerar etiquetas?`;
    if (!confirm(msg)) return;
    setConfirmando(true);
    try {
      const r = await api<{ ok: boolean; total: number; labels: Label[] }>(
        `/purchase-orders/reposicao/confirmar`,
        {
          method: 'POST',
          body: JSON.stringify({
            apenasEtiqueta: soEtiquetas,
            items: itens.map(({ p, qty }) => ({
              codigo: p.codigo,
              qty,
              ref: p.ref,
              cor: p.cor,
              tamanho: p.tamanho,
              preco: p.preco,
              descricao: p.descricao,
            })),
          }),
        },
      );
      // ACUMULA etiquetas — a vendedora repõe várias REFs e imprime UMA vez.
      setResultado((prev) => {
        if (!prev) return r;
        return {
          ok: r.ok && prev.ok,
          total: (prev.total || 0) + (r.total || 0),
          labels: [...(prev.labels || []), ...(r.labels || [])],
        };
      });
      if (r.ok) setSel({}); // grade continua na tela pra conferir/continuar
      else alert('Reposição parcialmente OK. Veja o resultado.');
    } catch (e: any) {
      alert('Erro: ' + (e?.message || 'desconhecido'));
    } finally {
      setConfirmando(false);
    }
  };

  const imprimir = () => window.print();

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 print:hidden">
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/loja" className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-emerald-500 flex items-center justify-center">
            <Package className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-black text-slate-800">Reposição de Produtos</h1>
            <p className="text-xs text-slate-500">REF → cores → grade · digite as quantidades · entrada e/ou etiquetas</p>
          </div>
          {resultado && resultado.labels.length > 0 && (
            <>
              <button
                onClick={() => {
                  if (confirm(`Limpar ${resultado.labels.length} etiqueta(s) acumulada(s)?`)) setResultado(null);
                }}
                className="flex items-center gap-2 px-3 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-sm rounded-lg"
                title="Zera as etiquetas acumuladas"
              >
                🗑️ Limpar
              </button>
              <button
                onClick={imprimir}
                className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm rounded-lg shadow-md"
              >
                <Printer className="w-4 h-4" />
                Imprimir {resultado.labels.length} etiquetas
              </button>
            </>
          )}
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto p-4 space-y-3 print:hidden pb-32">
        {/* Busca */}
        <section className="bg-white border border-slate-200 rounded-2xl p-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar por REF (ex: BMM-100) ou descrição (ex: BLUSA PRETO)..."
              autoFocus
              className="w-full pl-10 pr-3 py-3 border-2 rounded-lg text-base"
            />
            {loading && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 animate-spin text-violet-600" />
            )}
          </div>
          {busca.length > 0 && busca.length < 2 && (
            <div className="mt-2 text-xs text-slate-400">Digite pelo menos 2 caracteres</div>
          )}
        </section>

        {/* Erro de busca — NÃO é "não achei" */}
        {busca.length >= 2 && !loading && erroBusca && (
          <div className="bg-rose-50 border-2 border-rose-300 rounded-2xl p-8 text-center">
            <div className="text-lg font-black text-rose-800 mb-1">Erro ao buscar</div>
            <div className="text-sm text-rose-700">
              A busca falhou — <b>não</b> quer dizer que a peça não existe. Tente de novo em alguns
              segundos e, se continuar, avise a matriz.
            </div>
            <div className="text-xs font-mono text-rose-500 mt-2">{erroBusca}</div>
          </div>
        )}

        {busca.length >= 2 && !loading && !erroBusca && resultados.length === 0 && (
          <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center text-slate-500">
            <Package className="w-12 h-12 text-slate-300 mx-auto mb-2" />
            Nenhum produto encontrado pra "<b>{busca}</b>"
          </div>
        )}

        {/* CASCATA: REF → cores → grade de tamanhos numa linha */}
        {grupos.map((g) => {
          const aberta = abertas.has(g.ref);
          const qtdNaRef = porRefSel.find(([r]) => r === g.ref)?.[1] || 0;
          return (
            <section key={g.ref} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <button
                type="button"
                onClick={() => toggleRef(g.ref)}
                className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-slate-50 text-left"
              >
                {aberta
                  ? <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                  : <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />}
                <span className="font-black font-mono text-violet-700">{g.ref}</span>
                <span className="font-bold text-sm text-slate-700 truncate">{g.descricao}</span>
                <span className="ml-auto flex items-center gap-2 shrink-0">
                  {qtdNaRef > 0 && (
                    <span className="text-xs font-black bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
                      {qtdNaRef} pç
                    </span>
                  )}
                  <span className="text-xs text-slate-500">{g.cores.length} cor(es) · {g.skus} SKU(s)</span>
                </span>
              </button>

              {aberta && (
                <div className="border-t border-slate-100 divide-y divide-slate-50">
                  {g.cores.map((c) => (
                    <div key={c.cor} className="flex items-center gap-2 px-3 py-1.5 overflow-x-auto">
                      <div className="w-32 shrink-0 text-xs font-bold text-slate-700 uppercase truncate" title={c.cor}>
                        {c.cor}
                      </div>
                      <div className="flex items-end gap-1">
                        {c.itens.map((p) => {
                          const q = sel[p.codigo]?.qty || 0;
                          return (
                            <label key={p.codigo} className="shrink-0 w-12" title={`${p.codigo} · ${brl(p.preco)}`}>
                              <div className="text-[10px] text-center font-mono text-slate-500 leading-tight">
                                {p.tamanho}
                              </div>
                              <input
                                type="number"
                                min={0}
                                value={q || ''}
                                placeholder="·"
                                onChange={(e) => setQty(p, e.target.value)}
                                className={`w-12 h-9 text-center font-mono font-black rounded border-2 outline-none
                                  ${q > 0
                                    ? 'border-emerald-500 bg-emerald-50 text-emerald-800'
                                    : 'border-slate-200 text-slate-700 focus:border-violet-400'}`}
                              />
                            </label>
                          );
                        })}
                      </div>
                      <div className="ml-auto shrink-0 text-xs font-bold text-emerald-700 pl-2">
                        {c.precoMin === c.precoMax ? brl(c.precoMin) : `${brl(c.precoMin)} – ${brl(c.precoMax)}`}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })}

        {/* Resultado da confirmação */}
        {resultado && (
          <section className={`rounded-2xl p-4 border-2 ${
            resultado.ok ? 'bg-emerald-50 border-emerald-300' : 'bg-amber-50 border-amber-300'
          }`}>
            <div className="font-black text-lg mb-1">
              {resultado.ok ? '✅ Reposição confirmada!' : '⚠ Reposição parcial'}
            </div>
            <div className="text-sm">
              <b>{resultado.total}</b> etiqueta(s) acumulada(s). Clique em "Imprimir etiquetas" no topo.
            </div>
          </section>
        )}
      </main>

      {/* BARRA FIXA — soma o digitado (sobrevive a trocar de busca) + 2 destinos */}
      {itens.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-40 bg-violet-700 text-white shadow-[0_-4px_20px_rgba(0,0,0,0.25)] print:hidden">
          <div className="max-w-[1400px] mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
            <div className="font-black">
              {totalPecas} peça(s) · {itens.length} SKU(s)
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {porRefSel.map(([ref, qtd]) => (
                <span key={ref} className="flex items-center gap-1 bg-violet-600 rounded-full pl-2.5 pr-1 py-0.5 text-xs font-bold">
                  <span className="font-mono">{ref}</span>
                  <span className="opacity-80">{qtd}</span>
                  <button
                    onClick={() => limparRef(ref)}
                    className="p-0.5 rounded-full hover:bg-violet-500"
                    title={`Tirar ${ref} da lista`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => { if (confirm('Limpar todas as quantidades digitadas?')) setSel({}); }}
                disabled={confirmando}
                className="p-2.5 rounded-lg hover:bg-violet-600 disabled:opacity-40"
                title="Limpar quantidades"
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <button
                onClick={() => confirmar(true)}
                disabled={confirmando}
                className="flex items-center gap-2 px-4 py-2.5 bg-white/10 hover:bg-white/20 border border-white/40 font-bold text-sm rounded-lg disabled:opacity-40"
                title="Gera etiquetas SEM mexer no estoque (reimpressão)"
              >
                <Printer className="w-4 h-4" />
                Só etiqueta
              </button>
              <button
                onClick={() => confirmar(false)}
                disabled={confirmando}
                className="flex items-center gap-2 px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-emerald-950 font-black text-sm rounded-lg shadow disabled:opacity-40"
                title="Dá ENTRADA no estoque + gera etiquetas"
              >
                {confirmando ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Entrada + etiquetas
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Etiquetas (visíveis na impressão) — componente compartilhado */}
      {resultado && resultado.labels && (
        <EtiquetaPrint labels={resultado.labels} config={etiquetaCfg} />
      )}
    </div>
  );
}
