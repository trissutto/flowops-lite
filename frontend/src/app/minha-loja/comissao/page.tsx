'use client';

/**
 * /minha-loja/comissao
 *
 * Vendedora ve a comissao DELA — mes atual + historico ultimos 6 meses.
 * Auto-calcula no backend ao abrir.
 *
 * F4 da migracao 30/06: substitui o relatorio que antes era so no Wincred.
 */

import { useEffect, useState } from 'react';
import { ArrowLeft, DollarSign, Trophy, Calendar, Loader2, TrendingUp, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api';

type Statement = {
  sellerId: string;
  sellerName: string | null;
  currentMonth: PeriodSummary | null;
  history: PeriodSummary[];
};

type PeriodSummary = {
  yearMonth: string;
  status: 'open' | 'closed' | 'paid';
  totalVendido: number;
  totalTrocas: number;
  vendidoLiquido: number;
  totalComissao: number;
  metaAtingida: boolean;
  entriesByStore: Array<{
    storeId: string;
    vendidoLiquido: number;
    percentApplied: number;
    comissaoBase: number;
    bonusValue: number;
    total: number;
    paidAt: string | null;
  }>;
};

const brl = (n: number | null | undefined) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function formatYM(ym: string): string {
  const [y, m] = ym.split('-').map((s) => parseInt(s, 10));
  const months = [
    'Jan',
    'Fev',
    'Mar',
    'Abr',
    'Mai',
    'Jun',
    'Jul',
    'Ago',
    'Set',
    'Out',
    'Nov',
    'Dez',
  ];
  return `${months[m - 1]}/${y}`;
}

export default function ComissaoPage() {
  const [data, setData] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await api<Statement>('/commissions/my?history=6');
      setData(r);
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-sm w-full bg-white border border-red-200 rounded-xl p-5">
          <p className="font-bold text-red-700 mb-2">Erro</p>
          <p className="text-sm text-slate-600">{error}</p>
          <button
            onClick={load}
            className="mt-3 w-full bg-slate-800 text-white py-2 rounded font-bold"
          >
            Tentar de novo
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const cur = data.currentMonth;

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-2xl mx-auto p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link
            href="/minha-loja"
            className="p-2 rounded-lg hover:bg-slate-100 text-slate-500"
            title="Voltar"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 text-white flex items-center justify-center shadow">
            <DollarSign className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Minha Comissão</h1>
            <p className="text-sm text-slate-500">
              {data.sellerName || 'Você'} · {cur && formatYM(cur.yearMonth)}
            </p>
          </div>
        </div>

        {/* Card mês atual */}
        {cur ? (
          <div className="bg-gradient-to-br from-emerald-500 to-green-600 text-white rounded-2xl p-5 shadow-lg">
            <div className="text-xs font-bold uppercase tracking-wider opacity-80 mb-1">
              Comissão acumulada {formatYM(cur.yearMonth)}
            </div>
            <div className="text-4xl font-black tabular-nums mb-3">{brl(cur.totalComissao)}</div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="opacity-75 text-xs">Vendido líquido</div>
                <div className="font-bold tabular-nums">{brl(cur.vendidoLiquido)}</div>
              </div>
              <div>
                <div className="opacity-75 text-xs">Trocas/devoluções</div>
                <div className="font-bold tabular-nums">{brl(cur.totalTrocas)}</div>
              </div>
            </div>
            {cur.metaAtingida && (
              <div className="mt-3 bg-white/20 rounded-lg p-2.5 flex items-center gap-2">
                <Trophy className="w-5 h-5" />
                <span className="font-bold text-sm">Meta batida! 🎉 Bônus incluído.</span>
              </div>
            )}
            <div className="mt-3 text-[10px] opacity-60">
              Atualiza em tempo real conforme você vende.
            </div>
          </div>
        ) : (
          <div className="bg-white border rounded-2xl p-5 text-center">
            <p className="text-slate-500">Sem vendas registradas esse mês.</p>
          </div>
        )}

        {/* Breakdown por loja (se vendeu em mais de uma) */}
        {cur && cur.entriesByStore.length > 1 && (
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <h2 className="font-bold text-sm mb-2 flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-emerald-600" />
              Por loja esse mês
            </h2>
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="text-left py-1">Loja</th>
                  <th className="text-right py-1">Vendido</th>
                  <th className="text-right py-1">%</th>
                  <th className="text-right py-1">Comissão</th>
                </tr>
              </thead>
              <tbody>
                {cur.entriesByStore.map((e, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="py-1.5 text-xs">{e.storeId.slice(0, 8)}…</td>
                    <td className="py-1.5 text-right tabular-nums">{brl(e.vendidoLiquido)}</td>
                    <td className="py-1.5 text-right">{Number(e.percentApplied).toFixed(2)}%</td>
                    <td className="py-1.5 text-right tabular-nums font-bold text-emerald-700">
                      {brl(e.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}

        {/* Histórico últimos meses */}
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h2 className="font-bold text-sm mb-2 flex items-center gap-2">
            <Calendar className="w-4 h-4 text-slate-600" />
            Histórico
          </h2>
          {data.history.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-4">Sem histórico</p>
          ) : (
            <div className="space-y-2">
              {data.history
                .filter((p) => !cur || p.yearMonth !== cur.yearMonth)
                .map((p) => (
                  <div
                    key={p.yearMonth}
                    className="flex items-center justify-between border-b border-slate-100 pb-2 last:border-0"
                  >
                    <div>
                      <div className="font-bold text-sm">{formatYM(p.yearMonth)}</div>
                      <div className="text-xs text-slate-500">
                        Vendido líq: {brl(p.vendidoLiquido)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold tabular-nums text-emerald-700">
                        {brl(p.totalComissao)}
                      </div>
                      <div className="text-[10px]">
                        {p.status === 'paid' ? (
                          <span className="text-emerald-600 font-bold inline-flex items-center gap-0.5">
                            <CheckCircle2 className="w-2.5 h-2.5" /> Pago
                          </span>
                        ) : p.status === 'closed' ? (
                          <span className="text-blue-600 font-bold">A pagar</span>
                        ) : (
                          <span className="text-amber-600 font-bold">Em aberto</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>

        <p className="text-xs text-slate-400 text-center">
          Cálculo atualizado em tempo real. Dúvida sobre comissão? Fala com a matriz.
        </p>
      </div>
    </div>
  );
}
