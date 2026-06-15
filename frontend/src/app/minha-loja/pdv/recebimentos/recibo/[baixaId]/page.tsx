'use client';

/**
 * /minha-loja/pdv/recebimentos/recibo/[baixaId] — Recibo NÃO FISCAL de baixa
 * de crediário. Cupom 80mm térmica, auto-print silencioso.
 *
 * Conteúdo:
 *  - Logo + cabeçalho loja
 *  - Selo NÃO FISCAL
 *  - Cliente (nome + cód. + telefone)
 *  - Lista de parcelas pagas (promissória, vencimento, valor + juros)
 *  - Totais (principal + juros + total)
 *  - Forma de pagamento
 *  - Loja, vendedora, data
 *  - Linha pra assinatura
 */

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

type Item = {
  id: string;
  registro: string;
  controle: string;
  numeroPromis: string | null;
  parcelaNum: number | null;
  totalParcelas: number | null;
  vencimento: string;
  valorParcela: number;
  jurosCalculado: number;
  diasAtraso: number;
  valorPago: number;
};

type Baixa = {
  id: string;
  codCliente: string | null;
  customerName: string | null;
  customerCpf: string | null;
  customerPhone: string | null;
  lojaCode: string;
  lojaName: string | null;
  userId: string | null;
  userName: string | null;
  totalParcelas: number;
  totalPrincipal: number;
  totalJuros: number;
  totalPago: number;
  formaPagamento: string;
  // Pagamento MISTO: discriminacao dinheiro+PIX (preenchidos so quando misto)
  valorDinheiro?: number | null;
  valorPix?: number | null;
  status: string;
  paidAt: string | null;
  createdAt: string;
  items: Item[];
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString('pt-BR');
  } catch {
    return iso;
  }
};

const fmtMethod = (m: string) =>
  m === 'pix'
    ? 'PIX'
    : m === 'dinheiro'
    ? 'DINHEIRO'
    : m === 'misto'
    ? 'MISTO'
    : (m || '—').toUpperCase();

export default function ReciboBaixaPage() {
  return (
    <Suspense fallback={<div style={{ padding: 16, fontFamily: 'monospace' }}>Carregando…</div>}>
      <ReciboBaixaInner />
    </Suspense>
  );
}

function ReciboBaixaInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const baixaId = params.baixaId as string;
  const autoprint = searchParams?.get('autoprint') === '1';
  const [baixa, setBaixa] = useState<Baixa | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Baixa>(`/crediarios/baixa/${baixaId}`)
      .then(setBaixa)
      .catch((e) => setError(e?.message || String(e)));
  }, [baixaId]);

  // Duplica o cupom em 2 vias (1ª VIA LOJA + 2ª VIA CLIENTE)
  useEffect(() => {
    if (!baixa) return;
    if (typeof document === 'undefined') return;
    // Aguarda render do cupom original
    const t = setTimeout(() => {
      const cupom = document.querySelector('.cupom') as HTMLElement | null;
      if (!cupom) return;
      // Evita duplicar 2x se useEffect rodar de novo
      if (document.querySelector('.cupom-via-2')) return;

      // Adiciona label da 1ª via no original
      const labelOriginal = document.createElement('div');
      labelOriginal.className = 'center bold';
      labelOriginal.style.cssText = 'border: 1px dashed #000; padding: 2px 4px; margin-bottom: 6px; font-size: 10px;';
      labelOriginal.textContent = '— 1ª VIA · LOJA —';
      cupom.insertBefore(labelOriginal, cupom.firstChild);

      // Clona pra 2ª via
      const clone = cupom.cloneNode(true) as HTMLElement;
      clone.classList.add('cupom-via-2');
      // Substitui o label da 1ª pela da 2ª
      const labelClone = clone.querySelector('div.center.bold') as HTMLElement | null;
      if (labelClone) {
        labelClone.textContent = '— 2ª VIA · CLIENTE —';
      }
      // Forca page-break entre as vias
      clone.style.cssText = (clone.style.cssText || '') + ';page-break-before: always; break-before: page; margin-top: 4mm;';
      cupom.parentNode?.appendChild(clone);
    }, 100);
    return () => clearTimeout(t);
  }, [baixa]);

  // Auto-print
  useEffect(() => {
    if (!baixa) return;
    const t = setTimeout(() => {
      const electron = (window as any).electronAPI;
      if (autoprint && electron?.notifyPrintReady) {
        try {
          electron.notifyPrintReady();
        } catch {
          window.print();
        }
      } else {
        window.print();
      }
    }, 350);
    return () => clearTimeout(t);
  }, [baixa, autoprint]);

  // Fecha após print
  useEffect(() => {
    function handleAfterPrint() {
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
        Erro ao carregar baixa: {error}
      </div>
    );
  }
  if (!baixa) {
    return <div style={{ padding: 16 }}>Carregando...</div>;
  }

  const dataBaixa = baixa.paidAt
    ? new Date(baixa.paidAt).toLocaleString('pt-BR')
    : new Date(baixa.createdAt).toLocaleString('pt-BR');

  return (
    <>
      <style jsx global>{`
        @page {
          size: 80mm auto;
          margin: 0;
        }
        @media print {
          html, body {
            width: 80mm;
            min-width: 80mm;
            max-width: 80mm;
            background: #fff;
            color: #000;
            margin: 0 !important;
            padding: 0 !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .no-print, .toolbar { display: none !important; }
          * {
            box-sizing: border-box !important;
            page-break-inside: avoid !important;
            break-inside: avoid !important;
          }
          .cupom {
            width: 100% !important;
            max-width: 80mm !important;
            margin: 0 !important;
            padding: 2mm !important;
            box-shadow: none !important;
          }
          html, body, .cupom {
            height: auto !important;
            min-height: 0 !important;
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
        .big { font-size: 14px; font-weight: bold; }
        .huge { font-size: 18px; font-weight: bold; }
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
        .item:last-child { border-bottom: none; }
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

      <div className="toolbar no-print">
        <button onClick={() => window.print()}>🖨 Imprimir</button>
        <button onClick={() => window.close()}>Fechar</button>
      </div>

      <div className="cupom">
        {/* Cabeçalho */}
        <div className="center" style={{ marginBottom: 4 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/lurds-logo.png"
            alt="Lurd's Plus Size"
            style={{ height: 36, width: 'auto', filter: 'grayscale(100%) contrast(1.4)' }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        </div>
        <div className="center bold">LURD&apos;S PLUS SIZE</div>
        <div className="center">{baixa.lojaName || ''} ({baixa.lojaCode})</div>

        <hr className="sep" />

        {/* Selo NÃO FISCAL */}
        <div className="center bold" style={{ fontSize: 13, border: '1.5px solid #000', padding: '4px 0', margin: '4px 0' }}>
          RECIBO DE CREDIÁRIO
        </div>
        <div className="center" style={{ fontSize: 9 }}>
          Documento NÃO FISCAL — comprovante interno
        </div>

        <hr className="sep" />

        {/* Cliente */}
        <div className="label">Cliente</div>
        <div className="bold">{baixa.customerName || `Cód. ${baixa.codCliente || '—'}`}</div>
        {baixa.codCliente && <div>Código: {baixa.codCliente}</div>}
        {baixa.customerCpf && <div>CPF: {baixa.customerCpf}</div>}
        {baixa.customerPhone && <div>Tel: {baixa.customerPhone}</div>}

        <hr className="sep" />

        {/* Parcelas */}
        <div className="label">
          Parcelas pagas ({baixa.items.length})
        </div>
        {baixa.items.map((it) => (
          <div key={it.id} className="item">
            <div className="row bold">
              <div>
                {it.numeroPromis || `${it.registro}/${it.controle}`}
              </div>
              <div>{brl(it.valorPago)}</div>
            </div>
            <div className="row" style={{ fontSize: 9 }}>
              <div>Venc. {fmtDate(it.vencimento)}</div>
              {it.diasAtraso > 0 && <div>{it.diasAtraso}d atraso</div>}
            </div>
            {it.jurosCalculado > 0 && (
              <div className="row" style={{ fontSize: 9 }}>
                <div>Principal: {brl(it.valorParcela)}</div>
                <div>+ juros {brl(it.jurosCalculado)}</div>
              </div>
            )}
          </div>
        ))}

        <hr className="sep" />

        {/* Totais */}
        <div className="row">
          <div>Principal:</div>
          <div>{brl(baixa.totalPrincipal)}</div>
        </div>
        {baixa.totalJuros > 0 && (
          <div className="row">
            <div>Juros:</div>
            <div>{brl(baixa.totalJuros)}</div>
          </div>
        )}
        <hr className="sep" />
        <div className="row huge">
          <div>TOTAL</div>
          <div>{brl(baixa.totalPago)}</div>
        </div>

        <hr className="sep" />

        {/* Pagamento */}
        <div className="row big">
          <div>Forma:</div>
          <div>{fmtMethod(baixa.formaPagamento)}</div>
        </div>

        {/* Discriminacao MISTO: dinheiro + PIX (so se forma=misto) */}
        {baixa.formaPagamento === 'misto' && (
          <div style={{ paddingLeft: 12, fontSize: 10, marginTop: 2 }}>
            {baixa.valorDinheiro != null && baixa.valorDinheiro > 0 && (
              <div className="row">
                <div>↳ Em dinheiro:</div>
                <div className="bold">{brl(baixa.valorDinheiro)}</div>
              </div>
            )}
            {baixa.valorPix != null && baixa.valorPix > 0 && (
              <div className="row">
                <div>↳ Em PIX:</div>
                <div className="bold">{brl(baixa.valorPix)}</div>
              </div>
            )}
          </div>
        )}

        <div className="row" style={{ fontSize: 9 }}>
          <div>Status:</div>
          <div className="bold">{baixa.status === 'paid' ? '✓ PAGO' : 'PENDENTE'}</div>
        </div>

        <hr className="sep" />

        {/* Loja + vendedora */}
        <div className="row" style={{ fontSize: 9 }}>
          <div className="label">Loja</div>
          <div>{baixa.lojaName} ({baixa.lojaCode})</div>
        </div>
        {baixa.userName && (
          <div className="row" style={{ fontSize: 9 }}>
            <div className="label">Atendente</div>
            <div>{baixa.userName}</div>
          </div>
        )}
        <div className="row" style={{ fontSize: 9 }}>
          <div className="label">Data</div>
          <div>{dataBaixa}</div>
        </div>

        <hr className="sep" />

        {/* Assinatura */}
        <div style={{ marginTop: 12 }}>
          ____________________________________
        </div>
        <div className="center" style={{ fontSize: 9 }}>
          Assinatura do cliente
        </div>

        <div className="center" style={{ fontSize: 8, marginTop: 8, color: '#444' }}>
          LURDS ORDER ONE · Baixa #{baixa.id.slice(0, 8)}
        </div>
        <div className="center" style={{ fontSize: 8, color: '#444' }}>
          Promissórias devolvidas ao cliente
        </div>
      </div>
    </>
  );
}
