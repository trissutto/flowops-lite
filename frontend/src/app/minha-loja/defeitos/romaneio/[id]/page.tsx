'use client';

/**
 * /minha-loja/defeitos/romaneio/[id] — a folha que vai colada por fora da
 * caixa de defeitos.
 *
 * Serve pra matriz conferir sem abrir sistema: código da caixa, loja, data e
 * a lista das peças com o número de controle de cada uma. Quem bipa na
 * chegada compara com esta lista.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Printer, Loader2, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';

/**
 * Renderiza os códigos de barras da lista (mesmo JsBarcode do EtiquetaPrint).
 *
 * Existe porque peça pode chegar na matriz SEM ETIQUETA (acontece): com as
 * barras impressas no romaneio, quem confere bipa direto do papel em vez de
 * digitar código a código.
 */
function useBarcodes(dependencia: unknown) {
  useEffect(() => {
    const render = () => {
      // @ts-expect-error JsBarcode global injetado via CDN
      if (typeof window === 'undefined' || !window.JsBarcode) return;
      document.querySelectorAll<HTMLElement>('.romaneio-barcode').forEach((el) => {
        const code = el.dataset.code || '';
        if (!code) return;
        try {
          // @ts-expect-error JsBarcode global
          window.JsBarcode(el, code, {
            format: 'CODE128',
            width: 1.1,
            height: 26,
            displayValue: false,
            margin: 0,
          });
        } catch { /* código fora do padrão — a coluna do número resolve */ }
      });
    };
    // @ts-expect-error JsBarcode global
    if (window.JsBarcode) { render(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js';
    s.onload = render;
    document.head.appendChild(s);
  }, [dependencia]);
}

type Item = {
  code: string;
  sku: string;
  ref: string | null;
  cor: string | null;
  tamanho: string | null;
  marca: string | null;
  motivo: string;
  observacao: string | null;
  custoUnitCents: number;
};

type Caixa = {
  code: string;
  storeCodeOrigem: string;
  storeNameOrigem: string | null;
  status: string;
  totalPecas: number;
  totalCustoCents: number;
  fechadaAt: string | null;
  createdAt: string;
};

const brl = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const rotuloMotivo = (m: string) =>
  m.split('_').map((p) => p.charAt(0) + p.slice(1).toLowerCase()).join(' ');

export default function RomaneioDefeitosPage() {
  const params = useParams();
  const id = params?.id as string;
  const [caixa, setCaixa] = useState<Caixa | null>(null);
  const [itens, setItens] = useState<Item[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  useBarcodes(itens);

  useEffect(() => {
    if (!id) return;
    api<{ caixa: Caixa; itens: Item[] }>(`/defeitos/caixas/${id}/romaneio`)
      .then((r) => { setCaixa(r.caixa); setItens(r.itens || []); })
      .catch((e) => setErro(e?.message || 'Erro ao carregar'));
  }, [id]);

  if (erro) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="bg-rose-50 border border-rose-300 text-rose-700 rounded-lg p-6 text-center">
          <AlertCircle className="w-8 h-8 mx-auto mb-2" />
          <div className="font-bold">{erro}</div>
        </div>
      </div>
    );
  }
  if (!caixa) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-7 h-7 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 print:hidden">
        <div className="max-w-[820px] mx-auto px-4 py-3 flex items-center gap-3">
          <div className="flex-1">
            <h1 className="text-lg font-black">Romaneio da caixa {caixa.code}</h1>
            <p className="text-xs text-slate-500">Cole esta folha por fora da caixa</p>
          </div>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 px-5 py-2.5 bg-slate-800 hover:bg-slate-900 text-white font-bold text-sm rounded-lg"
          >
            <Printer className="w-4 h-4" />
            Imprimir
          </button>
        </div>
      </header>

      <main className="max-w-[820px] mx-auto p-6 print:p-0">
        <div className="print-doc bg-white p-6 print:p-0 rounded-lg print:rounded-none">
          <div className="border-b-2 border-slate-800 pb-3 mb-4 flex items-start justify-between gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500">
                Caixa de peças com defeito
              </div>
              <div className="text-3xl font-black text-slate-800">{caixa.code}</div>
              <div className="text-sm text-slate-600">
                Origem: <b>{caixa.storeNameOrigem || `Loja ${caixa.storeCodeOrigem}`}</b>
              </div>
            </div>
            <div className="text-right text-xs">
              <div className="text-slate-600">
                Fechada em{' '}
                <b>
                  {new Date(caixa.fechadaAt || caixa.createdAt).toLocaleString('pt-BR')}
                </b>
              </div>
              <div className="text-slate-600">
                <b>{itens.length}</b> peça{itens.length === 1 ? '' : 's'}
              </div>
              <div className="text-slate-600">Custo total: <b>{brl(caixa.totalCustoCents)}</b></div>
            </div>
          </div>

          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-slate-100">
                <th className="text-left p-2 border-b border-slate-300">Controle</th>
                <th className="text-left p-2 border-b border-slate-300">Código de barras</th>
                <th className="text-left p-2 border-b border-slate-300">REF · Cor · Tam</th>
                <th className="text-left p-2 border-b border-slate-300">Marca</th>
                <th className="text-left p-2 border-b border-slate-300">Defeito</th>
                <th className="text-center p-2 border-b border-slate-300 w-10">OK</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((it) => (
                <tr key={it.code} className="border-b border-slate-100">
                  <td className="p-2 font-mono font-bold">{it.code}</td>
                  {/* Barras + número: a matriz bipa do papel quando a peça
                      chega sem etiqueta, e o número cobre o caso do leitor
                      não pegar (papel amassado, impressão fraca). */}
                  <td className="p-2">
                    <svg className="romaneio-barcode block" data-code={it.sku} />
                    <span className="font-mono text-[10px] tracking-wide">{it.sku}</span>
                  </td>
                  <td className="p-2 font-bold">
                    {it.ref || it.sku} {it.cor} {it.tamanho}
                  </td>
                  <td className="p-2">{it.marca || '—'}</td>
                  <td className="p-2">
                    {rotuloMotivo(it.motivo)}
                    {it.observacao ? <span className="text-slate-500"> · {it.observacao}</span> : ''}
                  </td>
                  {/* Quadradinho pra matriz marcar a caneta enquanto confere */}
                  <td className="p-2 text-center">
                    <span className="inline-block w-4 h-4 border border-slate-400" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-8 grid grid-cols-2 gap-8 text-xs">
            <div className="border-t border-slate-400 pt-1 text-center">Conferido na loja</div>
            <div className="border-t border-slate-400 pt-1 text-center">Recebido na matriz</div>
          </div>
        </div>
      </main>

      <style jsx global>{`
        @media print {
          body { background: white !important; margin: 0; }
          /* Margem lateral folgada + leve redução: a impressora da loja tem
             área não-imprimível maior que 10mm e comia as colunas das pontas
             (mesmo ajuste feito no pedido de compra em 11/08). */
          @page { size: A4 portrait; margin: 10mm 14mm; }
          .print-doc { zoom: 0.95; }
        }
      `}</style>
    </div>
  );
}
