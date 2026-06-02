'use client';

/**
 * /loja/etiquetas-avulsas — Imprimir etiquetas avulsas a partir de SKUs/REFs/EANs.
 *
 * Como funciona:
 *  1. Vendedora cola/digita lista de códigos (1 por linha) — pode ser EAN, REF ou SKU
 *  2. Sistema busca no Wincred (tabela produtos)
 *  3. Mostra preview das etiquetas que serão impressas
 *  4. Botão imprimir reusa o mesmo layout 50x30mm rolo 108mm
 *
 * Útil pra:
 *  - Etiquetar peças que vieram sem etiqueta
 *  - Reimprimir etiqueta danificada
 *  - Atualizar preço (gerar etiqueta nova com preço novo)
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Printer, Search, Loader2, AlertCircle, Tags, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import EtiquetaPrint from '@/components/EtiquetaPrint';

type Label = {
  ref: string;
  cor: string;
  tamanho: string;
  codigo: string;
  preco: number;
  marca: string | null;
  descricao: string;
};

export default function EtiquetasAvulsasPage() {
  const [input, setInput] = useState('');
  const [labels, setLabels] = useState<Label[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState<string[]>([]);
  // Qty pra IMPRIMIR de cada SKU (key = codigo). Default 1.
  const [qty, setQty] = useState<Record<string, number>>({});

  // Carrega JsBarcode via CDN
  useEffect(() => {
    if (labels.length === 0) return;
    const render = () => {
      // @ts-expect-error JsBarcode global
      if (!window.JsBarcode) return;
      document.querySelectorAll<HTMLElement>('.barcode-target').forEach((el) => {
        const code = el.dataset.code || '';
        if (!code) return;
        try {
          // @ts-expect-error
          window.JsBarcode(el, code, {
            format: 'EAN13',
            width: 2.2,
            height: 40,
            displayValue: true,
            fontSize: 22,
            fontOptions: 'bold',
            textMargin: 1,
            margin: 0,
            background: '#fff',
            lineColor: '#000',
          });
        } catch {
          try {
            // @ts-expect-error
            window.JsBarcode(el, code, {
              format: 'CODE128',
              width: 2.2,
              height: 40,
              displayValue: true,
              fontSize: 22,
              fontOptions: 'bold',
              textMargin: 1,
              margin: 0,
            });
          } catch { /* ignore */ }
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
  }, [labels]);

  const buscar = async () => {
    const codigos = input
      .split(/[\s,;\n]+/)
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    if (codigos.length === 0) {
      setError('Cole ou digite os códigos (1 por linha)');
      return;
    }
    setLoading(true);
    setError(null);
    setNotFound([]);
    try {
      const r = await api<{ labels: Label[]; notFound: string[] }>(
        `/purchase-orders/etiquetas-avulsas`,
        {
          method: 'POST',
          body: JSON.stringify({ codigos }),
        },
      );
      setLabels(r.labels || []);
      setNotFound(r.notFound || []);
      // Inicializa qty = 1 pra cada label encontrado (vendedora pode editar)
      const initialQty: Record<string, number> = {};
      for (const l of (r.labels || [])) initialQty[l.codigo] = 1;
      setQty(initialQty);
    } catch (e: any) {
      setError(e?.message || 'Erro ao buscar');
    } finally {
      setLoading(false);
    }
  };

  const imprimir = () => window.print();

  const limpar = () => {
    setInput('');
    setLabels([]);
    setNotFound([]);
    setError(null);
    setQty({});
  };

  /** Expande labels segundo qty escolhido — cada label vira N cópias pra imprimir */
  const labelsExpandidos = labels.flatMap((l) => {
    const n = Math.max(1, Math.min(999, Number(qty[l.codigo] || 1)));
    return Array.from({ length: n }, () => l);
  });
  const totalEtiquetas = labelsExpandidos.length;

  /** Aplica MESMA qty em TODOS os produtos (botão rápido) */
  const aplicarQtyTodos = (n: number) => {
    const next: Record<string, number> = {};
    for (const l of labels) next[l.codigo] = Math.max(0, n);
    setQty(next);
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 print:hidden">
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/loja" className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-amber-500 flex items-center justify-center">
            <Tags className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-black text-slate-800">Etiquetas Avulsas</h1>
            <p className="text-xs text-slate-500">Imprimir por REF, SKU ou EAN — útil pra reposição</p>
          </div>
          {labels.length > 0 && (
            <>
              <button
                onClick={limpar}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold text-sm rounded-lg"
              >
                <Trash2 className="w-4 h-4" />
                Limpar
              </button>
              <button
                onClick={imprimir}
                disabled={totalEtiquetas === 0}
                className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm rounded-lg shadow-md disabled:opacity-40"
              >
                <Printer className="w-4 h-4" />
                Imprimir {totalEtiquetas}
              </button>
            </>
          )}
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto p-4 print:p-0 print:max-w-full">
        {/* Input de códigos */}
        <section className="bg-white border border-slate-200 rounded-2xl p-4 mb-4 print:hidden">
          <label className="text-xs font-bold text-slate-600 uppercase mb-2 block">
            Cole ou digite os códigos (REF, SKU ou EAN — 1 por linha)
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={'Ex:\n8000000000019\n7031\nBMM-006'}
            rows={6}
            className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
          />
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={buscar}
              disabled={loading || !input.trim()}
              className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-lg shadow-md disabled:opacity-40"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Buscar produtos
            </button>
            <div className="text-xs text-slate-500">
              {input.split(/[\s,;\n]+/).filter(Boolean).length} código(s)
            </div>
          </div>

          {error && (
            <div className="mt-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg p-2 text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}

          {notFound.length > 0 && (
            <div className="mt-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-2 text-xs">
              <b>{notFound.length} código(s) não encontrado(s):</b> {notFound.join(', ')}
            </div>
          )}
        </section>

        {/* Tabela de QTY por produto — vendedora escolhe quantas etiquetas de CADA */}
        {labels.length > 0 && (
          <section className="bg-white border border-slate-200 rounded-2xl p-4 mb-4 print:hidden">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div>
                <h2 className="text-sm font-black text-slate-800">
                  Quantidade a imprimir de cada peça
                </h2>
                <p className="text-xs text-slate-500">
                  Default 1 por peça. Ajuste se precisar mais (ex: 5 cópias da mesma cor+tamanho).
                </p>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-slate-500 uppercase font-bold mr-1">Aplicar em todas:</span>
                {[1, 2, 3, 5, 10].map((n) => (
                  <button
                    key={n}
                    onClick={() => aplicarQtyTodos(n)}
                    className="px-2 py-1 bg-slate-100 hover:bg-violet-100 hover:text-violet-700 text-slate-700 font-bold rounded text-xs"
                  >
                    {n}
                  </button>
                ))}
                <button
                  onClick={() => aplicarQtyTodos(0)}
                  className="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold rounded text-xs ml-1"
                  title="Zera tudo"
                >
                  zerar
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-[10px] uppercase text-slate-600">
                  <tr>
                    <th className="text-left px-2 py-1.5">REF</th>
                    <th className="text-left px-2 py-1.5">Cor</th>
                    <th className="text-center px-2 py-1.5">Tam</th>
                    <th className="text-left px-2 py-1.5">Descrição</th>
                    <th className="text-right px-2 py-1.5">Preço</th>
                    <th className="text-center px-2 py-1.5 w-32">Qty a imprimir</th>
                  </tr>
                </thead>
                <tbody>
                  {labels.map((l) => (
                    <tr key={l.codigo} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-2 py-1 font-mono font-bold text-violet-700">{l.ref}</td>
                      <td className="px-2 py-1 font-bold text-amber-700">{l.cor}</td>
                      <td className="px-2 py-1 text-center font-mono text-slate-700">{l.tamanho}</td>
                      <td className="px-2 py-1 text-xs text-slate-600 truncate max-w-[260px]" title={l.descricao}>
                        {l.descricao}
                      </td>
                      <td className="px-2 py-1 text-right font-bold text-emerald-700 tabular-nums">
                        R$ {Number(l.preco || 0).toFixed(2).replace('.', ',')}
                      </td>
                      <td className="px-2 py-1">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => setQty((prev) => ({
                              ...prev,
                              [l.codigo]: Math.max(0, (Number(prev[l.codigo]) || 0) - 1),
                            }))}
                            className="w-6 h-6 bg-slate-100 hover:bg-slate-200 rounded font-bold text-slate-700"
                          >
                            −
                          </button>
                          <input
                            value={qty[l.codigo] ?? 1}
                            onChange={(e) => {
                              const v = Math.max(0, Math.min(999, Number(e.target.value.replace(/\D/g, '')) || 0));
                              setQty((prev) => ({ ...prev, [l.codigo]: v }));
                            }}
                            inputMode="numeric"
                            className="w-14 px-1 py-1 border rounded text-center font-mono font-bold text-sm"
                          />
                          <button
                            onClick={() => setQty((prev) => ({
                              ...prev,
                              [l.codigo]: Math.min(999, (Number(prev[l.codigo]) || 0) + 1),
                            }))}
                            className="w-6 h-6 bg-slate-100 hover:bg-slate-200 rounded font-bold text-slate-700"
                          >
                            +
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-violet-50 font-bold">
                  <tr>
                    <td colSpan={5} className="px-2 py-2 text-right text-violet-900">
                      Total de etiquetas a imprimir:
                    </td>
                    <td className="px-2 py-2 text-center text-violet-900 tabular-nums text-base">
                      {totalEtiquetas}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        )}

        {/* Preview de impressão */}
        {labels.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center text-slate-500 print:hidden">
            <Tags className="w-12 h-12 text-slate-300 mx-auto mb-2" />
            <div className="text-sm">Os produtos encontrados aparecerão aqui</div>
          </div>
        ) : totalEtiquetas === 0 ? (
          <div className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-6 text-center text-amber-900 print:hidden">
            <div className="font-bold">Defina a quantidade de pelo menos 1 peça acima pra imprimir</div>
          </div>
        ) : (
          <EtiquetaPrint labels={labelsExpandidos.map(l => ({ ...l, descricao: l.descricao || '' }))} />
        )}
      </main>

    </div>
  );
}
