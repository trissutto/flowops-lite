'use client';

/**
 * /minha-loja/pdv/caixa/sangria/[id]
 *
 * Cupom de SANGRIA pra térmica 80mm. Layout simples:
 *   - LURD'S header
 *   - SANGRIA / SUPRIMENTO em destaque
 *   - Valor, motivo, data/hora, operador
 *   - Linha pra assinatura
 *
 * ?autoprint=1 dispara window.print() automaticamente quando carrega.
 */

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

type Movimento = {
  id: string;
  tipo: 'sangria' | 'suprimento' | string;
  valor: number;
  motivo: string;
  userName: string | null;
  createdAt: string;
  storeCode: string | null;
  storeName: string | null;
};

export default function SangriaImpressoPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const id = params.id || '';
  const autoprint = searchParams.get('autoprint') === '1';
  const [m, setM] = useState<Movimento | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!id) return;
    api<Movimento>(`/pdv/caixa/movimento/${id}`)
      .then((d) => setM(d))
      .catch((e) => setErr(e?.message || 'Falha ao carregar'));
  }, [id]);

  useEffect(() => {
    if (autoprint && m && !err) {
      const t = setTimeout(() => {
        try { window.print(); } catch {}
      }, 400);
      return () => clearTimeout(t);
    }
  }, [autoprint, m, err]);

  if (err) return <div className="p-4 text-rose-700 font-bold">{err}</div>;
  if (!m) return <div className="p-4 text-slate-500">Carregando…</div>;

  const isSangria = m.tipo === 'sangria';
  const titulo = isSangria ? 'SANGRIA' : 'SUPRIMENTO';
  const data = new Date(m.createdAt);
  const dataFmt = data.toLocaleDateString('pt-BR');
  const horaFmt = data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  return (
    <>
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
          #recibo-content, #recibo-content * { visibility: visible; }
          #recibo-content {
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
        <div className="w-[300px] bg-white shadow-lg" id="recibo-content">
          {/* HEADER */}
          <div className="text-center border-b-2 border-dashed border-black pb-2 mb-2">
            <div className="text-xl font-black tracking-wider">LURD'S</div>
            <div className="text-[10px] uppercase tracking-widest">Plus Size</div>
            {m.storeName && (
              <div className="text-[10px] mt-1">{m.storeCode} · {m.storeName}</div>
            )}
          </div>

          {/* TÍTULO */}
          <div className="text-center my-3">
            <div className="text-2xl font-black tracking-wider">
              {isSangria ? '⬇ SANGRIA' : '⬆ SUPRIMENTO'}
            </div>
            <div className="text-[10px] uppercase tracking-widest text-slate-700 mt-1">
              {isSangria ? 'Retirada de caixa' : 'Reforço de caixa'}
            </div>
          </div>

          {/* VALOR EM DESTAQUE */}
          <div className="bg-black text-white rounded p-3 text-center my-3">
            <div className="text-[9px] uppercase tracking-widest opacity-70">Valor</div>
            <div className="font-mono font-black text-3xl tabular-nums mt-1">
              {brl(m.valor)}
            </div>
          </div>

          {/* MOTIVO */}
          <div className="my-3 py-2 border-y-2 border-dashed border-black">
            <div className="text-[10px] uppercase tracking-wide font-bold text-slate-700 mb-1">
              Motivo
            </div>
            <div className="text-sm font-bold leading-tight break-words">
              {m.motivo}
            </div>
          </div>

          {/* DATA / HORA / OPERADOR */}
          <div className="text-[11px] my-3 space-y-0.5">
            <div className="flex justify-between">
              <span className="font-bold">Data:</span>
              <span className="font-mono">{dataFmt}</span>
            </div>
            <div className="flex justify-between">
              <span className="font-bold">Hora:</span>
              <span className="font-mono">{horaFmt}</span>
            </div>
            {m.userName && (
              <div className="flex justify-between">
                <span className="font-bold">Operador:</span>
                <span className="text-right">{m.userName}</span>
              </div>
            )}
          </div>

          {/* ÁREA DE ASSINATURA */}
          <div className="mt-8 pt-2">
            <div className="border-t-2 border-black"></div>
            <div className="text-center text-[10px] uppercase tracking-wider font-bold mt-1">
              Assinatura do responsável
            </div>
          </div>

          <div className="mt-6 pt-2">
            <div className="border-t-2 border-black"></div>
            <div className="text-center text-[10px] uppercase tracking-wider font-bold mt-1">
              Recibo / conferência
            </div>
          </div>

          {/* FOOTER */}
          <div className="text-center text-[8px] mt-4 pt-2 border-t border-dashed border-black opacity-70">
            ID: {m.id.slice(-8).toUpperCase()}
            <br />
            Comprovante interno — guardar pra fechamento
          </div>
        </div>

        {/* Botões não imprimíveis */}
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
