'use client';

/**
 * /minha-loja/pdv/recibo-devolucao/[returnId]
 *
 * Comprovante de devolucao em DINHEIRO ou PIX. Formato cupom termico 80mm.
 * Imprime SEMPRE 2 VIAS:
 *   1ª VIA — CAIXA   (assinada pela cliente, fica na loja)
 *   2ª VIA — CLIENTE (cliente leva)
 *
 * ?autoprint=1 dispara window.print() automaticamente.
 */

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

type ReturnInfo = {
  ret: {
    id: string;
    storeCode: string;
    storeName: string;
    modo: 'dinheiro' | 'pix' | 'troca' | 'credito';
    valorTotal: number;
    motivo: string | null;
    customerName: string | null;
    customerCpf: string | null;
    userName: string | null;
    createdAt: string;
    originalSaleNumber: string | null;
    items: Array<{
      id: string;
      sku: string;
      ref: string | null;
      cor: string | null;
      tamanho: string | null;
      descricao: string;
      qty: number;
      precoUnit: number;
      total: number;
    }>;
  };
  originalSale: {
    id: string;
    nfceNumber: string | null;
    total: number;
    finalizedAt: string | null;
    paymentMethod: string | null;
  } | null;
};

export default function ReciboDevolucaoPage() {
  const params = useParams<{ returnId: string }>();
  const searchParams = useSearchParams();
  const returnId = decodeURIComponent(params.returnId || '');
  const autoprint = searchParams.get('autoprint') === '1';
  const [info, setInfo] = useState<ReturnInfo | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!returnId) return;
    api<ReturnInfo>(`/pdv/devolucao/return/${encodeURIComponent(returnId)}`)
      .then((d) => setInfo(d))
      .catch((e) => setErr(e?.message || 'Devolucao nao encontrada'));
  }, [returnId]);

  // Auto-imprime quando ?autoprint=1 e dados carregaram (e fecha popup depois)
  useEffect(() => {
    if (!(autoprint && info && !err)) return;
    const t = setTimeout(() => {
      // No app desktop, o Electron imprime (notifyPrintReady) — chamar
      // window.print() junto duplicava o job (saíam 4 vias em vez de 2).
      const electron = (window as any).electronAPI;
      if (electron?.notifyPrintReady) {
        try { electron.notifyPrintReady(); } catch { try { window.print(); } catch {} }
      } else {
        try { window.print(); } catch {}
      }
    }, 600);
    const onAfter = () => {
      try { setTimeout(() => window.close(), 200); } catch {}
    };
    window.addEventListener('afterprint', onAfter);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', onAfter);
    };
  }, [autoprint, info, err]);

  if (err) return <div className="p-4 text-rose-700 font-bold">{err}</div>;
  if (!info) return <div className="p-4 text-slate-500">Carregando…</div>;

  return (
    <>
      <style jsx global>{`
        @media print {
          body, html { margin: 0; padding: 0; background: white !important; }
          @page { size: 80mm auto; margin: 0; }
          .no-print { display: none !important; }
          .via-cut { page-break-after: always; }
        }
      `}</style>

      <Via info={info} tipo="1a VIA — CAIXA" />
      <div className="via-cut text-center py-2 text-[8pt] text-slate-500 border-t border-dashed border-black mt-2 mx-auto" style={{ width: '80mm', fontFamily: 'monospace' }}>
        ✂ - - - - - - - - corte aqui - - - - - - - - ✂
      </div>
      <Via info={info} tipo="2a VIA — CLIENTE" />

      <div className="no-print max-w-md mx-auto mt-4 flex gap-2 justify-center">
        <button onClick={() => window.print()} className="px-4 py-2 bg-rose-600 text-white rounded font-bold">
          🖨️ Imprimir 2 vias
        </button>
        <button onClick={() => window.close()} className="px-4 py-2 bg-slate-200 rounded font-bold">
          Fechar
        </button>
      </div>
    </>
  );
}

