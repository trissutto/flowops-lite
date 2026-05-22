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

  // Carrega JsBarcode pra labels (mesmo padrao das outras telas)
  useEffect(() => {
    if (!resultado || resultado.labels.length === 0) return;
    const render = () => {
      // @ts-expect-error
      if (!window.JsBarcode) return;
      document.querySelectorAll<HTMLElement>('.barcode-target').forEach((el) => {
        const code = el.dataset.code || '';
        if (!code) return;
        try {
          // @ts-expect-error
          window.JsBarcode(el, code, {
            format: 'EAN13', width: 2.6, height: 50, displayValue: true,
            fontSize: 26, fontOptions: 'bold', textMargin: 1, margin: 0,
            background: '#fff', lineColor: '#000',
          });
          el.setAttribute('preserveAspectRatio', 'none');
          el.removeAttribute('width');
        } catch {
          try {
            // @ts-expect-error
            window.JsBarcode(el, code, {
              format: 'CODE128', width: 2.6, height: 50, displayValue: true,
              fontSize: 26, fontOptions: 'bold', textMargin: 1, margin: 0,
            });
            el.setAttribute('preserveAspectRatio', 'none');
            el.removeAttribute('width');
          } catch { /* skip */ }
        }
      });
    };
    // @ts-expect-error
    if (window.JsBarcode) {
      render();
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js';
    s.onload = render;
    document.head.appendChild(s);
  }, [resultado]);

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

  const confirmar = async () => {
    const validos = selecionados.filter((s) => s.qty > 0);
    if (validos.length === 0) {
      alert('Informe a qty de pelo menos um produto');
      return;
    }
    if (!confirm(`Confirmar reposicao de ${validos.length} SKU(s)? Vai adicionar no estoque Wincred e gerar etiquetas.`)) return;
    setConfirmando(true);
    try {
      const r = await api<{ ok: boolean; total: number; labels: Label[] }>(
        `/purchase-orders/reposicao/confirmar`,
        {
          method: 'POST',
          body: JSON.stringify({
            items: validos.map((s) => ({ codigo: s.codigo, qty: s.qty })),
          }),
        },
      );
      setResultado(r);
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
            <button
              onClick={imprimir}
              className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm rounded-lg shadow-md"
            >
              <Printer className="w-4 h-4" />
              Imprimir {resultado.labels.length} etiquetas
            </button>
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
              <button
                onClick={confirmar}
                disabled={confirmando}
                className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-lg shadow-md disabled:opacity-40"
              >
                {confirmando ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Confirmar reposição
              </button>
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

      {/* Etiquetas (visiveis na impressao) */}
      {resultado && resultado.labels.length > 0 && (
        <main className="hidden print:block">
          <div className="etiquetas-grid">
            {resultado.labels.map((l, i) => (
              <div key={`${l.codigo}-${i}`} className="etiqueta">
                <div className="et-descricao">{
                  l.descricao
                    .replace(new RegExp(`\\b${l.ref}\\b`, 'g'), '')
                    .replace(new RegExp(`\\b${l.cor}\\b`, 'g'), '')
                    .replace(new RegExp(`\\b${l.tamanho}\\b`, 'g'), '')
                    .replace(/\s+/g, ' ')
                    .trim()
                }</div>
                <div className="et-destaque">
                  <span className="et-tam">{l.ref}</span>
                  <span className="et-cor-destaque">{l.tamanho}</span>
                </div>
                <svg className="barcode-target" data-code={l.codigo} />
                <div className="et-base">
                  <span className="et-base-ref">{l.cor}</span>
                  <span className="et-base-preco">R$ {l.preco.toFixed(2).replace('.', ',')}</span>
                </div>
              </div>
            ))}
          </div>
        </main>
      )}

      <style jsx global>{`
        .etiquetas-grid {
          display: grid;
          grid-template-columns: 48mm 48mm;
          gap: 0 6mm;
          padding: 10mm 0 0 6mm;
          width: 108mm;
          margin: 0 auto;
          background: #fff;
        }
        .etiqueta {
          width: 48mm; height: 30mm;
          box-sizing: border-box;
          padding: 2mm 1.5mm 1mm 1.5mm;
          display: flex; flex-direction: column;
          justify-content: space-between;
          gap: 0.8mm;
          border: 1px dashed #cbd5e1;
          background: #fff; color: #000;
          font-family: -apple-system, system-ui, sans-serif;
          overflow: hidden;
        }
        .et-descricao {
          font-size: 7pt; font-weight: 900;
          text-transform: uppercase;
          line-height: 1.05; letter-spacing: 0.1px;
          display: -webkit-box;
          -webkit-line-clamp: 2; -webkit-box-orient: vertical;
          overflow: hidden; max-height: 6mm;
        }
        .et-destaque {
          display: flex; align-items: center;
          gap: 1.5mm; line-height: 1;
        }
        .et-tam {
          font-size: 12pt; font-weight: 900;
          font-family: 'Courier New', monospace;
          border: 1.5px solid #000;
          padding: 0 1.2mm; line-height: 1.1;
        }
        .et-cor-destaque {
          font-size: 18pt; font-weight: 900;
          font-family: 'Courier New', monospace;
          text-transform: uppercase;
          border: 2px solid #000;
          padding: 0.5mm 2mm; line-height: 1.05;
          margin-left: auto;
        }
        .barcode-target {
          width: 75%; height: 16mm;
          display: block; margin: 0 auto;
        }
        .et-base {
          display: flex; justify-content: space-between;
          align-items: baseline; line-height: 1;
          border-top: 0.5px solid #cbd5e1;
          padding-top: 0.5mm; min-width: 0; gap: 1mm;
        }
        .et-base-ref {
          font-weight: 900; letter-spacing: 0.2px;
          text-transform: uppercase;
          flex: 1 1 auto; min-width: 0;
          white-space: nowrap; padding-right: 1mm;
          line-height: 1.1; font-size: 11pt;
        }
        .et-base-preco {
          font-size: 11pt; font-weight: 900;
          flex-shrink: 0;
        }
        @media print {
          body { background: white !important; margin: 0 !important; padding: 0 !important; }
          @page { size: 108mm auto; margin: 0; }
          .etiqueta { border: none !important; page-break-inside: avoid; }
        }
      `}</style>
    </div>
  );
}
