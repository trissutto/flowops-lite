'use client';

/**
 * /admin/routing-debug/[wcId]
 *
 * Página de DIAGNÓSTICO do roteamento de um pedido WC.
 * Compara o que a engine viu (routingResult salvo) com o ERP AO VIVO agora.
 * Revela:
 *  - Se engine tomou decisão errada (via scoreBreakdown)
 *  - Se ERP tem linhas duplicadas ou negativas (via raw query)
 *  - Se cache tá stale
 *
 * Estilo feio de propósito — é ferramenta de debug, não UI de usuário final.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';

interface PerStoreRow {
  storeCode: string;
  storeName: string;
  isAssigned: boolean;
  erpRawSum: number;
  erpRawRows: number;
  erpPositiveQty: number;
  engineLiveSaw: number;
  suspicious: string | null;
}
interface BySkuRow {
  sku: string;
  totalQtyInOrder: number;
  assignedStoreCodes: string[];
  perStore: PerStoreRow[];
}
interface DebugResult {
  error?: string;
  order?: { id: string; wcOrderId: number; wcOrderNumber: string | null; status: string; createdAt: string };
  savedRouting?: any;
  pickOrders?: Array<{ id: string; status: string; storeCode: string; storeName: string }>;
  bySku?: BySkuRow[];
}

export default function RoutingDebugPage() {
  const params = useParams();
  const wcId = params.wcId as string;
  const [data, setData] = useState<DebugResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await api<DebugResult>(`/orders/wc/${wcId}/routing-debug`);
      setData(r);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [wcId]);

  if (loading) return <div className="p-6 text-slate-600">Carregando diagnóstico...</div>;
  if (error) return <div className="p-6 text-red-700">Erro: {error}</div>;
  if (!data) return <div className="p-6">Sem dados.</div>;
  if (data.error) return <div className="p-6 text-red-700">{data.error}</div>;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-5 text-sm">
      <div className="flex items-center justify-between">
        <Link href={`/pedidos/wc/${wcId}`} className="text-brand flex items-center gap-1 hover:underline">
          <ArrowLeft className="w-4 h-4" /> Voltar ao pedido
        </Link>
        <button
          onClick={load}
          className="px-3 py-1.5 text-xs bg-slate-200 hover:bg-slate-300 rounded flex items-center gap-1"
        >
          <RefreshCw className="w-3 h-3" /> Recarregar
        </button>
      </div>

      <h1 className="text-2xl font-bold">
        🔍 Diagnóstico routing — pedido #{data.order?.wcOrderNumber ?? data.order?.wcOrderId}
      </h1>
      <div className="text-xs text-slate-500">
        Order ID: <code>{data.order?.id}</code> · Criado: {data.order && new Date(data.order.createdAt).toLocaleString('pt-BR')}
      </div>

      {/* Pick orders criados */}
      <section className="bg-white border border-slate-200 rounded p-4">
        <h2 className="font-bold mb-2">Pick-orders criados ({data.pickOrders?.length ?? 0})</h2>
        {data.pickOrders?.length ? (
          <ul className="space-y-1">
            {data.pickOrders.map((p) => (
              <li key={p.id}>
                <b>{p.storeName}</b> ({p.storeCode}) — <code>{p.id.slice(0, 8)}</code> · status: {p.status}
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-slate-500">Nenhum pick-order.</div>
        )}
      </section>

      {/* Por SKU — o core do diagnóstico */}
      {data.bySku?.map((row) => (
        <section key={row.sku} className="bg-white border border-slate-200 rounded p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h2 className="font-bold">
                SKU <code className="bg-slate-100 px-1 rounded">{row.sku}</code>
              </h2>
              <div className="text-xs text-slate-500">
                Qty pedido: <b>{row.totalQtyInOrder}</b> · Atribuído pra: <b>{row.assignedStoreCodes.join(', ') || '—'}</b>
              </div>
            </div>
          </div>

          <table className="w-full text-xs border-collapse">
            <thead className="bg-slate-100 text-left">
              <tr>
                <th className="px-2 py-1 border border-slate-200">Loja</th>
                <th className="px-2 py-1 border border-slate-200">Atribuída?</th>
                <th className="px-2 py-1 border border-slate-200">ERP soma (todas linhas)</th>
                <th className="px-2 py-1 border border-slate-200">ERP # linhas</th>
                <th className="px-2 py-1 border border-slate-200">ERP só positivas</th>
                <th className="px-2 py-1 border border-slate-200">Engine vê</th>
                <th className="px-2 py-1 border border-slate-200">Flag</th>
              </tr>
            </thead>
            <tbody>
              {row.perStore.map((ps) => {
                const isSus = !!ps.suspicious;
                const rowClass = ps.isAssigned
                  ? 'bg-blue-50'
                  : isSus
                  ? 'bg-red-50'
                  : '';
                return (
                  <tr key={ps.storeCode} className={rowClass}>
                    <td className="px-2 py-1 border border-slate-200">
                      <b>{ps.storeCode}</b> — {ps.storeName}
                    </td>
                    <td className="px-2 py-1 border border-slate-200 text-center">
                      {ps.isAssigned ? '✅' : '—'}
                    </td>
                    <td className="px-2 py-1 border border-slate-200 text-right">
                      {ps.erpRawSum}
                    </td>
                    <td className="px-2 py-1 border border-slate-200 text-right">
                      {ps.erpRawRows}
                      {ps.erpRawRows > 1 && <span className="text-amber-700 ml-1">⚠</span>}
                    </td>
                    <td className="px-2 py-1 border border-slate-200 text-right">
                      {ps.erpPositiveQty}
                    </td>
                    <td className="px-2 py-1 border border-slate-200 text-right">
                      <b>{ps.engineLiveSaw}</b>
                    </td>
                    <td className="px-2 py-1 border border-slate-200 text-red-700 text-xs">
                      {ps.suspicious && (
                        <span className="flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />
                          {ps.suspicious}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="text-xs text-slate-500 border-t pt-2">
            <b>Legenda:</b> ERP soma = SUM(ESTOQUE) de todas as linhas (inclusive negativas).
            ERP só positivas = o que a query <code>ESTOQUE&gt;0</code> retornaria.
            Engine vê = o que a query ao vivo ({'<'}sem cache{'>'}) retornou AGORA.
            Se "Engine vê" &gt; 0 mas "ERP soma" &lt;= 0 → suspeita de linha duplicada positiva mascarando devolução pendente.
          </div>
        </section>
      ))}

      {/* Routing result salvo (JSON) */}
      {data.savedRouting && (
        <section className="bg-white border border-slate-200 rounded p-4">
          <h2 className="font-bold mb-2">Routing salvo no pedido (JSON)</h2>
          <details>
            <summary className="cursor-pointer text-xs text-slate-600 mb-1">
              Expandir — mostra scoreBreakdown, strategy e assignments que a engine decidiu
            </summary>
            <pre className="text-xs bg-slate-900 text-slate-100 rounded p-3 overflow-auto mt-2 max-h-[500px]">
              {JSON.stringify(data.savedRouting, null, 2)}
            </pre>
          </details>
        </section>
      )}
    </div>
  );
}
