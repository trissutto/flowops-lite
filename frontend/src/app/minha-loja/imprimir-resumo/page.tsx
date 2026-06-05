'use client';

/**
 * /minha-loja/imprimir-resumo
 *
 * Resumo consolidado dos pedidos pendentes (status new/separating) PRA PICKING
 * NO ESTOQUE. Substitui a impressão 1-a-1 quando vendedora precisa apenas saber
 * QUAIS peças tirar e pra qual cliente.
 *
 * Layout otimizado pra cupom térmico 80mm:
 *   - Cabeçalho com data + loja + total de pedidos
 *   - Bloco POR PEDIDO: Nº pedido + nome cliente + lista (REF cor tam qty)
 *   - Bloco final com TOTAL CONSOLIDADO (mesmo SKU em vários pedidos = soma)
 *   - Auto-impressão ao abrir + fecha sozinho (igual outros prints)
 */

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface OrderItem {
  sku: string;
  productName?: string | null;
  quantity: number;
}

interface PickOrderRow {
  id: string;
  status: string;
  order?: {
    wcOrderNumber?: string | null;
    customerName?: string | null;
    customerPhone?: string | null;
    items?: OrderItem[];
  };
}

export default function ImprimirResumoPage() {
  const [rows, setRows] = useState<PickOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [storeName, setStoreName] = useState<string>('');

  useEffect(() => {
    (async () => {
      try {
        const [data, me] = await Promise.all([
          api<PickOrderRow[]>('/pick-orders/mine'),
          api<any>('/auth/me').catch(() => ({})),
        ]);
        setStoreName(me?.storeName || me?.storeCode || '');
        // Só pedidos que ainda precisam separar
        const pendentes = (data || []).filter(
          (r) => r.status === 'new' || r.status === 'separating',
        );
        setRows(pendentes);
      } catch (e: any) {
        setError(e?.message || 'Erro ao carregar pedidos');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Auto-imprime quando termina de carregar (igual outras telas de print)
  useEffect(() => {
    if (loading || error || rows.length === 0) return;
    const timer = setTimeout(() => {
      window.print();
    }, 400);
    return () => clearTimeout(timer);
  }, [loading, error, rows.length]);

  // Calcula TOTAL CONSOLIDADO (mesmo SKU em vários pedidos = soma qty)
  // Cada linha mostra também QUAIS pedidos / clientes precisam dessa peça
  const totalConsolidado = (() => {
    const map = new Map<string, {
      sku: string; nome: string; qty: number;
      pedidos: { numero: string; cliente: string; qty: number }[];
    }>();
    for (const r of rows) {
      const o = r.order || {};
      const numero = o.wcOrderNumber ? `#${o.wcOrderNumber}` : `#${r.id.slice(0, 6)}`;
      const cliente = (o.customerName || 'S/nome').split(' ').slice(0, 2).join(' ');
      for (const it of (o.items || [])) {
        const key = it.sku;
        const prev = map.get(key);
        if (prev) {
          prev.qty += it.quantity;
          prev.pedidos.push({ numero, cliente, qty: it.quantity });
        } else {
          map.set(key, {
            sku: it.sku,
            nome: it.productName || it.sku,
            qty: it.quantity,
            pedidos: [{ numero, cliente, qty: it.quantity }],
          });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => a.sku.localeCompare(b.sku));
  })();

  const totalPecas = totalConsolidado.reduce((s, x: any) => s + x.qty, 0);
  const dataFmt = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  if (loading) {
    return (
      <div className="p-6 text-center">
        <p>Carregando pedidos...</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6 text-center text-red-700">
        <p>Erro: {error}</p>
        <button onClick={() => window.close()} className="mt-3 px-3 py-1 bg-slate-200 rounded">Fechar</button>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="p-6 text-center">
        <p className="font-bold">Nenhum pedido pendente</p>
        <button onClick={() => window.close()} className="mt-3 px-3 py-1 bg-slate-200 rounded">Fechar</button>
      </div>
    );
  }

  return (
    <div className="bg-white text-black font-sans text-[12px] leading-snug p-6 print:p-3 mx-auto" style={{ maxWidth: '200mm' }}>
      {/* Cabeçalho A4 */}
      <div className="border-b-2 border-black pb-2 mb-3 flex items-center justify-between">
        <div>
          <div className="font-black text-2xl">RESUMO PARA ESTOQUE</div>
          <div className="text-sm text-gray-700">{storeName} · {dataFmt}</div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-black text-violet-700">{totalPecas}</div>
          <div className="text-xs uppercase tracking-wide">peças · {rows.length} pedidos</div>
        </div>
      </div>

      {/* TOTAL CONSOLIDADO — PRA PICKING NO ESTOQUE */}
      <div className="mb-4">
        <h2 className="font-black bg-violet-700 text-white px-3 py-1 text-sm uppercase tracking-wide">
          ★ Peças a separar (consolidado)
        </h2>
        <table className="w-full text-[12px] mt-1">
          <thead>
            <tr className="border-b-2 border-black bg-gray-100">
              <th className="text-left px-2 py-1 w-[55%]">Produto</th>
              <th className="text-left px-2 py-1">SKU</th>
              <th className="text-right px-2 py-1 w-16">Qtd</th>
              <th className="text-left px-2 py-1 w-[35%]">Pedidos / Clientes</th>
            </tr>
          </thead>
          <tbody>
            {totalConsolidado.map((t, i) => (
              <tr key={i} className="border-b border-gray-300 align-top">
                <td className="px-2 py-1 font-semibold">{t.nome}</td>
                <td className="px-2 py-1 font-mono text-[11px] text-gray-700">{t.sku}</td>
                <td className="px-2 py-1 text-right font-black text-base">{t.qty}</td>
                <td className="px-2 py-1 text-[11px] leading-tight">
                  {t.pedidos.map((p, j) => (
                    <div key={j}>
                      <span className="font-bold">{p.numero}</span> {p.cliente}{p.qty > 1 ? ` (${p.qty}x)` : ''}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-black font-black bg-gray-100">
              <td colSpan={2} className="px-2 py-1 text-right">TOTAL</td>
              <td className="px-2 py-1 text-right text-base">{totalPecas}</td>
              <td className="px-2 py-1 text-[11px]">{rows.length} pedidos</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* DETALHE POR PEDIDO — pra distribuir nas sacolas */}
      <div className="mt-6 break-before-page print:break-before-page">
        <h2 className="font-black bg-violet-700 text-white px-3 py-1 text-sm uppercase tracking-wide">
          ✂ Detalhe por pedido (pra montar sacolas)
        </h2>
        <div className="grid grid-cols-2 gap-3 mt-2">
          {rows.map((r) => {
            const o = r.order || {};
            return (
              <div key={r.id} className="border border-gray-400 rounded p-2 break-inside-avoid">
                <div className="font-bold flex justify-between items-center border-b border-gray-300 pb-1 mb-1">
                  <span className="text-sm">#{o.wcOrderNumber || r.id.slice(0, 6)}</span>
                  <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300">
                    {r.status === 'new' ? 'NOVO' : 'SEPARANDO'}
                  </span>
                </div>
                <div className="text-[12px] font-semibold mb-1">
                  {o.customerName || 'Sem nome'}
                </div>
                {o.customerPhone && (
                  <div className="text-[10px] text-gray-600 mb-1">📞 {o.customerPhone}</div>
                )}
                <div className="text-[11px] space-y-0.5">
                  {(o.items || []).map((it, i) => (
                    <div key={i} className="flex justify-between gap-2 border-b border-dotted border-gray-300 pb-0.5">
                      <span className="flex-1">{it.productName || it.sku}</span>
                      <span className="font-black whitespace-nowrap">{it.quantity}x</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Rodapé com botões — escondidos na impressão */}
      <div className="mt-4 flex gap-2 print:hidden">
        <button
          onClick={() => window.print()}
          className="flex-1 px-3 py-2 bg-violet-600 text-white font-bold rounded text-xs"
        >
          🖨️ Imprimir
        </button>
        <button
          onClick={() => window.close()}
          className="flex-1 px-3 py-2 bg-slate-200 text-slate-700 font-bold rounded text-xs"
        >
          Fechar
        </button>
      </div>

      <style jsx global>{`
        @media print {
          @page { size: A4 portrait; margin: 10mm; }
          body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
    </div>
  );
}
