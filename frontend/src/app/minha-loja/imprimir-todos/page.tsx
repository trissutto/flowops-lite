'use client';

/**
 * /minha-loja/imprimir-todos?ids=id1,id2,id3
 *
 * Imprime N cupons de pedido EM UMA ÚNICA JANELA com page-break entre eles.
 * Resolve o bug do "só imprime o primeiro" quando tentava abrir N popups (Chrome
 * bloqueia popups em loop).
 *
 * Carrega os pedidos via /pick-orders/mine (mesma API da lista), filtra pelos
 * ids da query, renderiza cada cupom igual /imprimir/[id], e dispara window.print()
 * UMA vez no fim — impressora térmica imprime todos em sequência.
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { api } from '@/lib/api';

interface OrderItem {
  sku: string;
  productName?: string | null;
  quantity: number;
}

interface PickOrderRow {
  id: string;
  status: string;
  createdAt?: string;
  order?: {
    wcOrderNumber?: string | null;
    customerName?: string | null;
    customerPhone?: string | null;
    customerCpf?: string | null;
    shippingAddress?: string | null;
    shippingCep?: string | null;
    items?: OrderItem[];
  };
}

function ImprimirTodosContent() {
  const sp = useSearchParams();
  const idsParam = sp.get('ids') || '';
  const idsWanted = idsParam.split(',').filter(Boolean);
  const [rows, setRows] = useState<PickOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const all = await api<PickOrderRow[]>('/pick-orders/mine');
        const filtered = (all || []).filter((r) => idsWanted.includes(r.id));
        // Mantém ordem da query
        const ordered = idsWanted
          .map((id) => filtered.find((r) => r.id === id))
          .filter(Boolean) as PickOrderRow[];
        setRows(ordered);
      } catch (e: any) {
        setError(e?.message || 'Erro ao carregar pedidos');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsParam]);

  // Auto-imprime quando carrega tudo
  useEffect(() => {
    if (loading || error || rows.length === 0) return;
    const t = setTimeout(() => window.print(), 500);
    return () => clearTimeout(t);
  }, [loading, error, rows.length]);

  if (loading) return <div className="p-6 text-center">Carregando pedidos...</div>;
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
        <p>Nenhum pedido encontrado</p>
        <button onClick={() => window.close()} className="mt-3 px-3 py-1 bg-slate-200 rounded">Fechar</button>
      </div>
    );
  }

  return (
    <div className="bg-white text-black">
      {rows.map((r, idx) => {
        const o = r.order || {};
        const dataFmt = r.createdAt
          ? new Date(r.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
          : '';
        let shipping: any = {};
        try {
          shipping = o.shippingAddress ? JSON.parse(o.shippingAddress) : {};
        } catch {}
        const enderecoLinhas = [
          shipping.address_1,
          shipping.address_2,
          [shipping.neighborhood || shipping.bairro, shipping.city, shipping.state].filter(Boolean).join(' - '),
          o.shippingCep ? `CEP ${o.shippingCep}` : null,
        ].filter(Boolean);

        return (
          <div
            key={r.id}
            className="font-mono text-[11px] leading-tight p-2 cupom"
            style={{
              width: '76mm',
              maxWidth: '76mm',
              margin: '0 auto',
              // SEM page-break — térmica é papel contínuo. Separador visual abaixo.
              borderTop: idx > 0 ? '2px dashed #000' : 'none',
              marginTop: idx > 0 ? '4mm' : '0',
              paddingTop: idx > 0 ? '4mm' : '0',
            }}
          >
            {/* Cabeçalho */}
            <div className="text-center border-b border-dashed border-black pb-2 mb-2">
              <div className="font-black text-base">PEDIDO #{o.wcOrderNumber || r.id.slice(0, 6)}</div>
              <div className="text-[10px]">{dataFmt}</div>
              <div className="text-[10px] uppercase font-bold">{r.status === 'new' ? 'NOVO' : 'SEPARANDO'}</div>
            </div>

            {/* Cliente */}
            <div className="mb-2 border-b border-dashed border-black pb-2">
              <div className="font-bold">{o.customerName || 'Sem nome'}</div>
              {o.customerPhone && <div className="text-[10px]">📞 {o.customerPhone}</div>}
              {o.customerCpf && <div className="text-[10px]">CPF {o.customerCpf}</div>}
              {enderecoLinhas.length > 0 && (
                <div className="text-[10px] mt-1">
                  {enderecoLinhas.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              )}
            </div>

            {/* Itens */}
            <div className="mb-2">
              <div className="font-black text-center bg-black text-white py-0.5 text-[11px]">
                PEÇAS A SEPARAR
              </div>
              <div className="space-y-1 mt-1">
                {(o.items || []).map((it, i) => (
                  <div key={i} className="flex justify-between border-b border-dotted border-gray-500 pb-0.5">
                    <span className="truncate flex-1 mr-2 font-bold">{it.productName || it.sku}</span>
                    <span className="font-bold">{it.quantity}x</span>
                  </div>
                ))}
              </div>
              <div className="text-right text-[10px] mt-1">
                Total: {(o.items || []).reduce((s, it) => s + it.quantity, 0)} peça(s)
              </div>
            </div>

            <div className="text-center text-[9px] mt-2 pt-1 border-t border-dashed border-black">
              Pedido {idx + 1} de {rows.length}
            </div>
          </div>
        );
      })}

      {/* Botões — escondidos na impressão */}
      <div className="mt-4 mx-auto max-w-[76mm] flex gap-2 print:hidden">
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
          @page { size: 80mm auto; margin: 0; }
          body { margin: 0; }
          .cupom { page-break-inside: avoid; }
        }
        .cupom { background: white; }
      `}</style>
    </div>
  );
}

export default function ImprimirTodosPage() {
  return (
    <Suspense fallback={<div className="p-6 text-center">Carregando...</div>}>
      <ImprimirTodosContent />
    </Suspense>
  );
}
