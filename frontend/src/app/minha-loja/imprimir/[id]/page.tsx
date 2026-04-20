'use client';

/**
 * /minha-loja/imprimir/[id] — Cupom de separação pra impressora térmica 80mm.
 *
 * - Layout 72mm útil (papel 80mm com margem)
 * - Fonte monospace
 * - Sem cores, sem ícones, sem nada que gaste tinta/desbote
 * - Auto-dispara window.print() ao terminar de carregar
 * - Fecha a janela depois de imprimir (ou cancelar)
 *
 * Compatível com qualquer impressora padrão Windows configurada
 * pra papel 80mm (Bematech MP-4200, Epson TM-T20, Elgin i9, Daruma DR800, etc).
 */

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { parseShippingAddress, formatPhone } from '@/lib/format-address';

interface PickItem {
  id?: string;
  sku: string;
  productName?: string | null;
  variant?: string | null;
  quantity: number;
}
interface PickDetail {
  id: string;
  status: string;
  trackingCode: string | null;
  carrier: string | null;
  createdAt: string;
  store: { id: string; code: string; name: string };
  order: {
    id: string;
    wcOrderId: number | null;
    wcOrderNumber: string | null;
    customerName: string | null;
    customerPhone: string | null;
    shippingCep: string | null;
    shippingAddress: string | null;
    totalAmount: number | null;
    wcDateCreated?: string | null;
    items: PickItem[];
  };
}

