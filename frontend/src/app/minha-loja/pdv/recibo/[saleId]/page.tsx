'use client';

/**
 * /minha-loja/pdv/recibo/[saleId] — Cupom NÃO FISCAL pra impressora térmica 80mm.
 *
 * - Layout 72mm útil (papel 80mm com margem de 4mm)
 * - Fonte monospace, tudo em preto (não gasta tinta)
 * - Auto-dispara window.print() ao terminar de carregar
 * - Fecha a janela depois de imprimir/cancelar
 * - Compatível com Bematech / Epson / Elgin / Daruma 80mm
 *
 * Disclaimer: cupom NÃO FISCAL. Não substitui NFC-e/SAT.
 * Sai por dentro do Electron com impressão silenciosa quando ?autoprint=1.
 */

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

type SaleItem = {
  id: string;
  sku: string;
  ean: string | null;
  ref: string | null;
  cor: string | null;
  tamanho: string | null;
  descricao: string;
  qty: number;
  precoUnit: number;
  desconto: number;
  total: number;
};

type SalePayment = {
  id: string;
  method: string;
  valor: number;
  details: string | null;
  createdAt: string;
};

type Sale = {
  id: string;
  storeCode: string;
  storeName: string;
  vendedorName: string | null;
  customerCpf: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  status: string;
  subtotal: number;
  desconto: number;
  total: number;
  paymentMethod: string | null;
  payments?: SalePayment[];
  finalizedAt: string | null;
  items: SaleItem[];
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtMethod = (m: string): string => {
  const map: Record<string, string> = {
    dinheiro: 'DINHEIRO',
    pix: 'PIX',
    debito: 'CARTÃO DÉBITO',
    credito: 'CARTÃO CRÉDITO',
    crediario: 'CREDIÁRIO',
  };
  return map[m?.toLowerCase()] || (m || '—').toUpperCase();
};

export default function ReciboPdvPage() {
  return (
    <Suspense fallback={<div style={{ padding: 16, fontFamily: 'monospace' }}>Carregando…</div>}>
      <ReciboPdvInner />
    </Suspense>
  );
}

function ReciboPdvInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const saleId = params.saleId as string;
  const autoprint = searchParams?.get('autoprint') === '1';
  const [sale, setSale] = useState<Sale | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Sale>(`/pdv/sales/${saleId}`)
      .then((data) => setSale(data))
      .catch((e) => setError(e?.message || String(e)));
  }, [saleId]);

  // Duplica em 2 vias quando pagamento é PIX (1ª VIA LOJA + 2ª VIA CLIENTE)
  useEffect(() => {
    if (!sale) return;
    if (typeof document === 'undefined') return;
    // Detecta se a venda tem PIX (em payments[] ou paymentMethod legado)
    const isPix = (sale.payments || []).some((p: any) => String(p.method || '').toLowerCase() === 'pix')
      || String(sale.paymentMethod || '').toLowerCase() === 'pix';
    if (!isPix) return;
    const t = setTimeout(() => {
      const cupom = document.querySelector('.cupom') as HTMLElement | null;
      if (!cupom) return;
      if (document.querySelector('.cupom-via-2')) return;

      // Label da 1ª via
      const labelOriginal = document.createElement('div');
      labelOriginal.className = 'center bold';
      labelOriginal.style.cssText = 'border: 1px dashed #000; padding: 2px 4px; margin-bottom: 6px; font-size: 10px;';
      labelOriginal.textContent = '— 1ª VIA · LOJA —';
      cupom.insertBefore(labelOriginal, cupom.firstChild);

      // Clona pra 2ª via
      const clone = cupom.cloneNode(true) as HTMLElement;
      clone.classList.add('cupom-via-2');
      const labelClone = clone.querySelector('div.center.bold') as HTMLElement | null;
      if (labelClone) labelClone.textContent = '— 2ª VIA · CLIENTE —';
      clone.style.cssText = (clone.style.cssText || '') + ';page-break-before: always; break-before: page; margin-top: 4mm;';
      cupom.parentNode?.appendChild(clone);
    }, 100);
    return () => clearTimeout(t);
  }, [sale]);

  // Auto-print quando dados carregam
  useEffect(() => {
    if (!sale) return;
    const t = setTimeout(() => {
      const electron = (window as any).electronAPI;
      if (autoprint && electron?.notifyPrintReady) {
        try {
          electron.notifyPrintReady();
        } catch (e) {
          console.warn('notifyPrintReady falhou:', e);
          window.print();
        }
      } else {
        window.print();
      }
    }, 350);
    return () => clearTimeout(t);
  }, [sale, autoprint]);

  // Fecha após imprimir/cancelar
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
        Erro ao carregar venda: {error}
      </div>
    );
  }
  if (!sale) {
    return <div style={{ padding: 16 }}>Carregando...</div>;
  }

  const dataVenda = sale.finalizedAt
    ? new Date(sale.finalizedAt).toLocaleString('pt-BR')
    : new Date().toLocaleString('pt-BR');

  // Pagamentos: usa payments[] (split) se houver, senão monta um único da paymentMethod
  const pagamentos: { method: string; valor: number; details?: string | null }[] =
    sale.payments && sale.payments.length > 0
      ? sale.payments.map((p) => ({ method: p.method, valor: p.valor, details: p.details }))
      : sale.paymentMethod
      ? [{ method: sale.paymentMethod, valor: sale.total, details: null }]
      : [];

  // Tenta extrair bandeira/parcelas do JSON details
  const renderPagamentoExtra = (details: string | null | undefined): string | null => {
    if (!details) return null;
    try {
      const d = typeof details === 'string' ? JSON.parse(details) : details;
      const parts: string[] = [];
      if (d?.bandeira) parts.push(String(d.bandeira));
      if (d?.parcelas && Number(d.parcelas) > 1) parts.push(`${d.parcelas}x`);
      if (d?.fechado_depois) parts.push('a confirmar');
      return parts.length > 0 ? parts.join(' · ') : null;
    } catch {
      return null;
    }
  };

  const totalPago = pagamentos.reduce((a, p) => a + (p.valor || 0), 0);
  const troco = totalPago > sale.total ? totalPago - sale.total : 0;

  return (
    <>
      <style jsx global>{`
        @page {
          size: 80mm auto;
          margin: 3mm 2mm;
        }
        @media print {
          html, body {
            width: 76mm;
            background: #fff;
            color: #000;
          }
          .no-print { display: none !important; }
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
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
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
        <div className="center">{sale.storeName} ({sale.storeCode})</div>

        <hr className="sep" />

        {/* Selo NÃO FISCAL grande */}
        <div className="center bold" style={{ fontSize: 13, border: '1.5px solid #000', padding: '4px 0', margin: '4px 0' }}>
          CUPOM NÃO FISCAL
        </div>
        <div className="center" style={{ fontSize: 9 }}>
          Documento sem valor fiscal — apenas comprovante de venda
        </div>

        <hr className="sep" />

        {/* Dados da venda */}
        <div className="row">
          <div className="label">Venda</div>
          <div className="bold">#{sale.id.slice(-8).toUpperCase()}</div>
        </div>
        <div className="row">
          <div className="label">Data</div>
          <div>{dataVenda}</div>
        </div>
        {sale.vendedorName && (
          <div className="row">
            <div className="label">Vendedora</div>
            <div>{sale.vendedorName}</div>
          </div>
        )}

        {/* Cliente (se houver) */}
        {(sale.customerName || sale.customerCpf) && (
          <>
            <hr className="sep" />
            <div className="label">Cliente</div>
            {sale.customerName && <div className="bold">{sale.customerName}</div>}
            {sale.customerCpf && <div>CPF: {sale.customerCpf}</div>}
            {sale.customerPhone && <div>Tel: {sale.customerPhone}</div>}
          </>
        )}

        <hr className="sep" />

        {/* Itens */}
        <div className="label">
          Itens ({sale.items.length})
        </div>
        {sale.items.map((it, idx) => (
          <div key={it.id ?? `${it.sku}-${idx}`} className="item">
            <div className="bold">{it.descricao || '—'}</div>
            <div style={{ fontSize: 9, color: '#444' }}>
              SKU {it.sku}
              {it.cor ? ` · ${it.cor}` : ''}
              {it.tamanho ? ` · ${it.tamanho}` : ''}
            </div>
            <div className="row">
              <div>
                {it.qty}x {brl(it.precoUnit)}
                {it.desconto > 0 && (
                  <span style={{ fontSize: 9 }}> (- {brl(it.desconto)})</span>
                )}
              </div>
              <div className="bold">{brl(it.total)}</div>
            </div>
          </div>
        ))}

        <hr className="sep" />

        {/* Totais */}
        <div className="row">
          <div>Subtotal:</div>
          <div>{brl(sale.subtotal)}</div>
        </div>
        {sale.desconto > 0 && (
          <div className="row">
            <div>Desconto:</div>
            <div>- {brl(sale.desconto)}</div>
          </div>
        )}
        <hr className="sep" />
        <div className="row huge">
          <div>TOTAL</div>
          <div>{brl(sale.total)}</div>
        </div>

        <hr className="sep" />

        {/* Pagamento */}
        <div className="label">Pagamento</div>
        {pagamentos.map((p, i) => {
          const extra = renderPagamentoExtra(p.details);
          return (
            <div key={i} className="row">
              <div>
                {fmtMethod(p.method)}
                {extra && <span style={{ fontSize: 9 }}> ({extra})</span>}
              </div>
              <div className="bold">{brl(p.valor)}</div>
            </div>
          );
        })}
        {troco > 0 && (
          <div className="row bold">
            <div>TROCO:</div>
            <div>{brl(troco)}</div>
          </div>
        )}

        <hr className="sep" />

        {/* Rodapé */}
        <div className="center" style={{ fontSize: 9, marginTop: 6 }}>
          Obrigado pela preferência!
        </div>
        <div className="center" style={{ fontSize: 9 }}>
          Trocas em até 7 dias com este cupom.
        </div>
        <div className="center" style={{ fontSize: 8, marginTop: 6, color: '#444' }}>
          LURDS ORDER ONE · {new Date().toLocaleDateString('pt-BR')}
        </div>
      </div>
    </>
  );
}
