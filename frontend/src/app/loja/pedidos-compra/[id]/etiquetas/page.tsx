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

      <main className="max-w-[1400px] mx-auto p-4 print:p-0">
        {filtered.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-12 text-center text-slate-500">
            Nenhuma etiqueta pra imprimir.
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-1 print:gap-0">
            {filtered.map((l, i) => (
              <div
                key={`${l.codigo}-${i}`}
                className="bg-white border border-slate-300 rounded p-2 text-center print:border-slate-400 print:rounded-none"
                style={{ minHeight: '110px' }}
              >
                <div className="text-[10px] font-bold uppercase text-slate-600 truncate">
                  {l.marca || 'LURDS'}
                </div>
                <div className="text-base font-black text-slate-800 font-mono mt-1">
                  {l.ref}
                </div>
                <div className="text-xs text-slate-600">
                  <b>{l.cor}</b> · <b>{l.tamanho}</b>
                </div>
                <div className="text-[9px] font-mono text-slate-500 mt-1 truncate">
                  {l.codigo}
                </div>
                {/* Barras EAN-13 — representação visual simples (linhas verticais) */}
                <div className="flex justify-center mt-1 gap-px h-6">
                  {l.codigo.split('').map((d, idx) => (
                    <div
                      key={idx}
                      className="bg-black"
                      style={{ width: `${(Number(d) || 1) * 0.8}px`, height: '100%' }}
                    />
                  ))}
                </div>
                <div className="text-sm font-black text-emerald-700 mt-1">
                  R$ {l.preco.toFixed(2).replace('.', ',')}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      <style jsx global>{`
        @media print {
          body { background: white !important; }
          @page { size: A4 portrait; margin: 5mm; }
        }
      `}</style>
    </div>
  );
}
