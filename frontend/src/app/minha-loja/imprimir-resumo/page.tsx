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
        <div className="space-y-1 mt-1">
          {totalConsolidado.map((t, i) => (
            <div key={i} className="border-b border-black pb-1">
              <div className="flex justify-between font-bold border-b border-dotted border-gray-400 pb-0.5">
                <span className="truncate flex-1 mr-2">{t.nome}</span>
                <span>{t.qty}x</span>
              </div>
              <div className="text-[9px] text-gray-700 mt-0.5">SKU {t.sku}</div>
              {/* Lista DE QUEM é cada peça */}
              <div className="text-[10px] mt-0.5 leading-tight">
                {t.pedidos.map((p, j) => (
                  <div key={j}>
                    → <span className="font-bold">{p.numero}</span> {p.cliente} {p.qty > 1 ? `(${p.qty}x)` : ''}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="text-right font-black border-t-2 border-black mt-1 pt-0.5">
          TOTAL: {totalPecas} peça(s)
        </div>
      </div>

      {/* DETALHE POR PEDIDO */}
      <div className="border-t-2 border-dashed border-black pt-2 mt-2">
        <div className="font-black text-center bg-black text-white py-0.5 text-[12px]">
          DETALHE POR PEDIDO
        </div>
        {rows.map((r) => {
          const o = r.order || {};
          return (
            <div key={r.id} className="mt-2 border-b border-dashed border-black pb-1">
              <div className="font-bold flex justify-between">
                <span>#{o.wcOrderNumber || r.id.slice(0, 6)}</span>
                <span className="text-[10px] uppercase">{r.status === 'new' ? 'NOVO' : 'SEPARANDO'}</span>
              </div>
              <div className="text-[11px] mb-0.5">
                {o.customerName || 'Sem nome'}
                {o.customerPhone && <span className="text-[10px]"> · {o.customerPhone}</span>}
              </div>
              <div className="text-[10px] mt-0.5 space-y-0.5">
                {(o.items || []).map((it, i) => (
                  <div key={i} className="flex justify-between">
                    <span className="truncate flex-1 mr-2">{it.productName || it.sku}</span>
                    <span className="font-bold">{it.quantity}x</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
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
