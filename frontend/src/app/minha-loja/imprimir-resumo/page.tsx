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

interface PickOrderItem {
  sku: string;
  ref?: string | null;
  cor?: string | null;
  tamanho?: string | null;
  descricao?: string | null;
  qty: number;
}

interface PickOrderRow {
  id: string;
  status: string;
  wcOrderNumber?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  items?: PickOrderItem[];
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
  const totalConsolidado = (() => {
    const map = new Map<string, { ref: string; cor: string; tam: string; desc: string; qty: number; pedidos: string[] }>();
    for (const r of rows) {
      for (const it of (r.items || [])) {
        const key = it.sku || `${it.ref}-${it.cor}-${it.tamanho}`;
        const prev = map.get(key);
        const pedidoLabel = r.wcOrderNumber ? `#${r.wcOrderNumber}` : r.id.slice(0, 6);
        if (prev) {
          prev.qty += it.qty;
          prev.pedidos.push(pedidoLabel);
        } else {
          map.set(key, {
            ref: it.ref || it.sku,
            cor: it.cor || '',
            tam: it.tamanho || '',
            desc: it.descricao || '',
            qty: it.qty,
            pedidos: [pedidoLabel],
          });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => a.ref.localeCompare(b.ref));
  })();

  const totalPecas = totalConsolidado.reduce((s, x) => s + x.qty, 0);
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
    <div className="bg-white text-black font-mono text-[11px] leading-tight p-2 print:p-0" style={{ width: '76mm', maxWidth: '76mm', margin: '0 auto' }}>
      {/* Cabeçalho */}
      <div className="text-center border-b border-dashed border-black pb-2 mb-2">
        <div className="font-black text-base">RESUMO PARA ESTOQUE</div>
        <div className="text-[10px]">{storeName}</div>
        <div className="text-[10px]">{dataFmt}</div>
        <div className="font-bold mt-1">{rows.length} pedido(s) · {totalPecas} peça(s)</div>
      </div>

      {/* TOTAL CONSOLIDADO — PRA PICKING NO ESTOQUE */}
      <div className="mb-3">
        <div className="font-black text-center bg-black text-white py-0.5 text-[12px]">
          PEÇAS A SEPARAR
        </div>
        <table className="w-full text-[11px] mt-1">
          <thead>
            <tr className="border-b border-black">
              <th className="text-left px-0.5">REF</th>
              <th className="text-left px-0.5">COR</th>
              <th className="text-center px-0.5">TAM</th>
              <th className="text-right px-0.5">QTD</th>
            </tr>
          </thead>
          <tbody>
            {totalConsolidado.map((t, i) => (
              <tr key={i} className="border-b border-dotted border-gray-500">
                <td className="font-bold px-0.5">{t.ref}</td>
                <td className="px-0.5">{t.cor}</td>
                <td className="text-center px-0.5">{t.tam}</td>
                <td className="text-right font-bold px-0.5">{t.qty}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="text-right font-black border-t-2 border-black mt-1 pt-0.5">
          TOTAL: {totalPecas} peça(s)
        </div>
      </div>

      {/* DETALHE POR PEDIDO */}
      <div className="border-t-2 border-dashed border-black pt-2 mt-2">
        <div className="font-black text-center bg-black text-white py-0.5 text-[12px]">
          DETALHE POR PEDIDO
        </div>
        {rows.map((r) => (
          <div key={r.id} className="mt-2 border-b border-dashed border-black pb-1">
            <div className="font-bold flex justify-between">
              <span>#{r.wcOrderNumber || r.id.slice(0, 6)}</span>
              <span className="text-[10px] uppercase">{r.status === 'new' ? 'NOVO' : 'SEPARANDO'}</span>
            </div>
            <div className="text-[11px] mb-0.5">
              {r.customerName || 'Sem nome'}
              {r.customerPhone && <span className="text-[10px]"> · {r.customerPhone}</span>}
            </div>
            <table className="w-full text-[10px]">
              <tbody>
                {(r.items || []).map((it, i) => (
                  <tr key={i}>
                    <td className="font-bold pr-1">{it.ref || it.sku}</td>
                    <td className="pr-1">{it.cor || ''}</td>
                    <td className="text-center pr-1">{it.tamanho || ''}</td>
                    <td className="text-right font-bold">{it.qty}x</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
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

      <style jsx>{`
        @media print {
          @page { size: 80mm auto; margin: 0; }
          body { margin: 0; }
        }
      `}</style>
    </div>
  );
}
