'use client';

/**
 * Página de impressão para ORDEM DE SEPARAÇÃO.
 *
 * Otimizada pra impressora térmica não-fiscal 80mm (Epson TM-T20, Bematech,
 * Elgin i9, etc). Também funciona em A4 se necessário.
 *
 * Chama o endpoint prepare-separation pra pegar tudo já pronto (grupos por loja,
 * endereço, método de envio). Se o pedido for multi-loja, cada loja ganha sua
 * folha separada (page-break).
 *
 * Fluxo:
 *  1. Componente carrega dados
 *  2. Chama window.print() automaticamente
 *  3. Usuário imprime no driver da térmica
 *  4. Fecha a aba (se foi aberta via popup)
 *
 * Suporta ?wcIds=123,456,789 pra IMPRESSÃO EM BLOCO — uma folha por pedido.
 */

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { classifyShipping } from '@/lib/shipping-method';

interface SepItem {
  sku: string;
  quantity: number;
  productName: string;
  variant?: string;
}
interface SepGroup {
  storeId: string;
  storeCode: string;
  storeName: string;
  storeCity?: string | null;
  storeState?: string | null;
  whatsapp?: string | null;
  items: SepItem[];
}
interface SepPreview {
  success: boolean;
  strategy: 'single-store' | 'multi-store' | 'insufficient-stock';
  shippingMethod: string;
  groups: SepGroup[];
  missing: Array<{ sku: string; quantity: number; productName: string }>;
}

interface WcOrderFull {
  id: number;
  number: string;
  dateCreatedGmt: string;
  total: string;
  paymentMethodTitle: string;
  customerNote: string;
  billing: any;
  shipping: any;
  lineItems: Array<{ name: string; sku: string; quantity: number }>;
  shippingLines: Array<{ method: string; total: string }>;
}

interface OrderBundle {
  order: WcOrderFull;
  separation: SepPreview;
}

// Envolve em Suspense porque usa useSearchParams (exigido pelo Next 14 no build estático)
export default function ImprimirSeparacaoPage() {
  return (
    <Suspense fallback={<div className="p-4 font-mono text-xs">Carregando…</div>}>
      <ImprimirSeparacaoPageInner />
    </Suspense>
  );
}

