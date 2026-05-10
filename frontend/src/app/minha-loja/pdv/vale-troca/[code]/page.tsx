'use client';

/**
 * /minha-loja/pdv/vale-troca/[code]
 *
 * Imprime o VALE-TROCA pra cliente levar. Formato cupom térmico 80mm.
 * Mostra:
 *  - LURD'S Plus Size (header)
 *  - VALE-TROCA em destaque
 *  - Código TROCA-XXXXXXXX (gigante, mono, fácil de ler)
 *  - Valor disponível
 *  - Validade
 *  - Instruções de uso
 *
 * ?autoprint=1 dispara window.print() automaticamente (chamado por electronAPI
 * silentPrintUrl ou iframe oculto no fluxo da devolução).
 *
 * Cliente leva esse cupom impresso e bipa o código no PDV de qualquer loja
 * pra abater de uma compra futura.
 */

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

type CreditInfo = {
  code: string;
  valor: number;
  status: string;
  validade: string | null;
  vencido: boolean;
  usado: boolean;
  origem: { saleId: string; store: string };
};

export default function ValeImprimirPage() {
  const params = useParams<{ code: string }>();
  const searchParams = useSearchParams();
  const code = decodeURIComponent(params.code || '');
  const autoprint = searchParams.get('autoprint') === '1';
  const [info, setInfo] = useState<CreditInfo | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!code) return;
    api<CreditInfo>(`/pdv/devolucao/credito/${encodeURIComponent(code)}`)
      .then((d) => setInfo(d))
      .catch((e) => setErr(e?.message || 'Vale não encontrado'));
  }, [code]);

  // Auto-imprime quando ?autoprint=1 e dados carregaram
  useEffect(() => {
    if (autoprint && info && !err) {
      const t = setTimeout(() => {
        try { window.print(); } catch {}
      }, 600);
      return () => clearTimeout(t);
    }
  }, [autoprint, info, err]);

  if (err) {
    return (
      <div className="p-4 text-rose-700 font-bold">{err}</div>
    );
  }

  if (!info) {
    return (
      <div className="p-4 text-slate-500">Carregando…</div>
    );
  }

  const validade = info.validade
    ? new Date(info.validade).toLocaleDateString('pt-BR')
    : null;

  return (
    <>
      {/* CSS específico pra impressão térmica 80mm.
          @page com size 80mm + margin zero, font compacta, sem decoração */}
      <style jsx global>{`
        @page {
          size: 80mm auto;
          margin: 0;
        }
        @media print {
          html, body {
            margin: 0 !important;
            padding: 0 !important;
            background: white !important;
            width: 80mm !important;
          }
          body * { visibility: hidden; }
          #vale-content, #vale-content * { visibility: visible; }
          #vale-content {
            position: absolute;
            left: 0;
            top: 0;
            width: 80mm;
            padding: 4mm 3mm;
            font-family: 'Courier New', monospace;
            color: black;
          }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="min-h-screen bg-slate-100 p-4 flex items-start justify-center">
        <div className="w-[300px] bg-white shadow-lg" id="vale-content">
          {/* HEADER */}
          <div className="text-center border-b-2 border-dashed border-black pb-2 mb-2">
            <div className="text-xl font-black tracking-wider">LURD'S</div>
            <div className="text-[10px] uppercase tracking-widest">Plus Size</div>
          </div>

          {/* TÍTULO */}
          <div className="text-center my-3">
            <div className="text-[10px] uppercase tracking-widest text-slate-700">
              Vale-Troca
            </div>
            <div className="text-2xl font-black tracking-wider mt-1">
              ★ CRÉDITO ★
            </div>
          </div>

          {/* CÓDIGO GIGANTE — fácil de bipar */}
          <div className="bg-black text-white rounded p-3 text-center my-3">
            <div className="text-[9px] uppercase tracking-widest opacity-70">
              Código
            </div>
            <div className="font-mono font-black text-2xl tracking-wider mt-1">
              {info.code}
            </div>
          </div>

          {/* VALOR */}
          <div className="text-center my-3 border-y-2 border-dashed border-black py-3">
            <div className="text-[10px] uppercase tracking-widest">
              Valor disponível
            </div>
            <div className="text-3xl font-black tabular-nums mt-1">
              {brl(info.valor)}
            </div>
          </div>

          {/* VALIDADE */}
          {validade && (
            <div className="text-center my-2 text-sm">
              <div className="text-[10px] uppercase tracking-wide opacity-70">
                Válido até
              </div>
              <div className="font-bold text-base">{validade}</div>
            </div>
          )}

          {/* STATUS */}
          {info.usado && (
            <div className="text-center text-rose-700 font-bold border-2 border-rose-700 rounded p-2 my-3">
              ⚠ JÁ FOI USADO
            </div>
          )}
          {info.vencido && !info.usado && (
            <div className="text-center text-rose-700 font-bold border-2 border-rose-700 rounded p-2 my-3">
              ⚠ VENCIDO
            </div>
          )}

          {/* INSTRUÇÕES */}
          <div className="text-[9px] mt-4 pt-2 border-t-2 border-dashed border-black space-y-1">
            <div className="font-bold uppercase">Como usar:</div>
            <div>1. Apresente este cupom em qualquer loja Lurd's</div>
            <div>2. A vendedora bipa o código TROCA-XXXXXX no PDV</div>
            <div>3. O valor é abatido da sua próxima compra</div>
            <div>4. Cupom de uso único — não tem troco em dinheiro</div>
          </div>

          {/* FOOTER */}
          <div className="text-center text-[8px] mt-4 pt-2 border-t border-dashed border-black opacity-70">
            Emitido em {new Date().toLocaleString('pt-BR')}
            <br />
            Loja origem: {info.origem.store}
          </div>
        </div>

        {/* Botões NÃO imprimíveis */}
        <div className="fixed bottom-4 right-4 flex flex-col gap-2 no-print">
          <button
            onClick={() => window.print()}
            className="px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl shadow-lg"
          >
            🖨 Imprimir
          </button>
          <button
            onClick={() => window.close()}
            className="px-6 py-2 bg-white border-2 border-slate-300 text-slate-700 font-bold rounded-xl shadow"
          >
            Fechar
          </button>
        </div>
      </div>
    </>
  );
}
