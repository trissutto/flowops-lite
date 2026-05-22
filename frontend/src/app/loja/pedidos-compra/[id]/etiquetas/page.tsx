'use client';

/**
 * /loja/pedidos-compra/[id]/etiquetas — Imprime etiquetas (1 por peça).
 *
 * Layout: grid de etiquetas 50×30mm (5 colunas A4 portrait).
 * Cada etiqueta: REF · COR · TAM · EAN-13 · PREÇO
 * Botão "Imprimir" usa window.print() — CSS @media print esconde header.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Printer, Loader2, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';

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

export default function EtiquetasPage() {
  const params = useParams();
  const id = params?.id as string;

  const [labels, setLabels] = useState<Label[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterRef, setFilterRef] = useState('');

  useEffect(() => {
    if (!id) return;
    api<{ total: number; labels: Label[] }>(`/purchase-orders/${id}/labels`)
      .then((r) => setLabels(r.labels))
      .catch((e) => setError(e?.message || 'Erro'))
      .finally(() => setLoading(false));
  }, [id]);

  // Carrega JsBarcode via CDN e renderiza os barcodes quando as labels carregarem
  useEffect(() => {
    if (loading || labels.length === 0) return;
    const renderBarcodes = () => {
      // @ts-expect-error JsBarcode injetado via CDN
      if (typeof window === 'undefined' || !window.JsBarcode) return;
      document.querySelectorAll<HTMLElement>('.barcode-target').forEach((el) => {
        const code = el.dataset.code || '';
        if (!code) return;
        try {
          // @ts-expect-error JsBarcode global
          window.JsBarcode(el, code, {
            format: 'EAN13',
            width: 2.2,
            height: 40,
            displayValue: true,
            fontSize: 16,
            textMargin: 0,
            margin: 0,
            background: '#fff',
            lineColor: '#000',
          });
        } catch {
          // Se o codigo nao for EAN13 valido, usa CODE128 como fallback
          try {
            // @ts-expect-error
            window.JsBarcode(el, code, {
              format: 'CODE128',
              width: 2.2,
              height: 40,
              displayValue: true,
              fontSize: 16,
              textMargin: 0,
              margin: 0,
            });
          } catch { /* ignora */ }
        }
      });
    };
    // @ts-expect-error
    if (window.JsBarcode) {
      renderBarcodes();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js';
    script.onload = renderBarcodes;
    document.head.appendChild(script);
  }, [labels, loading, filterRef]);

  const filtered = filterRef.trim()
    ? labels.filter((l) => l.ref.includes(filterRef.trim().toUpperCase()))
    : labels;

  const imprimir = () => window.print();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-violet-600" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="bg-rose-50 border border-rose-300 text-rose-700 rounded-lg p-6 max-w-md text-center">
          <AlertCircle className="w-10 h-10 mx-auto mb-2" />
          <div className="font-bold">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 print:hidden">
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex items-center gap-3">
          <Link href={`/loja/pedidos-compra/${id}`} className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="text-lg font-black">Etiquetas</h1>
            <p className="text-xs text-slate-500">
              <b>{filtered.length}</b> etiquetas {filterRef && `(filtrado de ${labels.length})`}
            </p>
          </div>
          <input
            value={filterRef}
            onChange={(e) => setFilterRef(e.target.value.toUpperCase())}
            placeholder="Filtrar por REF"
            className="px-3 py-2 border rounded-lg text-sm w-40 font-mono uppercase"
          />
          <button
            onClick={imprimir}
            className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm rounded-lg shadow-md"
          >
            <Printer className="w-4 h-4" />
            Imprimir
          </button>
        </div>
      </header>

      <main className="max-w-[900px] mx-auto p-4 print:p-0 print:max-w-full">
        {filtered.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-12 text-center text-slate-500">
            Nenhuma etiqueta pra imprimir.
          </div>
        ) : (
          <div className="etiquetas-grid">
            {filtered.map((l, i) => (
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
        )}
      </main>

      <style jsx global>{`
        /* Grid de etiquetas: 2 colunas de 50mm em rolo de 108mm */
        .etiquetas-grid {
          display: grid;
          grid-template-columns: 48mm 48mm;
          gap: 0 6mm;
          padding: 9mm 0 0 6mm;
          width: 108mm;
          margin: 0 auto;
          background: #fff;
        }
        .etiqueta {
          width: 48mm;
          height: 30mm;
          box-sizing: border-box;
          padding: 2mm 1.5mm 1mm 1.5mm;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          gap: 0.8mm;
          border: 1px dashed #cbd5e1;
          background: #fff;
          font-family: -apple-system, system-ui, sans-serif;
          color: #000;
          overflow: hidden;
        }
        /* Descricao (sem REF/COR/TAM) - GRUPO + SUBGRUPO + PLUS SIZE + MARCA */
        .et-descricao {
          font-size: 6.5pt;
          font-weight: 700;
          text-transform: uppercase;
          line-height: 1.05;
          letter-spacing: 0;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          max-height: 5.5mm;
          flex-shrink: 0;
        }
        /* DESTAQUE: TAM + COR numa linha */
        .et-destaque {
          display: flex;
          align-items: center;
          gap: 1.5mm;
          line-height: 1;
        }
        .et-tam {
          font-size: 12pt;
          font-weight: 900;
          font-family: 'Courier New', monospace;
          border: 1.5px solid #000;
          padding: 0 1.2mm;
          line-height: 1.1;
        }
        .et-cor-destaque {
          font-size: 11pt;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-left: auto;
        }
        /* Codigo de barras EAN-13 (renderizado por JsBarcode) */
        .barcode-target {
          width: 100%;
          height: 12mm;
          display: block;
        }
        .et-codigo {
          font-size: 6pt;
          font-family: 'Courier New', monospace;
          text-align: center;
          letter-spacing: 1px;
          line-height: 1;
        }
        /* Base: COR (auto-ajustavel) + PRECO */
        .et-base {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          line-height: 1;
          border-top: 0.5px solid #cbd5e1;
          padding-top: 0.5mm;
          min-width: 0;
          gap: 1mm;
        }
        .et-base-ref {
          font-size: 11pt;
          font-weight: 900;
          letter-spacing: 0.2px;
          text-transform: uppercase;
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          padding-right: 1mm;
        }
        .et-base-preco {
          font-size: 11pt;
          font-weight: 900;
          flex-shrink: 0;
        }
        @media print {
          body { background: white !important; margin: 0 !important; padding: 0 !important; }
          @page {
            size: 108mm auto;
            margin: 0;
          }
          .etiquetas-grid {
            padding: 9mm 0 0 6mm;
            page-break-inside: auto;
          }
          .etiqueta {
            border: none !important;
            page-break-inside: avoid;
            break-inside: avoid;
          }
        }
      `}</style>
    </div>
  );
}
