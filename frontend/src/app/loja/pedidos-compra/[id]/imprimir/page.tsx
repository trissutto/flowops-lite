'use client';

/**
 * /loja/pedidos-compra/[id]/imprimir — Versão imprimível do pedido (conferência / PDF).
 *
 * Layout A4 portrait, otimizado pra impressão. Vendedora abre, confere, e
 * salva como PDF via Ctrl+P → "Salvar como PDF" (ou imprime fisico).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Printer, Loader2, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';

type Order = {
  id: string;
  numero: number;
  fornecedorNome: string;
  fornecedorCnpj: string | null;
  marca: string | null;
  dataPedido: string;
  dataPrevista: string | null;
  nfNumero: string | null;
  observacoes: string | null;
  status: string;
  totalPecas: number;
  totalCusto: number;
  totalVenda: number;
  recebidoAt: string | null;
  items: Array<{
    id: string;
    ref: string;
    descricaoBase: string;
    cor: string;
    grupoNome: string | null;
    subgrupoNome: string | null;
    ncm: string | null;
    plusSize: boolean;
    custoUnit: number;
    precoUnit: number;
    tributoPct: number;
    descontoPct?: number;
    tamanhosQty: Record<string, number>;
    tamanhosQtyRecebida: Record<string, number> | null;
  }>;
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function PedidoImprimirPage() {
  const params = useParams();
  const id = params?.id as string;
  const [data, setData] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<Order>(`/purchase-orders/${id}`)
      .then(setData)
      .catch((e) => setError(e?.message || 'Erro'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-violet-600" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="bg-rose-50 border border-rose-300 text-rose-700 rounded-lg p-6 max-w-md text-center">
          <AlertCircle className="w-10 h-10 mx-auto mb-2" />
          <div className="font-bold">{error || 'Pedido não encontrado'}</div>
        </div>
      </div>
    );
  }

  const isRecebido = data.status === 'recebido' || data.status === 'recebido_com_erro';

  // Calcula financeiro
  let totalPecas = 0;
  let precoBruto = 0;
  let descontoTotal = 0;
  let impostoTotal = 0;
  for (const it of data.items as any[]) {
    const qtyMap = (isRecebido && it.tamanhosQtyRecebida) ? it.tamanhosQtyRecebida : it.tamanhosQty;
    let qty = 0;
    for (const k of Object.keys(qtyMap || {})) qty += Number(qtyMap[k] || 0);
    totalPecas += qty;
    const custoUnit = Number(it.custoUnit || 0);
    const bruto = custoUnit * qty;
    precoBruto += bruto;
    const descPct = Number(it.descontoPct || 0);
    const tribPct = Number(it.tributoPct || 0);
    descontoTotal += bruto * (descPct / 100);
    impostoTotal += bruto * (1 - descPct / 100) * (tribPct / 100);
  }
  const precoLiquido = precoBruto - descontoTotal;
  const totalPedido = precoLiquido + impostoTotal;

  // Agrupa items por REF
  const itemsPorRef = new Map<string, typeof data.items>();
  for (const it of data.items) {
    if (!itemsPorRef.has(it.ref)) itemsPorRef.set(it.ref, []);
    itemsPorRef.get(it.ref)!.push(it);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Toolbar (escondida na impressão) */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 print:hidden">
        <div className="max-w-[900px] mx-auto px-4 py-3 flex items-center gap-3">
          <Link href={`/loja/pedidos-compra/${id}`} className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="text-lg font-black">Imprimir pedido #{data.numero}</h1>
            <p className="text-xs text-slate-500">Ctrl+P para salvar como PDF</p>
          </div>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm rounded-lg shadow-md"
          >
            <Printer className="w-4 h-4" />
            Imprimir / PDF
          </button>
        </div>
      </header>

      {/* Conteúdo imprimível */}
      <main className="max-w-[900px] mx-auto p-6 print:p-0 print:max-w-full">
        <div className="bg-white print:bg-transparent p-6 print:p-0 rounded-lg print:rounded-none">

          {/* Cabeçalho do documento */}
          <div className="border-b-2 border-slate-800 pb-3 mb-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-slate-500">Pedido de Compra</div>
                <div className="text-3xl font-black text-slate-800">#{data.numero}</div>
              </div>
              <div className="text-right text-xs">
                <div className="font-bold text-slate-800">Status: <span className="uppercase">{data.status.replace('_', ' ')}</span></div>
                <div className="text-slate-600">Emitido em {new Date(data.dataPedido).toLocaleDateString('pt-BR')}</div>
                {data.dataPrevista && (
                  <div className="text-slate-600">Entrega prevista: <b>{new Date(data.dataPrevista).toLocaleDateString('pt-BR')}</b></div>
                )}
                {isRecebido && data.recebidoAt && (
                  <div className="text-emerald-700 font-bold">Recebido em {new Date(data.recebidoAt).toLocaleString('pt-BR')}</div>
                )}
              </div>
            </div>
          </div>

          {/* Fornecedor / NF */}
          <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
            <div className="border border-slate-300 rounded p-3">
              <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mb-1">Fornecedor</div>
              <div className="font-black text-slate-800">{data.fornecedorNome}</div>
              {data.fornecedorCnpj && <div className="text-xs text-slate-600">CNPJ: {data.fornecedorCnpj}</div>}
              {data.marca && <div className="text-xs text-slate-600">Marca: <b>{data.marca}</b></div>}
            </div>
            <div className="border border-slate-300 rounded p-3">
              <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mb-1">Nota Fiscal</div>
              <div className="font-black text-slate-800">{data.nfNumero || '—'}</div>
              {data.observacoes && (
                <div className="text-xs text-slate-600 mt-1">
                  <b>Obs:</b> {data.observacoes}
                </div>
              )}
            </div>
          </div>

          {/* FINANCEIRO */}
          <div className="border border-slate-300 rounded p-3 mb-4">
            <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mb-2">Resumo Financeiro</div>
            <table className="w-full text-sm">
              <tbody>
                <tr>
                  <td className="py-1 text-slate-600">Total de peças</td>
                  <td className="py-1 text-right font-bold tabular-nums">{totalPecas}</td>
                  <td className="py-1 pl-6 text-slate-600">Custo médio/peça</td>
                  <td className="py-1 text-right font-bold tabular-nums">{totalPecas > 0 ? brl(totalPedido / totalPecas) : '—'}</td>
                </tr>
                <tr>
                  <td className="py-1 text-slate-600">Preço bruto</td>
                  <td className="py-1 text-right tabular-nums">{brl(precoBruto)}</td>
                  <td className="py-1 pl-6 text-slate-600">- Desconto</td>
                  <td className="py-1 text-right text-rose-700 tabular-nums">{brl(descontoTotal)}</td>
                </tr>
                <tr>
                  <td className="py-1 text-slate-600">Preço líquido</td>
                  <td className="py-1 text-right tabular-nums">{brl(precoLiquido)}</td>
                  <td className="py-1 pl-6 text-slate-600">+ Impostos</td>
                  <td className="py-1 text-right text-amber-700 tabular-nums">{brl(impostoTotal)}</td>
                </tr>
                <tr className="border-t-2 border-slate-800">
                  <td className="pt-2 font-black uppercase text-sm">TOTAL DO PEDIDO</td>
                  <td className="pt-2"></td>
                  <td className="pt-2"></td>
                  <td className="pt-2 text-right font-black text-base text-emerald-700 tabular-nums">{brl(totalPedido)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* ITENS DETALHADOS */}
          <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mb-1">Itens do pedido</div>
          {Array.from(itemsPorRef.entries()).map(([ref, refItems]) => {
            const primeiro = refItems[0];
            const todosTamanhos = new Set<string>();
            for (const it of refItems) for (const t of Object.keys(it.tamanhosQty || {})) todosTamanhos.add(t);
            const tamOrdenados = Array.from(todosTamanhos).sort((a, b) => Number(a) - Number(b));
            return (
              <div key={ref} className="border border-slate-300 rounded mb-2 print:break-inside-avoid">
                <div className="bg-slate-100 px-3 py-1.5 border-b border-slate-300 flex items-center gap-3 text-xs">
                  <span className="font-black font-mono text-violet-700">{ref}</span>
                  <span className="font-bold">{primeiro.descricaoBase}</span>
                  <span className="text-slate-500">
                    {primeiro.grupoNome}/{primeiro.subgrupoNome}
                    {primeiro.plusSize && ' · PLUS'}
                  </span>
                  <span className="ml-auto">
                    Custo {brl(primeiro.custoUnit)} · Venda <b className="text-emerald-700">{brl(primeiro.precoUnit)}</b>
                  </span>
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50">
                      <th className="text-left p-1 border-b border-slate-200">Cor</th>
                      {tamOrdenados.map((t) => (
                        <th key={t} className="p-1 text-center font-mono text-violet-700 border-b border-slate-200">{t}</th>
                      ))}
                      <th className="p-1 text-center font-bold border-b border-slate-200">TOT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {refItems.map((it) => {
                      const qty = (isRecebido && it.tamanhosQtyRecebida) ? it.tamanhosQtyRecebida : it.tamanhosQty;
                      let total = 0;
                      for (const t of tamOrdenados) total += Number(qty[t] || 0);
                      return (
                        <tr key={it.id}>
                          <td className="p-1 font-bold text-amber-700">{it.cor}</td>
                          {tamOrdenados.map((t) => (
                            <td key={t} className="p-1 text-center tabular-nums">{qty[t] || '·'}</td>
                          ))}
                          <td className="p-1 text-center font-black text-violet-700 tabular-nums">{total}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}

          {/* Rodapé com assinatura */}
          <div className="mt-8 print:mt-12 grid grid-cols-2 gap-8 text-xs">
            <div>
              <div className="border-t border-slate-400 pt-1 text-center">Conferência (vendedora)</div>
            </div>
            <div>
              <div className="border-t border-slate-400 pt-1 text-center">Recebido por</div>
            </div>
          </div>
          <div className="text-center text-[9px] text-slate-400 mt-4">
            Pedido #{data.numero} · Impresso em {new Date().toLocaleString('pt-BR')}
          </div>
        </div>
      </main>

      <style jsx global>{`
        @media print {
          body { background: white !important; margin: 0; }
          @page { size: A4 portrait; margin: 10mm; }
        }
      `}</style>
    </div>
  );
}
