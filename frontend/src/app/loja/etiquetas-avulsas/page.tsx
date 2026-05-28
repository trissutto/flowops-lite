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
                className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm rounded-lg shadow-md"
              >
                <Printer className="w-4 h-4" />
                Imprimir {labels.length}
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

        {/* Preview */}
        {labels.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center text-slate-500 print:hidden">
            <Tags className="w-12 h-12 text-slate-300 mx-auto mb-2" />
            <div className="text-sm">Os produtos encontrados aparecerão aqui</div>
          </div>
        ) : (
          <EtiquetaPrint labels={labels.map(l => ({ ...l, descricao: l.descricao || '' }))} />
        )}
      </main>

    </div>
  );
}
