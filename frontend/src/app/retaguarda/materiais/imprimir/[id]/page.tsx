'use client';

/**
 * /retaguarda/materiais/imprimir/[id]
 *
 * Folha de separação imprimível pros pedidos de materiais das filiais.
 * Aberta em nova aba pelo botão "Imprimir" na tela /retaguarda/materiais.
 *
 * Layout: A4 / 80mm agnóstico — usa CSS @media print pra esconder UI
 * web (botões, header app) e mostrar só a folha.
 * Dispara window.print() automaticamente assim que os dados carregam,
 * pra economizar 1 clique do operador.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Printer, X, Warehouse, ShoppingCart } from 'lucide-react';

type Status = 'pending' | 'approved' | 'separating' | 'shipped' | 'delivered' | 'cancelled';
type SupplyOrigin = 'MATRIZ' | 'MERCADO_LIVRE';

type SupplyRequest = {
  id: string;
  requestNumber: number;
  status: Status;
  note: string | null;
  adminNote: string | null;
  trackingCode: string | null;
  carrier: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  items: Array<{
    id: string;
    qtyRequested: number;
    qtyApproved: number | null;
    qtyShipped: number | null;
    supply: {
      id: string;
      sku: string | null;
      name: string;
      category: string | null;
      unit: string;
      description: string | null;
      origin: SupplyOrigin;
    };
  }>;
  store: { id: string; code: string; name: string };
};

/**
 * Badge ORIGEM pra folha impressa. Na tela mantém cor (indigo/amber) pra
 * facilitar batida visual. No papel vira preto sobre branco via print:* pra
 * ficar legível mesmo em impressora térmica ou laser monocromática.
 */
function OriginBadgePrint({ origin }: { origin: SupplyOrigin }) {
  if (origin === 'MERCADO_LIVRE') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wide bg-amber-100 text-amber-900 border border-amber-500 px-1.5 py-0.5 rounded print:bg-white print:text-black print:border-black">
        <ShoppingCart className="w-2.5 h-2.5 print:hidden" />
        Mercado Livre
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wide bg-indigo-100 text-indigo-900 border border-indigo-500 px-1.5 py-0.5 rounded print:bg-white print:text-black print:border-black">
      <Warehouse className="w-2.5 h-2.5 print:hidden" />
      Matriz
    </span>
  );
}

const STATUS_LABEL: Record<Status, string> = {
  pending: 'Pendente',
  approved: 'Aprovado',
  separating: 'Separando',
  shipped: 'Enviado',
  delivered: 'Entregue',
  cancelled: 'Cancelado',
};

