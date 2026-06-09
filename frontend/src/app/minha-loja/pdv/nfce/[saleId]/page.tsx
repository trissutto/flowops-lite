'use client';

/**
 * /minha-loja/pdv/nfce/[saleId] — Reimpressão de DANFE NFC-e.
 *
 * - Renderiza cupom fiscal completo: chave, QR Code SEFAZ-SP, protocolo
 * - Layout 78mm pra impressora térmica 80mm
 * - Auto-dispara window.print() ao carregar (mesma UX da emissão)
 * - Reaproveita estrutura do PDV principal (imprimirDanfeNfce)
 * - Se sale não tem NFCe autorizada, mostra aviso e botão pra ver cupom não fiscal
 */

import { Suspense, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';

type SaleItem = {
  id: string;
  sku: string;
  ref: string | null;
  cor: string | null;
  tamanho: string | null;
  descricao: string;
  qty: number;
  total: number;
};

type Sale = {
  id: string;
  storeCode: string;
  storeName: string;
  customerCpf: string | null;
  customerName: string | null;
  total: number;
  paymentMethod: string | null;
  nfceNumber: string | null;
  nfceSerie: string | null;
  nfceChave: string | null;
  nfceProtocolo: string | null;
  nfceAutorizadaEm: string | null;
  nfceQrUrl: string | null;
  nfceXml: string | null;
  items: SaleItem[];
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const formatCnpj = (c: string) => {
  const d = c.replace(/\D/g, '').padStart(14, '0').slice(0, 14);
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`;
};

export default function ReimprimirNfcePage() {
  return (
    <Suspense fallback={<div style={{ padding: 16, fontFamily: 'monospace' }}>Carregando…</div>}>
      <ReimprimirNfceInner />
    </Suspense>
  );
}

function ReimprimirNfceInner() {
  const params = useParams<{ saleId: string }>();
  const saleId = params?.saleId as string;
  const [sale, setSale] = useState<Sale | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!saleId) return;
    (async () => {
      try {
        // Busca a venda completa (mesma rota usada pelo recibo)
        const data = await api<Sale>(`/pdv/sales/${saleId}`);
        setSale(data);
      } catch (e: any) {
        setError(e?.message || 'Erro ao carregar venda');
      }
    })();
  }, [saleId]);

  // Quando a sale carrega e tem NFCe autorizada → dispara print
  useEffect(() => {
    if (!sale || !sale.nfceChave) return;
    // Espera o QR code renderizar antes de imprimir
    const t = setTimeout(() => {
      try { window.print(); } catch {}
    }, 600);
    return () => clearTimeout(t);
  }, [sale]);

  if (error) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui', color: '#b91c1c' }}>
        <h2>Erro ao carregar venda</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!sale) {
    return <div style={{ padding: 16, fontFamily: 'monospace' }}>Carregando venda…</div>;
  }

  // Sem NFC-e autorizada — mostra aviso (não dá pra reimprimir cupom fiscal)
  if (!sale.nfceChave) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui', maxWidth: 600, margin: '40px auto' }}>
        <h2 style={{ color: '#b91c1c' }}>NFC-e não disponível</h2>
        <p>Esta venda ainda não tem cupom fiscal autorizado pela SEFAZ.</p>
        <p style={{ marginTop: 12 }}>
          Você pode:
        </p>
        <ul>
          <li>
            <a href={`/minha-loja/pdv/recibo/${saleId}`} style={{ color: '#2563eb' }}>
              Imprimir cupom não fiscal (recibo de venda)
            </a>
          </li>
          <li>
            <a href={`/minha-loja/pdv?reabrir=${saleId}`} style={{ color: '#2563eb' }}>
              Voltar ao PDV pra emitir a NFC-e
            </a>
          </li>
        </ul>
      </div>
    );
  }

  /* ─────── Dados extraídos do XML autorizado (fonte de verdade) ─────── */
  const xml = sale.nfceXml || '';
  const emitBlock = xml.match(/<emit>([\s\S]*?)<\/emit>/)?.[1] || '';
  const xmlCnpjRaw = (emitBlock.match(/<CNPJ>([^<]+)<\/CNPJ>/)?.[1] || '').trim();
  const xmlRazao = (emitBlock.match(/<xNome>([^<]+)<\/xNome>/)?.[1] || '').trim();
  const xmlFant = (emitBlock.match(/<xFant>([^<]+)<\/xFant>/)?.[1] || '').trim();

  const RAZAO_SOCIAL = xmlRazao || 'T.O. RISSUTTO LTDA';
  const NOME_FANTASIA = xmlFant || "LURD'S PLUS SIZE";
  const CNPJ = xmlCnpjRaw ? formatCnpj(xmlCnpjRaw) : '—';

  /* ─────── QR Code: do XML (fonte de verdade) com fallback pra nfceQrUrl ─────── */
  const qrFromXml = (xml.match(/<qrCode>\s*<!\[CDATA\[([^\]]+)\]\]>\s*<\/qrCode>/)?.[1] || '').trim();
  const qrUrl = qrFromXml || sale.nfceQrUrl || '';
  const qrImgUrl = qrUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=0&data=${encodeURIComponent(qrUrl)}`
    : '';

  const dataAut = sale.nfceAutorizadaEm
    ? new Date(sale.nfceAutorizadaEm).toLocaleString('pt-BR')
    : '—';

  const qtdItens = sale.items.reduce((s, it) => s + (Number(it.qty) || 0), 0);

  return (
    <>
      <style jsx global>{`
        @page { size: 80mm auto; margin: 0; }
        body {
          font-family: 'Courier New', monospace;
          font-size: 11px;
          font-weight: 600;
          width: 78mm;
          margin: 0;
          padding: 2mm;
          color: #000;
          line-height: 1.25;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .nfce .center { text-align: center; }
        .nfce .bold { font-weight: 900; }
        .nfce .lg { font-size: 13px; font-weight: 900; }
        .nfce .xl { font-size: 15px; font-weight: 900; }
        .nfce .sm { font-size: 10px; }
        .nfce .xs { font-size: 9px; }
        .nfce .row { display: flex; justify-content: space-between; gap: 4px; color: #000; }
        .nfce .sep { border-top: 2px dashed #000; margin: 4px 0; }
        .nfce .sep-solid { border-top: 2px solid #000; margin: 4px 0; }
        .nfce .chave { font-size: 10px; font-weight: 900; word-break: break-all; line-height: 1.4; letter-spacing: 0.3px; color: #000; }
        .nfce .qr { display: block; margin: 6px auto; }
        .nfce .item { margin: 3px 0; }
        .nfce .item-line1 { font-weight: 900; font-size: 11px; color: #000; }
        .nfce .item-var { font-size: 10px; color: #000; padding-left: 12px; font-weight: 600; }
        .nfce .item-line2 { display: flex; justify-content: space-between; font-size: 11px; padding-left: 12px; font-weight: 700; color: #000; }

        /* Botão flutuante de imprimir — só na tela, não imprime */
        .reprint-btn {
          position: fixed; top: 12px; right: 12px; z-index: 999;
          padding: 8px 16px; background: #2563eb; color: #fff;
          border: none; border-radius: 8px; cursor: pointer;
          font-family: system-ui; font-size: 14px; font-weight: 700;
          box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        }
        .reprint-btn:hover { background: #1d4ed8; }
        @media print { .reprint-btn { display: none; } }
      `}</style>

      <button className="reprint-btn" onClick={() => window.print()}>
        🖨️ Imprimir
      </button>

      <div className="nfce">
        {/* Cabeçalho empresa */}
        <div className="center bold lg">{NOME_FANTASIA}</div>
        <div className="center xs">{RAZAO_SOCIAL}</div>
        <div className="center xs">CNPJ: {CNPJ}</div>
        <div className="center xs">{sale.storeName || ''}</div>
        <div className="sep-solid" />

        {/* Tipo de documento */}
        <div className="center bold sm">DANFE NFC-e</div>
        <div className="center xs">Documento Auxiliar da Nota Fiscal</div>
        <div className="center xs">Eletrônica para Consumidor Final</div>
        <div className="center xs">não permite aproveitamento de crédito de ICMS</div>
        <div className="sep" />

        {/* Itens */}
        <div className="row sm bold">
          <span>#  CÓDIGO  DESCRIÇÃO</span>
          <span>VL TOTAL</span>
        </div>
        <div className="row xs">
          <span>QTD x UNIT</span>
          <span></span>
        </div>
        <div className="sep" />
        {sale.items.map((it, idx) => {
          const codigo = (it.ref || it.sku || '').toString().slice(0, 14);
          const desc = (it.descricao || it.ref || it.sku || '').toString().slice(0, 38);
          const variante = [it.cor, it.tamanho].filter(Boolean).join('/');
          const unit = (Number(it.total) || 0) / Math.max(1, Number(it.qty) || 1);
          return (
            <div className="item" key={it.id}>
              <div className="item-line1">{idx + 1} {codigo} {desc}</div>
              {variante && <div className="item-var">{variante}</div>}
              <div className="item-line2">
                <span>{it.qty} UN x {brl(unit)}</span>
                <span>{brl(it.total)}</span>
              </div>
            </div>
          );
        })}
        <div className="sep" />

        {/* Totais */}
        <div className="row sm"><span>QTD. TOTAL DE ITENS</span><span>{qtdItens}</span></div>
        <div className="row bold lg"><span>VALOR TOTAL R$</span><span>{brl(sale.total)}</span></div>
        <div className="row sm"><span>FORMA PAGAMENTO</span><span>VALOR PAGO</span></div>
        <div className="row sm bold">
          <span>{(sale.paymentMethod || 'SPLIT').toUpperCase()}</span>
          <span>{brl(sale.total)}</span>
        </div>
        <div className="sep" />

        {/* Tributos (Lei 12.741) */}
        <div className="center xs">Tributos totais incidentes (Lei Federal 12.741/2012):</div>
        <div className="center xs bold">
          R$ {(sale.total * 0.0996).toFixed(2).replace('.', ',')} (Fonte: IBPT)
        </div>
        <div className="sep" />

        {/* Consumidor */}
        {sale.customerCpf ? (
          <>
            <div className="sm bold">CONSUMIDOR</div>
            <div className="sm">
              CPF: {sale.customerCpf}
              {sale.customerName && ` - ${sale.customerName}`}
            </div>
          </>
        ) : (
          <div className="sm bold">CONSUMIDOR NÃO IDENTIFICADO</div>
        )}
        <div className="sep" />

        {/* Identificação da NFC-e */}
        <div className="center sm bold">
          NFC-e nº {sale.nfceNumber || '—'} - Série {sale.nfceSerie || '1'}
        </div>
        <div className="center xs">Emissão: {dataAut}</div>
        <div className="center xs">Via Consumidor — REIMPRESSÃO</div>
        <div className="sep" />

        {/* Chave de acesso */}
        <div className="center xs">Consulte pela Chave de Acesso em:</div>
        <div className="center xs bold">www.nfce.fazenda.sp.gov.br</div>
        <div className="chave center">{sale.nfceChave || ''}</div>
        <div className="sep" />

        {/* QR Code */}
        {qrImgUrl && (
          <img src={qrImgUrl} className="qr" alt="QR Code NFC-e" width={180} height={180} />
        )}

        {/* Protocolo */}
        <div className="center xs">Protocolo de autorização:</div>
        <div className="center xs bold">{sale.nfceProtocolo || '—'}</div>
        <div className="sep" />

        {/* Rodapé */}
        <div className="center sm bold">Obrigado pela preferência!</div>
        <div className="center xs">Volte sempre 💖</div>
      </div>
    </>
  );
}