export default function ImprimirCupomPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const autoprint = searchParams?.get('autoprint') === '1';
  const [pick, setPick] = useState<PickDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<PickDetail>(`/pick-orders/${id}`)
      .then((data) => setPick(data))
      .catch((e) => setError(e.message));
  }, [id]);

  // Quando os dados carregam, dispara a impressão.
  // Se vier ?autoprint=1 E o Electron estiver disponível (silentPrintHTML),
  // imprime SILENCIOSO na térmica configurada (sem preview). Senão faz window.print() normal.
  useEffect(() => {
    if (!pick) return;
    const t = setTimeout(async () => {
      const electron = (window as any).electronAPI;
      if (autoprint && electron?.silentPrintHTML) {
        try {
          await electron.silentPrintHTML(document.documentElement.outerHTML);
        } catch (e) {
          console.warn('silentPrintHTML falhou, caindo pra window.print():', e);
          window.print();
        }
        // Fecha a janela (hidden ou popup) depois do print silencioso
        setTimeout(() => {
          try { window.close(); } catch {}
        }, 500);
      } else {
        window.print();
      }
    }, 250);
    return () => clearTimeout(t);
  }, [pick, autoprint]);

  // Após print (ou cancelamento), fecha a janela
  useEffect(() => {
    function handleAfterPrint() {
      // Fecha somente se foi aberto via window.open (popup) OU se for autoprint (hidden win)
      setTimeout(() => {
        if (window.opener || autoprint) {
          try { window.close(); } catch {}
        }
      }, 300);
    }
    window.addEventListener('afterprint', handleAfterPrint);
    return () => window.removeEventListener('afterprint', handleAfterPrint);
  }, [autoprint]);

  if (error) {
    return (
      <div style={{ padding: 16, fontFamily: 'sans-serif' }}>
        Erro ao carregar pedido: {error}
      </div>
    );
  }
  if (!pick) {
    return <div style={{ padding: 16 }}>Carregando...</div>;
  }

  const addr = parseShippingAddress(pick.order.shippingAddress);
  const orderNum = pick.order.wcOrderNumber ?? pick.order.wcOrderId ?? '—';
  const dataPedido = pick.order.wcDateCreated
    ? new Date(pick.order.wcDateCreated).toLocaleString('pt-BR')
    : new Date(pick.createdAt).toLocaleString('pt-BR');
  const dataImpressao = new Date().toLocaleString('pt-BR');

  return (
    <>
      {/* CSS específico — 80mm térmica */}
      <style jsx global>{`
        @page {
          size: 80mm auto;
          margin: 3mm 2mm;
        }
        @media print {
          html,
          body {
            width: 76mm;
            background: #fff;
            color: #000;
          }
          .no-print {
            display: none !important;
          }
        }
        body {
          font-family: 'Courier New', Courier, monospace;
          font-size: 11px;
          line-height: 1.35;
          color: #000;
          background: #f3f4f6;
          margin: 0;
        }
        .cupom {
          width: 72mm;
          margin: 0 auto;
          background: #fff;
          padding: 4mm 3mm;
          box-sizing: border-box;
        }
        @media screen {
          .cupom {
            margin: 16px auto;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
          }
        }
        .center { text-align: center; }
        .right { text-align: right; }
        .bold { font-weight: bold; }
        .big {
          font-size: 16px;
          font-weight: bold;
        }
        .huge {
          font-size: 22px;
          font-weight: bold;
        }
        .sep {
          border: none;
          border-top: 1px dashed #000;
          margin: 4px 0;
        }
        .row {
          display: flex;
          justify-content: space-between;
          gap: 4px;
        }
        .label {
          text-transform: uppercase;
          font-size: 9px;
          letter-spacing: 0.5px;
        }
        .item {
          margin: 4px 0;
          padding-bottom: 3px;
          border-bottom: 1px dotted #999;
        }
        .item:last-child {
          border-bottom: none;
        }
        .qty {
          font-size: 14px;
          font-weight: bold;
        }
        .sku {
          font-size: 9px;
          color: #444;
        }
        .checkbox {
          display: inline-block;
          width: 11px;
          height: 11px;
          border: 1.5px solid #000;
          margin-right: 4px;
          vertical-align: middle;
        }
        .toolbar {
          position: fixed;
          top: 8px;
          right: 8px;
          display: flex;
          gap: 6px;
        }
        .toolbar button {
          font-family: sans-serif;
          font-size: 12px;
          padding: 6px 12px;
          border: 1px solid #ccc;
          background: #fff;
          cursor: pointer;
          border-radius: 4px;
        }
      `}</style>

      {/* Botões de fallback (não imprimem) */}
      <div className="toolbar no-print">
        <button onClick={() => window.print()}>🖨 Imprimir</button>
        <button onClick={() => window.close()}>Fechar</button>
      </div>

      <div className="cupom">
        {/* Cabeçalho */}
        <div className="center bold">FLOWOPS · SEPARAÇÃO</div>
        <div className="center">{pick.store.name} ({pick.store.code})</div>
        <div className="center" style={{ fontSize: 9 }}>
          Impresso em {dataImpressao}
        </div>

        <hr className="sep" />

        {/* Pedido */}
        <div className="center label">PEDIDO</div>
        <div className="center huge">#{orderNum}</div>
        <div className="center" style={{ fontSize: 9 }}>
          Criado em {dataPedido}
        </div>

        <hr className="sep" />

        {/* Cliente */}
        <div className="label">Cliente</div>
        <div className="bold">{pick.order.customerName ?? '—'}</div>
        {pick.order.customerPhone && (
          <div>Tel: {formatPhone(pick.order.customerPhone)}</div>
        )}

        <hr className="sep" />

        {/* Endereço */}
        <div className="label">Endereço de Entrega</div>
        {addr?.recipientName && <div>{addr.recipientName}</div>}
        {addr?.streetLine && <div>{addr.streetLine}</div>}
        {addr?.complement && <div>Compl: {addr.complement}</div>}
        {addr?.neighborhood && <div>Bairro: {addr.neighborhood}</div>}
        {addr?.cityState && <div>{addr.cityState}</div>}
        {(addr?.cep || pick.order.shippingCep) && (
          <div className="bold">CEP: {addr?.cep ?? pick.order.shippingCep}</div>
        )}
        {!addr?.streetLine && addr?.oneLiner && (
          <div style={{ wordBreak: 'break-word' }}>{addr.oneLiner}</div>
        )}

        <hr className="sep" />

        {/* Itens */}
        <div className="label">
          Itens ({pick.order.items.length}) — separar:
        </div>
        {pick.order.items.map((it, idx) => (
          <div key={it.id ?? `${it.sku}-${idx}`} className="item">
            <div className="row">
              <div>
                <span className="checkbox" />
                <span className="qty">{it.quantity}x</span>
              </div>
            </div>
            <div className="bold">{it.productName ?? '—'}</div>
            {it.variant && <div>{it.variant}</div>}
            <div className="sku">SKU: {it.sku}</div>
          </div>
        ))}

        <hr className="sep" />

        {/* Total */}
        {pick.order.totalAmount != null && (
          <div className="row bold big">
            <div>TOTAL:</div>
            <div>R$ {Number(pick.order.totalAmount).toFixed(2).replace('.', ',')}</div>
          </div>
        )}

        <hr className="sep" />

        {/* Conferência */}
        <div className="label">Conferência</div>
        <div style={{ marginTop: 6 }}>
          Separado por: ______________________
        </div>
        <div style={{ marginTop: 8 }}>
          Conferido por: _____________________
        </div>
        <div style={{ marginTop: 8 }}>
          Data/Hora: ________________________
        </div>

        <hr className="sep" />

        {/* Rastreio se já enviado */}
        {pick.trackingCode && (
          <>
            <div className="label">Rastreio</div>
            <div className="bold">{pick.trackingCode}</div>
            {pick.carrier && <div>{pick.carrier}</div>}
            <hr className="sep" />
          </>
        )}

        <div className="center" style={{ fontSize: 9, marginTop: 6 }}>
          LURDS ORDER ONE · Pick #{pick.id.slice(0, 8)}
        </div>
      </div>
    </>
  );
}