function Via({ info, tipo }: { info: ReturnInfo; tipo: string }) {
  const r = info.ret;
  const isCliente = tipo.includes('CLIENTE');
  const modoLabel = r.modo === 'pix' ? 'PIX' : r.modo === 'dinheiro' ? 'DINHEIRO' : r.modo.toUpperCase();
  const dataHora = new Date(r.createdAt).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  return (
    <div className="bg-white p-3 mx-auto" style={{ width: '80mm', fontFamily: 'monospace', fontSize: '11pt' }}>
      <div className="text-center mb-1">
        <div className="font-black text-base">LURD'S PLUS SIZE</div>
        <div className="text-[10pt]">{r.storeName} · {r.storeCode}</div>
        <div className="text-[9pt] text-slate-700">{dataHora}</div>
      </div>

      <div className="text-center text-[9pt] font-black bg-black text-white py-0.5 my-1">
        {tipo}
      </div>

      <div className="border-y-2 border-black py-1.5 my-2 text-center">
        <div className="text-[9pt] font-bold">COMPROVANTE DE DEVOLUCAO</div>
        <div className="text-base font-black">{modoLabel}</div>
        <div className="text-xl font-black mt-0.5">{brl(r.valorTotal)}</div>
      </div>

      <div className="text-[10pt] mb-2 space-y-0.5">
        <div className="flex justify-between">
          <span>Devolucao no:</span>
          <span className="font-mono font-bold">{r.id.slice(0, 8).toUpperCase()}</span>
        </div>
        {r.originalSaleNumber && (
          <div className="flex justify-between">
            <span>Venda original:</span>
            <span className="font-mono">{r.originalSaleNumber}</span>
          </div>
        )}
        {info.originalSale?.paymentMethod && (
          <div className="flex justify-between">
            <span>Pgto original:</span>
            <span className="uppercase font-bold">{info.originalSale.paymentMethod}</span>
          </div>
        )}
        {r.customerName && (
          <div className="flex justify-between">
            <span>Cliente:</span>
            <span className="font-bold truncate max-w-[40mm]">{r.customerName}</span>
          </div>
        )}
        {r.customerCpf && (
          <div className="flex justify-between">
            <span>CPF:</span>
            <span className="font-mono">{r.customerCpf}</span>
          </div>
        )}
        {r.userName && (
          <div className="flex justify-between">
            <span>Atendente:</span>
            <span className="truncate max-w-[40mm]">{r.userName}</span>
          </div>
        )}
      </div>

      <div className="border-t border-dashed border-black pt-1 mb-2">
        <div className="text-[9pt] font-bold mb-1">PECAS DEVOLVIDAS:</div>
        {r.items.map((it) => (
          <div key={it.id} className="text-[10pt] mb-1">
            <div className="flex justify-between">
              <span className="font-bold">{it.ref || it.sku} {it.cor} {it.tamanho}</span>
              <span>{it.qty}x</span>
            </div>
            <div className="text-[9pt] text-slate-700 truncate">{it.descricao}</div>
            <div className="flex justify-between text-[9pt]">
              <span>Unit {brl(it.precoUnit)}</span>
              <span className="font-bold">{brl(it.total)}</span>
            </div>
          </div>
        ))}
      </div>

      {r.motivo && (
        <div className="border-t border-dashed border-black pt-1 mb-2 text-[10pt]">
          <div className="font-bold">Motivo:</div>
          <div className="italic">{r.motivo}</div>
        </div>
      )}

      {r.modo === 'pix' && (
        <div className="border-y border-black py-1 my-2 text-center text-[9pt] font-bold">
          *** REEMBOLSO VIA PIX ***
          <br />
          <span className="font-normal">Confirmar transferencia antes de assinar</span>
        </div>
      )}

      {/* Assinatura — só pede na via CAIXA. Via CLIENTE leva o recibo já carimbado */}
      {!isCliente ? (
        <div className="mt-4 pt-2 border-t-2 border-black text-center text-[9pt]">
          <div className="mb-6"></div>
          <div className="border-t border-black mx-4 pt-0.5">
            Assinatura da cliente
          </div>
          <div className="mt-1 text-[8pt]">
            {r.customerName || '________________________________'}
          </div>
          {r.customerCpf && <div className="text-[8pt]">CPF {r.customerCpf}</div>}
        </div>
      ) : (
        <div className="mt-3 pt-2 border-t-2 border-black text-center text-[9pt]">
          <div className="font-bold">VIA DO CLIENTE</div>
          <div className="text-[8pt] mt-1">Guarde este comprovante.</div>
          <div className="text-[8pt]">Em caso de duvida, apresente na loja.</div>
        </div>
      )}

      <div className="text-center text-[8pt] mt-2 text-slate-700">
        {!isCliente && 'Conferi o valor e as pecas listadas acima.'}
        <br />
        FlowOps · LURD'S Plus Size
      </div>
    </div>
  );
}
