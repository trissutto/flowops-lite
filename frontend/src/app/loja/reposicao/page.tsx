'use client';

/**
 * /loja/reposicao — Reposicao de produtos.
 *
 * Fluxo:
 *  1. Vendedora busca por REF ou DESCRICAO
 *  2. Lista produtos que dao match (cores/tamanhos)
 *  3. Clica nos que chegaram e informa qty
 *  4. Confirma: sistema adiciona estoque no Wincred + gera etiquetas pra impressao
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Search, Loader2, Plus, Trash2, CheckCircle2, Printer, Package } from 'lucide-react';
import { api } from '@/lib/api';
import ProductPhoto from '@/components/ProductPhoto';
import EtiquetaPrint, { type EtiquetaConfig } from '@/components/EtiquetaPrint';

type Produto = {
  codigo: string;
  ref: string;
  cor: string;
  tamanho: string;
  preco: number;
  descricao: string;
};

type Selecionado = Produto & { qty: number };

type Label = {
  ref: string;
  cor: string;
  tamanho: string;
  codigo: string;
  preco: number;
  marca: string | null;
  descricao: string;
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function ReposicaoPage() {
  const [busca, setBusca] = useState('');
  const [etiquetaCfg, setEtiquetaCfg] = useState<EtiquetaConfig | undefined>(undefined);
  useEffect(() => { api<EtiquetaConfig>('/etiqueta-config').then(setEtiquetaCfg).catch(() => {}); }, []);
  const [resultados, setResultados] = useState<Produto[]>([]);
  const [loading, setLoading] = useState(false);
  const [selecionados, setSelecionados] = useState<Selecionado[]>([]);
  const [confirmando, setConfirmando] = useState(false);
  const [resultado, setResultado] = useState<{ ok: boolean; total: number; labels: Label[] } | null>(null);

  // Debounce na busca
  useEffect(() => {
    if (busca.trim().length < 2) {
      setResultados([]);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api<Produto[]>(`/purchase-orders/reposicao/buscar?q=${encodeURIComponent(busca.trim())}`);
        setResultados(r);
      } catch {
        setResultados([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [busca]);

  const selecionar = (p: Produto) => {
    if (selecionados.find((s) => s.codigo === p.codigo)) return;
    setSelecionados((prev) => [...prev, { ...p, qty: 1 }]);
  };

  const removerSel = (codigo: string) => {
    setSelecionados((prev) => prev.filter((s) => s.codigo !== codigo));
  };

  const setQty = (codigo: string, qty: number) => {
    setSelecionados((prev) =>
      prev.map((s) => (s.codigo === codigo ? { ...s, qty: Math.max(0, qty) } : s)),
    );
  };

  /**
   * Confirma reposicao. soEtiquetas=true forca qty=0 em todos os itens —
   * NAO mexe no estoque, apenas gera as etiquetas (reimpressao).
   */
  const confirmar = async (soEtiquetas = false) => {
    // Em ambos os modos exigimos qty >= 1 (qty define quantas etiquetas serao geradas)
    const validos = selecionados.filter((s) => s.qty >= 1);
    if (validos.length === 0) {
      alert('Informe a quantidade (qty >= 1) em pelo menos um produto');
      return;
    }
    const totalEtq = validos.reduce((sum, s) => sum + s.qty, 0);
    const msg = soEtiquetas
      ? `Gerar ${totalEtq} etiqueta(s) SEM mexer no estoque?`
      : `Confirmar reposicao de ${validos.length} SKU(s) (${totalEtq} pecas)? Vai adicionar no estoque Wincred e gerar etiquetas.`;
    if (!confirm(msg)) return;
    setConfirmando(true);
    try {
      const r = await api<{ ok: boolean; total: number; labels: Label[] }>(
        `/purchase-orders/reposicao/confirmar`,
        {
          method: 'POST',
          body: JSON.stringify({
            apenasEtiqueta: soEtiquetas,
            items: validos.map((s) => ({
              codigo: s.codigo,
              qty: s.qty,                  // sempre respeita qty (gera qty etiquetas)
              ref: s.ref,
              cor: s.cor,
              tamanho: s.tamanho,
              preco: s.preco,
              descricao: s.descricao,
            })),
          }),
        },
      );
      // ACUMULA etiquetas em vez de sobrescrever — vendedora pode bipar varios
      // produtos diferentes, ir gerando, e SO imprime no final. So zera quando
      // clicar em "Limpar etiquetas".
      setResultado((prev) => {
        if (!prev) return r;
        return {
          ok: r.ok && prev.ok,
          total: (prev.total || 0) + (r.total || 0),
          labels: [...(prev.labels || []), ...(r.labels || [])],
        };
      });
      if (r.ok) {
        setSelecionados([]);
        setBusca('');
        setResultados([]);
      } else {
        alert('Reposicao parcialmente OK. Veja resultado.');
      }
    } catch (e: any) {
      alert('Erro: ' + (e?.message || 'desconhecido'));
    } finally {
      setConfirmando(false);
    }
  };

  const imprimir = () => window.print();

  // Agrupa resultados por REF pra facilitar visualizacao
  const resultadosPorRef = new Map<string, Produto[]>();
  for (const p of resultados) {
    if (!resultadosPorRef.has(p.ref)) resultadosPorRef.set(p.ref, []);
    resultadosPorRef.get(p.ref)!.push(p);
  }

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
            <p className="text-xs text-slate-500">Busca por REF/descrição · qty · estoque + etiquetas</p>
          </div>
          {resultado && resultado.labels.length > 0 && (
            <>
              <button
                onClick={() => {
                  if (confirm(`Limpar ${resultado.labels.length} etiqueta(s) acumulada(s)?`)) {
                    setResultado(null);
                  }
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

      <main className="max-w-[1400px] mx-auto p-4 space-y-4 print:hidden">
        {/* Busca */}
        <section className="bg-white border border-slate-200 rounded-2xl p-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar por REF (ex: 7031) ou descrição (ex: BLUSA PRETO)..."
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

        {/* Resultados (agrupados por REF) */}
        {resultadosPorRef.size > 0 && (
          <section className="space-y-2">
            <div className="text-xs font-bold text-slate-600 uppercase tracking-wider">
              {resultados.length} resultado(s)
            </div>
            {Array.from(resultadosPorRef.entries()).map(([ref, prods]) => (
              <div key={ref} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="bg-slate-50 px-3 py-2 border-b border-slate-200 flex items-center gap-2">
                  <span className="font-black font-mono text-violet-700">{ref}</span>
                  <span className="font-bold text-sm text-slate-700 truncate">{prods[0].descricao}</span>
                  <span className="ml-auto text-xs text-slate-500">{prods.length} SKU(s)</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 p-2">
                  {prods.map((p) => {
                    const sel = selecionados.find((s) => s.codigo === p.codigo);
                    return (
                      <button
                        key={p.codigo}
                        type="button"
                        onClick={() => selecionar(p)}
                        disabled={!!sel}
                        className={`text-left px-2 py-2 rounded-lg border transition ${
                          sel
                            ? 'bg-emerald-50 border-emerald-400 cursor-default'
                            : 'bg-white border-slate-200 hover:border-violet-400 hover:bg-violet-50'
                        }`}
                      >
                        <div className="mb-1 flex justify-center">
                          <ProductPhoto refSku={p.ref} cor={p.cor} size={64} editable />
                        </div>
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs font-bold text-slate-700">{p.cor}</span>
                          <span className="text-xs font-black font-mono bg-slate-100 px-1.5 py-0.5 rounded">
                            {p.tamanho}
                          </span>
                        </div>
                        <div className="text-[10px] font-mono text-slate-500 mt-0.5">{p.codigo}</div>
                        <div className="text-xs font-bold text-emerald-700 mt-0.5">{brl(p.preco)}</div>
                        {sel && (
                          <div className="text-[10px] text-emerald-700 font-bold mt-1">
                            ✓ Selecionado
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
        )}

        {busca.length >= 2 && !loading && resultados.length === 0 && (
          <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center text-slate-500">
            <Package className="w-12 h-12 text-slate-300 mx-auto mb-2" />
            Nenhum produto encontrado pra "<b>{busca}</b>"
          </div>
        )}

        {/* Selecionados */}
        {selecionados.length > 0 && (
          <section className="bg-violet-50 border-2 border-violet-300 rounded-2xl p-4 sticky bottom-4 shadow-lg">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-black text-violet-800 uppercase tracking-wider">
                {selecionados.length} produto(s) selecionado(s) ·{' '}
                <b>{selecionados.reduce((s, i) => s + i.qty, 0)}</b> peças total
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => confirmar(true)}
                  disabled={confirmando}
                  className="flex items-center gap-2 px-4 py-2.5 bg-white hover:bg-slate-50 border-2 border-violet-300 text-violet-700 font-bold text-sm rounded-lg shadow-sm disabled:opacity-40"
                  title="Gera etiquetas SEM mexer no estoque (reimpressão)"
                >
                  <Printer className="w-4 h-4" />
                  Só etiqueta
                </button>
                <button
                  onClick={() => confirmar(false)}
                  disabled={confirmando}
                  className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-lg shadow-md disabled:opacity-40"
                  title="Adiciona ao estoque + gera etiquetas"
                >
                  {confirmando ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  Confirmar reposição
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {selecionados.map((s) => (
                <div key={s.codigo} className="bg-white border border-violet-200 rounded-lg p-2 flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-black text-violet-700 text-sm">{s.ref}</span>
                      <span className="text-xs font-bold text-slate-700">{s.cor}</span>
                      <span className="text-xs font-black bg-slate-100 px-1.5 py-0.5 rounded font-mono">{s.tamanho}</span>
                    </div>
                    <div className="text-[10px] font-mono text-slate-500">{s.codigo}</div>
                  </div>
                  <input
                    type="number"
                    min="0"
                    value={s.qty}
                    onChange={(e) => setQty(s.codigo, Number(e.target.value))}
                    className="w-16 px-2 py-1.5 border-2 border-violet-300 rounded text-center font-mono font-black text-violet-700"
                  />
                  <button
                    onClick={() => removerSel(s.codigo)}
                    className="p-1.5 hover:bg-rose-50 text-rose-500 rounded"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Resultado da confirmacao */}
        {resultado && (
          <section className={`rounded-2xl p-4 border-2 ${
            resultado.ok
              ? 'bg-emerald-50 border-emerald-300'
              : 'bg-amber-50 border-amber-300'
          }`}>
            <div className="font-black text-lg mb-2">
              {resultado.ok ? '✅ Reposição confirmada!' : '⚠ Reposição parcial'}
            </div>
            <div className="text-sm">
              <b>{resultado.total}</b> etiqueta(s) geradas. Click em "Imprimir etiquetas" no topo.
            </div>
          </section>
        )}
      </main>

      {/* Etiquetas (visiveis na impressao) — componente compartilhado */}
      {resultado && resultado.labels && (
        <EtiquetaPrint labels={resultado.labels} config={etiquetaCfg} />
      )}

    </div>
  );
}
