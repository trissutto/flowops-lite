'use client';

/**
 * ValeTrocaModal — aplica um vale-troca (TROCA-XXXXX) como pagamento parcial
 * numa venda em aberto do PDV.
 *
 * Fluxo:
 *  1. Vendedora bipa/digita o código TROCA-XXXXX
 *  2. Click em "Validar" → GET /pdv/devolucao/credito/:code
 *     - Mostra valor disponível, validade, status (vencido/usado/válido)
 *  3. Vendedora ajusta valor a aplicar (default = min(restante, saldoVale))
 *  4. Click em "Aplicar" → POST /pdv/sales/:id/payments
 *     com method='vale_troca' + details.creditoCode
 *  5. Backend valida, grava pagamento, e ao finalizar a venda marca o
 *     vale como 'used'
 *
 * Se o vale cobre 100% do restante, parent finaliza venda automaticamente.
 */

import { useEffect, useRef, useState } from 'react';
import { Tag, X, Check, Loader2, AlertCircle } from 'lucide-react';
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

export default function ValeTrocaModal({
  saleId,
  totalRestante,
  onClose,
  onApplied,
}: {
  saleId: string;
  totalRestante: number;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<CreditInfo | null>(null);
  const [valor, setValor] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const validar = async () => {
    setErr('');
    setInfo(null);
    const c = code.trim().toUpperCase();
    if (!c) {
      setErr('Bipa ou digita o código TROCA-XXXXXXXX');
      return;
    }
    setBusy(true);
    try {
      const r = await api<CreditInfo>(`/pdv/devolucao/credito/${encodeURIComponent(c)}`);
      // Decimal do Prisma chega serializado como STRING — coage pra número
      // aqui, senão as comparações de saldo viram concatenação de texto.
      const norm = { ...r, valor: Number(r.valor) || 0 };
      setInfo(norm);
      // Valor default: o menor entre saldo do vale e restante da venda
      const aplicavel = Math.min(norm.valor, totalRestante);
      setValor(aplicavel.toFixed(2).replace('.', ','));
    } catch (e: any) {
      setErr(e?.message || 'Vale-troca não encontrado');
    } finally {
      setBusy(false);
    }
  };

  // pt-BR: vírgula é o decimal e ponto é milhar ("1.234,56"). Sem vírgula,
  // ponto vale como decimal ("23.90" = 23,90) — senão virava 2390.
  const parseValor = (s: string) => {
    const t = (s || '').trim();
    if (!t) return 0;
    const norm = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
    return Number(norm);
  };

  const aplicar = async () => {
    if (!info) return;
    setErr('');
    const v = parseValor(valor);
    if (!v || v <= 0 || !isFinite(v)) {
      setErr('Valor inválido');
      return;
    }
    if (v > info.valor + 0.01) {
      setErr(`Valor maior que o saldo do vale (${brl(info.valor)})`);
      return;
    }
    if (v > totalRestante + 0.01) {
      setErr(`Valor maior que o restante da venda (${brl(totalRestante)})`);
      return;
    }
    setBusy(true);
    try {
      await api(`/pdv/sales/${saleId}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          method: 'vale_troca',
          valor: v,
          details: { creditoCode: info.code },
        }),
      });
      onApplied();
    } catch (e: any) {
      setErr(e?.message || 'Falha ao aplicar vale-troca');
    } finally {
      setBusy(false);
    }
  };

  // Anulado/cancelado também invalida (ex: residual cujo vale original voltou
  // num cancelamento) — antes o modal mostrava "Válido" e o backend recusava
  // só na hora de aplicar.
  const anulado = !!info && (info.status === 'cancelled' || info.status === 'anulado');
  const valido = info && !info.vencido && !info.usado && !anulado;

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-t-2xl sm:rounded-lg w-full max-w-md flex flex-col max-h-[95vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-2 border-b border-slate-100 shrink-0">
          <h2 className="font-semibold flex items-center gap-2 text-fuchsia-800">
            <Tag className="w-4 h-4" /> Aplicar Vale-Troca
          </h2>
          <button onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <label className="text-xs uppercase font-bold text-slate-600 tracking-wider">
              Código do vale-troca
            </label>
            <div className="flex gap-2 mt-1">
              <input
                ref={inputRef}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && validar()}
                placeholder="TROCA-XXXXXXXX"
                disabled={busy}
                className="flex-1 px-3 py-2 border-2 border-slate-200 rounded-lg font-mono text-base font-bold tracking-widest text-slate-800 focus:border-fuchsia-400 focus:ring-2 focus:ring-fuchsia-200 focus:outline-none uppercase"
              />
              <button
                onClick={validar}
                disabled={busy || !code.trim()}
                className="px-4 py-2 bg-fuchsia-600 hover:bg-fuchsia-700 text-white font-bold rounded-lg disabled:opacity-40 flex items-center gap-1"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Validar
              </button>
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Bipa o código que veio na devolução em modo crédito.
            </div>
          </div>

          {err && (
            <div className="bg-rose-50 border-2 border-rose-200 text-rose-800 px-3 py-2 rounded-lg text-sm flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{err}</span>
            </div>
          )}

          {info && (
            <div
              className={`rounded-lg p-3 border-2 ${
                valido
                  ? 'bg-emerald-50 border-emerald-300'
                  : 'bg-rose-50 border-rose-300'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono font-black tracking-widest text-slate-800">
                  {info.code}
                </span>
                {valido ? (
                  <span className="text-[10px] font-bold uppercase bg-emerald-600 text-white px-2 py-0.5 rounded-full">
                    ✓ Válido
                  </span>
                ) : info.usado ? (
                  <span className="text-[10px] font-bold uppercase bg-rose-600 text-white px-2 py-0.5 rounded-full">
                    Já usado
                  </span>
                ) : anulado ? (
                  <span className="text-[10px] font-bold uppercase bg-slate-600 text-white px-2 py-0.5 rounded-full">
                    Anulado
                  </span>
                ) : (
                  <span className="text-[10px] font-bold uppercase bg-amber-600 text-white px-2 py-0.5 rounded-full">
                    Vencido
                  </span>
                )}
              </div>
              <div className="text-2xl font-black text-emerald-700 tabular-nums">
                {brl(info.valor)}
              </div>
              {info.validade && (
                <div className="text-[11px] text-slate-600 mt-1">
                  Validade: {new Date(info.validade).toLocaleDateString('pt-BR')}
                </div>
              )}
            </div>
          )}

          {valido && (
            <div>
              <label className="text-xs uppercase font-bold text-slate-600 tracking-wider">
                Valor a aplicar
              </label>
              <div className="text-[10px] text-slate-500 mb-1">
                Restante da venda: {brl(totalRestante)} · Saldo do vale: {brl(info!.valor)}
              </div>
              <input
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && aplicar()}
                placeholder="0,00"
                inputMode="decimal"
                disabled={busy}
                className="w-full px-3 py-3 border-2 border-slate-200 rounded-lg text-2xl font-black tabular-nums text-emerald-700 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 focus:outline-none"
              />
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 flex gap-2 rounded-b-lg">
          <button
            onClick={onClose}
            disabled={busy}
            className="flex-1 px-4 py-3 border-2 border-slate-300 text-slate-700 font-bold rounded-xl hover:bg-slate-50 disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={aplicar}
            disabled={busy || !valido}
            className="flex-[2] px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl text-base disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Check className="w-5 h-5" />}
            Aplicar Vale-Troca
          </button>
        </div>
      </div>
    </div>
  );
}
