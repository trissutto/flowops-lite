'use client';

/**
 * /minha-loja/pdv/recebimentos/recibo/[id] — Comprovante PIX/dinheiro do crediário.
 *
 * Renderiza HTML imprimível 80mm (térmica) com dados da baixa.
 * Se URL tem `?autoprint=1`, dispara window.print() automaticamente após carregar.
 *
 * Chamado por printReceipt() no /minha-loja/pdv/recebimentos.
 */

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

type BaixaItem = {
  id: string;
  parcelaNumber: number;
  parcelaTotal: number;
  vencimento: string;
  valorOriginal: number;
  valorPago: number;
  jurosAplicado?: number;
  multaAplicada?: number;
  descontoAplicado?: number;
};

type Baixa = {
  id: string;
  customerName: string | null;
  customerCpf: string | null;
  metodo: string;
  valorTotal: number;
  valorPago: number;
  status: string;
  storeCode: string;
  storeName?: string;
  paidAt?: string | null;
  createdAt: string;
  items: BaixaItem[];
  troco?: number;
};

const BRL = (v: number) =>
  (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtDate = (s?: string | null) => {
  if (!s) return '-';
  const d = new Date(s);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
};

const fmtVenc = (s: string) => {
  if (!s) return '-';
  return new Date(s).toLocaleDateString('pt-BR');
};

export default function ReciboPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const autoprint = sp.get('autoprint') === '1';
  const [baixa, setBaixa] = useState<Baixa | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<Baixa>(`/crediarios/baixa/${id}`)
      .then(setBaixa)
      .catch((e) => setError(e?.message || 'Erro ao carregar'));
  }, [id]);

  // Autoprint após renderizar
  useEffect(() => {
    if (!baixa || !autoprint) return;
    const t = setTimeout(() => {
      try { window.print(); } catch {}
    }, 500);
    return () => clearTimeout(t);
  }, [baixa, autoprint]);

  if (error) {
    return <div className="p-6 text-rose-700 font-bold">Erro: {error}</div>;
  }
  if (!baixa) {
    return <div className="p-6 text-slate-500">Carregando...</div>;
  }

  const metodoLabel: Record<string, string> = {
    pix: 'PIX',
    dinheiro: 'DINHEIRO',
    cartao_debito: 'CARTÃO DÉBITO',
    cartao_credito: 'CARTÃO CRÉDITO',
  };

  return (
    <div className="recibo-wrapper">
      <div className="recibo-box">
        <div className="recibo-header">
          <div className="recibo-logo">L1 ORDER ONE</div>
          <div className="recibo-store">{baixa.storeName || baixa.storeCode}</div>
          <div className="recibo-title">COMPROVANTE DE PAGAMENTO</div>
          <div className="recibo-subtitle">Crediário · {metodoLabel[baixa.metodo] || baixa.metodo?.toUpperCase()}</div>
        </div>

        <div className="recibo-divider" />

        <div className="recibo-row">
          <span>Cliente:</span>
          <b>{baixa.customerName || '-'}</b>
        </div>
        {baixa.customerCpf && (
          <div className="recibo-row">
            <span>CPF:</span>
            <b>{baixa.customerCpf}</b>
          </div>
        )}
        <div className="recibo-row">
          <span>Data:</span>
          <b>{fmtDate(baixa.paidAt || baixa.createdAt)}</b>
        </div>
        <div className="recibo-row">
          <span>Baixa:</span>
          <b className="recibo-mono">{baixa.id.slice(0, 8).toUpperCase()}</b>
        </div>

        <div className="recibo-divider" />

        <div className="recibo-section-title">PARCELAS QUITADAS</div>
        <table className="recibo-table">
          <thead>
            <tr>
              <th>Nº</th>
              <th>Venc.</th>
              <th>Valor</th>
            </tr>
          </thead>
          <tbody>
            {baixa.items?.map((it) => (
              <tr key={it.id}>
                <td>{it.parcelaNumber}/{it.parcelaTotal}</td>
                <td>{fmtVenc(it.vencimento)}</td>
                <td className="recibo-right">{BRL(it.valorPago || it.valorOriginal)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="recibo-divider" />

        <div className="recibo-row recibo-total">
          <span>TOTAL PAGO</span>
          <b>{BRL(baixa.valorPago || baixa.valorTotal)}</b>
        </div>
        {baixa.troco != null && baixa.troco > 0 && (
          <div className="recibo-row">
            <span>Troco</span>
            <b>{BRL(baixa.troco)}</b>
          </div>
        )}

        <div className="recibo-divider" />

        <div className="recibo-footer">
          <div>Status: <b>{baixa.status === 'paid' ? 'PAGO' : baixa.status.toUpperCase()}</b></div>
          <div className="recibo-thanks">Obrigado pela preferência!</div>
        </div>
      </div>

      <style jsx global>{`
        @page {
          size: 80mm auto;
          margin: 0;
        }
        body {
          background: white;
          margin: 0;
          padding: 0;
        }
        .recibo-wrapper {
          width: 80mm;
          margin: 0 auto;
          padding: 4mm 3mm;
          font-family: 'Courier New', monospace;
          font-size: 9pt;
          color: #000;
          background: white;
        }
        .recibo-header {
          text-align: center;
          margin-bottom: 4mm;
        }
        .recibo-logo {
          font-size: 12pt;
          font-weight: 900;
          letter-spacing: 1px;
        }
        .recibo-store {
          font-size: 10pt;
          font-weight: 700;
          margin-top: 1mm;
        }
        .recibo-title {
          font-size: 10pt;
          font-weight: 900;
          margin-top: 2mm;
          text-transform: uppercase;
        }
        .recibo-subtitle {
          font-size: 8pt;
          margin-top: 0.5mm;
        }
        .recibo-divider {
          border-top: 1px dashed #000;
          margin: 2mm 0;
        }
        .recibo-row {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          padding: 0.5mm 0;
          font-size: 9pt;
        }
        .recibo-row span {
          color: #333;
        }
        .recibo-row b {
          font-weight: 700;
        }
        .recibo-mono {
          font-family: 'Courier New', monospace;
        }
        .recibo-section-title {
          text-align: center;
          font-weight: 700;
          font-size: 8.5pt;
          margin: 1.5mm 0 1mm;
          letter-spacing: 0.5px;
        }
        .recibo-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 8.5pt;
        }
        .recibo-table th {
          text-align: left;
          font-weight: 700;
          padding: 0.5mm 0;
          border-bottom: 1px solid #000;
        }
        .recibo-table th:last-child {
          text-align: right;
        }
        .recibo-table td {
          padding: 0.5mm 0;
        }
        .recibo-right {
          text-align: right;
        }
        .recibo-total {
          font-size: 11pt;
          font-weight: 900;
          margin: 1mm 0;
        }
        .recibo-footer {
          text-align: center;
          margin-top: 2mm;
          font-size: 8.5pt;
        }
        .recibo-thanks {
          margin-top: 2mm;
          font-style: italic;
        }
        @media screen {
          body { background: #f1f5f9; padding: 2rem 0; }
          .recibo-wrapper {
            border: 1px solid #cbd5e1;
            box-shadow: 0 4px 12px rgba(0,0,0,0.06);
          }
        }
        @media print {
          .no-print { display: none !important; }
        }
      `}</style>
    </div>
  );
}