function ImprimirSeparacaoPageInner() {
  const params = useParams<{ wcId: string }>();
  const sp = useSearchParams();
  const [bundles, setBundles] = useState<OrderBundle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Lista de IDs — aceita ?wcIds=1,2,3 pra bloco; senão usa o da rota
    const listParam = sp.get('wcIds');
    const ids = listParam
      ? listParam.split(',').map((x) => x.trim()).filter(Boolean)
      : [params.wcId].filter(Boolean);

    (async () => {
      try {
        const results = await Promise.all(
          ids.map(async (id) => {
            const [order, separation] = await Promise.all([
              api<WcOrderFull>(`/orders/wc/${id}`),
              api<SepPreview>(`/orders/wc/${id}/prepare-separation`).catch(() => ({
                success: false,
                strategy: 'insufficient-stock' as const,
                shippingMethod: '',
                groups: [],
                missing: [],
              })),
            ]);
            return { order, separation };
          }),
        );
        setBundles(results);
      } catch (e: any) {
        setError(e?.message || 'Falha ao carregar pedido');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.wcId]);

  // Dispara print automaticamente quando terminar de carregar
  useEffect(() => {
    if (!loading && !error && bundles.length > 0) {
      // Pequeno delay pra garantir render completo antes do dialog
      const t = setTimeout(() => {
        window.print();
      }, 400);
      return () => clearTimeout(t);
    }
  }, [loading, error, bundles.length]);

  if (loading) {
    return (
      <div className="p-6 no-print">
        <div className="text-slate-500">Carregando pedido(s)...</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6 no-print">
        <div className="text-red-700 font-semibold">Erro: {error}</div>
        <button
          onClick={() => window.close()}
          className="mt-4 px-4 py-2 bg-slate-900 text-white rounded"
        >
          Fechar
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Barra auxiliar — só aparece na tela, nunca no papel */}
      <div className="no-print bg-slate-100 border-b p-3 flex gap-2 items-center">
        <button
          onClick={() => window.print()}
          className="px-4 py-2 bg-slate-900 text-white rounded font-semibold"
        >
          🖨️ Imprimir novamente
        </button>
        <button
          onClick={() => window.close()}
          className="px-4 py-2 bg-white border rounded hover:bg-slate-50"
        >
          Fechar
        </button>
        <div className="text-sm text-slate-500 ml-2">
          {bundles.length} pedido(s) · Impressão térmica 80mm. Ajuste no driver: papel "receipt 80mm" ou "custom 80mm × auto".
        </div>
      </div>

      {/* Conteúdo imprimível */}
      <div className="print-area">
        {bundles.flatMap((b) =>
          // Se tem grupos (loja designada), imprime 1 folha por loja.
          // Se não tem (ruptura ou sem stock), imprime uma folha "sem loja designada" com todos os itens.
          b.separation.groups.length > 0
            ? b.separation.groups.map((g, gi) => (
                <Folha key={`${b.order.id}-${g.storeId}-${gi}`} order={b.order} separation={b.separation} group={g} />
              ))
            : [
                <Folha
                  key={`${b.order.id}-nogroup`}
                  order={b.order}
                  separation={b.separation}
                  group={null}
                />,
              ],
        )}
      </div>

      <style jsx global>{`
        /* Tela */
        body {
          background: #f1f5f9;
        }
        .print-area {
          max-width: 80mm;
          margin: 0 auto;
          padding: 8px 0;
        }
        .folha {
          background: white;
          width: 80mm;
          margin: 0 auto 12px auto;
          padding: 4mm;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
          font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
          font-size: 11pt;
          line-height: 1.35;
          color: #000;
        }
        .folha h1 {
          font-size: 15pt;
          font-weight: 900;
          margin: 0;
          text-align: center;
          letter-spacing: -0.5px;
        }
        .folha h2 {
          font-size: 10pt;
          font-weight: 700;
          margin: 8px 0 3px 0;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          border-bottom: 1px dashed #000;
          padding-bottom: 2px;
        }
        .folha .big {
          font-size: 18pt;
          font-weight: 900;
          text-align: center;
          margin: 3px 0;
          letter-spacing: -0.5px;
        }
        .folha .sep {
          border-top: 1px dashed #000;
          margin: 6px 0;
        }
        .folha .row {
          display: flex;
          justify-content: space-between;
          gap: 6px;
          margin: 2px 0;
        }
        .folha .muted {
          color: #444;
          font-size: 9pt;
        }
        .folha table.items {
          width: 100%;
          border-collapse: collapse;
          margin-top: 3px;
        }
        .folha table.items td {
          padding: 3px 2px;
          border-bottom: 1px dotted #999;
          vertical-align: top;
          font-size: 10.5pt;
        }
        .folha table.items td.qty {
          font-weight: 900;
          font-size: 13pt;
          width: 12mm;
          text-align: center;
        }
        .folha .sku {
          font-family: 'Consolas', 'Courier New', monospace;
          font-size: 9pt;
          color: #000;
        }
        .folha .variant {
          font-size: 9.5pt;
          color: #333;
          font-style: italic;
        }
        .folha .footer {
          margin-top: 10px;
          font-size: 9pt;
          text-align: center;
          color: #333;
        }
        .folha .missing {
          background: #000;
          color: #fff;
          padding: 4px 6px;
          text-align: center;
          font-weight: 900;
          margin: 6px 0;
        }
        .check-line {
          display: flex;
          align-items: center;
          gap: 6px;
          margin: 4px 0;
          font-size: 10pt;
        }
        .check-box {
          display: inline-block;
          width: 4mm;
          height: 4mm;
          border: 1.5px solid #000;
          margin-right: 3px;
          flex-shrink: 0;
        }

        /* Impressão */
        @media print {
          @page {
            size: 80mm auto;
            margin: 2mm;
          }
          body {
            background: white !important;
          }
          .no-print {
            display: none !important;
          }
          .print-area {
            max-width: 100%;
            padding: 0;
          }
          .folha {
            box-shadow: none !important;
            margin: 0 !important;
            padding: 0 !important;
            page-break-after: always;
          }
          .folha:last-child {
            page-break-after: auto;
          }
        }
      `}</style>
    </>
  );
}

function Folha({
  order,
  separation,
  group,
}: {
  order: WcOrderFull;
  separation: SepPreview;
  group: SepGroup | null;
}) {
  const dt = new Date(
    order.dateCreatedGmt.endsWith('Z') ? order.dateCreatedGmt : order.dateCreatedGmt + 'Z',
  );
  const dateStr = dt.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

  const ship = order.shipping || {};
  const bill = order.billing || {};
  const customerName =
    `${ship.first_name || bill.first_name || ''} ${ship.last_name || bill.last_name || ''}`.trim() || '—';
  const phone = bill.phone || '—';

  const addrLine1 = [ship.address_1 || bill.address_1, ship.number || bill.number]
    .filter(Boolean)
    .join(', ');
  const addrLine2 = ship.address_2 || bill.address_2 || '';
  const addrBairro = ship.neighborhood || bill.neighborhood || '';
  const addrCity = `${ship.city || bill.city || ''}${ship.state || bill.state ? ' / ' + (ship.state || bill.state) : ''}`;
  const cep = (ship.postcode || bill.postcode || '').replace(/(\d{5})(\d{3})/, '$1-$2');

  const shippingMethod =
    (order.shippingLines?.[0]?.method) || separation.shippingMethod || '—';

  const itemsToPrint = group
    ? group.items
    : (order.lineItems || []).map((li) => ({
        sku: li.sku,
        quantity: li.quantity,
        productName: li.name,
        variant: undefined as string | undefined,
      }));

  const totalUnits = itemsToPrint.reduce((s, i) => s + Number(i.quantity || 0), 0);

  return (
    <div className="folha">
      {/* CABEÇALHO */}
      <h1>ORDEM DE SEPARAÇÃO</h1>
      <div className="muted" style={{ textAlign: 'center' }}>
        LURDS · {dateStr}
      </div>

      <div className="big">#{order.number}</div>

      {group ? (
        <div
          style={{
            textAlign: 'center',
            background: '#000',
            color: '#fff',
            padding: '3px 4px',
            fontWeight: 900,
            fontSize: '11pt',
          }}
        >
          LOJA: {group.storeName} ({group.storeCode})
        </div>
      ) : (
        <div
          style={{
            textAlign: 'center',
            fontWeight: 700,
            fontSize: '10pt',
            color: '#900',
          }}
        >
          ⚠ LOJA NÃO DEFINIDA — DEFINIR NA SEPARAÇÃO
        </div>
      )}

      {separation.strategy === 'multi-store' && group && (
        <div className="muted" style={{ textAlign: 'center', marginTop: 2 }}>
          Pedido dividido em {separation.groups.length} lojas — esta folha é dessa loja
        </div>
      )}

      {/* CLIENTE */}
      <h2>Cliente</h2>
      <div style={{ fontWeight: 700 }}>{customerName}</div>
      <div className="muted">Fone: {phone}</div>

      {/* ENDEREÇO */}
      <h2>Endereço de Entrega</h2>
      <div>{addrLine1 || '—'}</div>
      {addrLine2 && <div className="muted">{addrLine2}</div>}
      {addrBairro && <div>Bairro: {addrBairro}</div>}
      <div>{addrCity}</div>
      {cep && <div>CEP: {cep}</div>}

      {/* ENVIO — destacado em caixa preta invertida (alto contraste pra térmica).
          Passa UF do destinatário pra resolver "PROMOCIONAL" → SEDEX (SP) ou PAC. */}
      <h2>Forma de Envio</h2>
      {(() => {
        const uf = (ship.state || bill.state || '').trim();
        const m = classifyShipping(shippingMethod, uf);
        const isKnown = m.kind !== 'other';
        return (
          <div
            style={{
              textAlign: 'center',
              background: '#000',
              color: '#fff',
              padding: '6px 4px',
              fontWeight: 900,
              fontSize: isKnown ? '14pt' : '11pt',
              letterSpacing: '0.5px',
              marginTop: 2,
            }}
          >
            {m.label}
          </div>
        );
      })()}
      {/* Linha original (raw) como sub-info — ajuda o cliente a identificar o serviço completo */}
      {shippingMethod && shippingMethod !== classifyShipping(shippingMethod, ship.state || bill.state).label && (
        <div className="muted" style={{ textAlign: 'center', marginTop: 2 }}>
          {shippingMethod}
        </div>
      )}
      {order.customerNote && (
        <>
          <h2>Observação do cliente</h2>
          <div style={{ fontStyle: 'italic' }}>{order.customerNote}</div>
        </>
      )}

      {/* ITENS */}
      <h2>
        Peças ({itemsToPrint.length} {itemsToPrint.length === 1 ? 'item' : 'itens'} · {totalUnits}{' '}
        {totalUnits === 1 ? 'unidade' : 'unidades'})
      </h2>
      <table className="items">
        <tbody>
          {itemsToPrint.map((it, i) => (
            <tr key={i}>
              <td className="qty">{it.quantity}×</td>
              <td>
                <div style={{ fontWeight: 600 }}>{it.productName}</div>
                <div className="sku">SKU: {it.sku || '—'}</div>
                {it.variant && <div className="variant">{it.variant}</div>}
                <div className="check-line">
                  <span className="check-box" /> Conferido
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {separation.missing.length > 0 && !group && (
        <div className="missing">⚠ ITENS SEM ESTOQUE: {separation.missing.length}</div>
      )}

      <div className="sep" />

      {/* RODAPÉ */}
      <div className="check-line">
        <span className="check-box" /> Separado por: ___________________
      </div>
      <div className="check-line">
        <span className="check-box" /> Conferido por: ___________________
      </div>
      <div className="check-line">
        <span className="check-box" /> Embalado
      </div>
      <div className="check-line">
        <span className="check-box" /> Etiqueta afixada
      </div>

      <div className="footer">
        Pedido #{order.number} · {itemsToPrint.length} item(s) · Total R${' '}
        {Number(order.total || 0).toFixed(2).replace('.', ',')}
        <br />
        Impresso em {new Date().toLocaleString('pt-BR')}
      </div>
    </div>
  );
}