export default function ImprimirMateriaisPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [request, setRequest] = useState<SupplyRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoPrinted, setAutoPrinted] = useState(false);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    (async () => {
      try {
        const data = await api<SupplyRequest>(`/supplies/requests/${id}`);
        if (!alive) return;
        setRequest(data);
      } catch (e: any) {
        if (!alive) return;
        setError(e?.message || 'Erro ao carregar pedido');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [id]);

  // Dispara impressão automática 1x após carregar — economiza clique do operador.
  useEffect(() => {
    if (!request || autoPrinted) return;
    // Pequeno delay pra browser renderizar e as fontes estabilizarem
    const t = setTimeout(() => {
      window.print();
      setAutoPrinted(true);
    }, 350);
    return () => clearTimeout(t);
  }, [request, autoPrinted]);

  if (loading) {
    return (
      <div className="p-8 text-center text-slate-500">Carregando pedido…</div>
    );
  }

  if (error || !request) {
    return (
      <div className="p-8 text-center">
        <div className="text-red-700 font-semibold">{error || 'Pedido não encontrado'}</div>
        <button
          onClick={() => window.close()}
          className="mt-4 px-4 py-2 bg-slate-700 hover:bg-slate-800 text-white rounded-lg"
        >
          Fechar
        </button>
      </div>
    );
  }

  const totalPediu = request.items.reduce((acc, it) => acc + (it.qtyRequested || 0), 0);
  const totalAprov = request.items.reduce(
    (acc, it) => acc + (it.qtyApproved ?? it.qtyRequested ?? 0),
    0,
  );
  const totalEnv = request.items.reduce((acc, it) => acc + (it.qtyShipped ?? 0), 0);
  const showApproved = request.status !== 'pending' && request.status !== 'cancelled';
  const showShipped = request.status === 'separating' || request.status === 'shipped' || request.status === 'delivered';

  return (
    <>
      {/* CSS de impressão — esconde UI da web, mostra só a folha */}
      <style jsx global>{`
        @media print {
          .no-print { display: none !important; }
          @page { size: A4; margin: 12mm; }
          body { background: white !important; }
        }
        @media screen {
          .print-sheet {
            max-width: 820px;
            margin: 24px auto;
            background: white;
            border: 1px solid #e2e8f0;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
          }
        }
      `}</style>

      {/* Barra de ações fixa — só na tela */}
      <div className="no-print sticky top-0 z-10 bg-slate-100 border-b border-slate-200 px-4 py-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-700">
          Folha de separação · Pedido #{String(request.requestNumber).padStart(4, '0')}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-lg px-3 py-1.5 text-sm"
          >
            <Printer className="w-4 h-4" />
            Imprimir
          </button>
          <button
            onClick={() => window.close()}
            className="flex items-center gap-2 bg-white hover:bg-slate-100 border border-slate-300 text-slate-700 font-semibold rounded-lg px-3 py-1.5 text-sm"
          >
            <X className="w-4 h-4" />
            Fechar
          </button>
        </div>
      </div>

      {/* Folha imprimível */}
      <div className="print-sheet p-8 text-slate-900 font-sans">
        {/* Cabeçalho */}
        <div className="flex items-start justify-between border-b-2 border-slate-800 pb-3 mb-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500">LURDS Order One</div>
            <h1 className="text-xl font-black mt-0.5">Folha de Separação de Materiais</h1>
            <div className="text-xs text-slate-600 mt-1">
              Pedido <b>#{String(request.requestNumber).padStart(4, '0')}</b> · {STATUS_LABEL[request.status]}
            </div>
          </div>
          <div className="text-right text-xs text-slate-600">
            <div>Emitido em</div>
            <div className="font-mono font-semibold text-slate-800">{formatNow()}</div>
          </div>
        </div>

        {/* Dados da loja */}
        <div className="grid grid-cols-2 gap-4 text-sm mb-4">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Loja solicitante</div>
            <div className="font-bold text-base mt-0.5">
              {request.store.code} — {request.store.name}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Pedido criado em</div>
            <div className="font-semibold mt-0.5">{formatDate(request.createdAt)}</div>
          </div>
        </div>

        {/* Observações */}
        {(request.note || request.adminNote) && (
          <div className="grid grid-cols-1 gap-2 mb-4">
            {request.note && (
              <div className="border-l-4 border-amber-400 bg-amber-50 px-3 py-2 text-sm">
                <div className="text-[10px] uppercase tracking-wider text-amber-800 font-bold">Obs. da loja</div>
                <div className="text-slate-800">{request.note}</div>
              </div>
            )}
            {request.adminNote && (
              <div className="border-l-4 border-sky-400 bg-sky-50 px-3 py-2 text-sm">
                <div className="text-[10px] uppercase tracking-wider text-sky-800 font-bold">Obs. da matriz</div>
                <div className="text-slate-800">{request.adminNote}</div>
              </div>
            )}
          </div>
        )}

        {/* Tabela de itens */}
        <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-slate-800 text-white">
              <th className="text-left px-3 py-2 w-10">#</th>
              <th className="text-left px-3 py-2">Item</th>
              <th className="text-center px-3 py-2 w-20">Un.</th>
              <th className="text-center px-3 py-2 w-20">Pediu</th>
              {showApproved && <th className="text-center px-3 py-2 w-24">Aprovado</th>}
              {showShipped && <th className="text-center px-3 py-2 w-24">Enviado</th>}
              <th className="text-center px-3 py-2 w-16">✓</th>
            </tr>
          </thead>
          <tbody>
            {request.items.map((it, idx) => {
              const aprov = it.qtyApproved ?? it.qtyRequested;
              const env = it.qtyShipped ?? 0;
              return (
                <tr key={it.id} className="border-b border-slate-200">
                  <td className="px-3 py-2 text-slate-500 font-mono text-xs">{idx + 1}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold">{it.supply.name}</span>
                      <OriginBadgePrint origin={it.supply.origin} />
                    </div>
                    {(it.supply.category || it.supply.description) && (
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {it.supply.category}
                        {it.supply.description ? ` · ${it.supply.description}` : ''}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center text-xs text-slate-600">
                    {it.supply.unit}
                  </td>
                  <td className="px-3 py-2 text-center font-mono font-bold">
                    {it.qtyRequested}
                  </td>
                  {showApproved && (
                    <td className="px-3 py-2 text-center font-mono font-bold text-blue-800">
                      {aprov}
                    </td>
                  )}
                  {showShipped && (
                    <td className="px-3 py-2 text-center font-mono font-bold text-emerald-800">
                      {env}
                    </td>
                  )}
                  <td className="px-3 py-2 text-center">
                    {/* Checkbox manual pra marcar conforme separa */}
                    <div className="inline-block w-5 h-5 border-2 border-slate-400 rounded"></div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-slate-100 font-bold border-t-2 border-slate-800">
              <td className="px-3 py-2" colSpan={3}>
                TOTAL ({request.items.length} item(ns))
              </td>
              <td className="px-3 py-2 text-center font-mono">{totalPediu}</td>
              {showApproved && <td className="px-3 py-2 text-center font-mono text-blue-800">{totalAprov}</td>}
              {showShipped && <td className="px-3 py-2 text-center font-mono text-emerald-800">{totalEnv}</td>}
              <td></td>
            </tr>
          </tfoot>
        </table>
        </div>

        {/* Rastreio (se já enviado) */}
        {request.trackingCode && (
          <div className="mt-4 border border-sky-200 bg-sky-50 rounded-lg p-3 text-sm">
            <div className="text-[10px] uppercase tracking-wider text-sky-800 font-bold">Rastreio</div>
            <div className="font-mono font-bold text-lg mt-0.5">{request.trackingCode}</div>
            {request.carrier && <div className="text-xs text-slate-600">{request.carrier}</div>}
          </div>
        )}

        {/* Assinaturas */}
        <div className="grid grid-cols-2 gap-8 mt-10 pt-6">
          <div>
            <div className="border-t border-slate-400 pt-1 text-center text-xs text-slate-600">
              Separado por (matriz)
            </div>
          </div>
          <div>
            <div className="border-t border-slate-400 pt-1 text-center text-xs text-slate-600">
              Recebido por (loja)
            </div>
          </div>
        </div>

        {/* Rodapé */}
        <div className="mt-8 pt-3 border-t border-slate-200 text-[10px] text-slate-400 text-center">
          LURDS ORDER ONE · pedido {request.id}
        </div>
      </div>
    </>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatNow(): string {
  return new Date().toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
