'use client';

/**
 * /relatorios/vendedoras
 *
 * Relatório mensal: quanto cada vendedora vendeu no site (pedidos WC atribuídos).
 *
 * Porquê: a loja usa isso pra comissionar/premiar vendedoras que ajudam a
 * fechar pedido mesmo quando a cliente finaliza no site.
 *
 * Filtro de período (default mês corrente). Mostra ranking + lista detalhada
 * + botão exportar CSV.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, RefreshCw, Download, TrendingUp, Users,
} from 'lucide-react';
import { api } from '@/lib/api';

type ReportSeller = {
  sellerId: string | null;
  sellerName: string;
  orderCount: number;
  totalAmount: number;
};

type ReportOrder = {
  wcOrderNumber: string | null;
  customerName: string | null;
  sellerId: string | null;
  sellerName: string | null;
  totalAmount: number;
  date: string | null;
};

type Report = {
  period: { from: string; to: string };
  totals: { orderCount: number; totalAmount: number };
  sellers: ReportSeller[];
  orders: ReportOrder[];
};

function toInputDate(d: Date): string {
  // yyyy-MM-dd
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatBRL(v: number): string {
  return v.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

export default function RelatorioVendedorasPage() {
  const router = useRouter();

  // default: mês corrente
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  const [from, setFrom] = useState<string>(toInputDate(firstDay));
  const [to, setTo] = useState<string>(toInputDate(lastDay));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Report | null>(null);
  const [filtroSeller, setFiltroSeller] = useState<string>('all');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      // ISO full-day (começo 00:00 e fim 23:59:59)
      const fromISO = new Date(`${from}T00:00:00`).toISOString();
      const toISO = new Date(`${to}T23:59:59`).toISOString();
      const qs = new URLSearchParams({ from: fromISO, to: toISO });
      const res = await api<Report>(`/sellers/report?${qs.toString()}`);
      setData(res);
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.includes('401')) {
        router.push('/login');
        return;
      }
      setError('Não foi possível carregar o relatório.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ordersFiltered = useMemo(() => {
    if (!data) return [];
    if (filtroSeller === 'all') return data.orders;
    if (filtroSeller === '__none__') return data.orders.filter((o) => !o.sellerId);
    return data.orders.filter((o) => o.sellerId === filtroSeller);
  }, [data, filtroSeller]);

  const exportCSV = () => {
    if (!data) return;
    const lines: string[] = [];
    lines.push('Pedido;Cliente;Vendedora;Valor;Data');
    for (const o of ordersFiltered) {
      const d = o.date ? new Date(o.date).toLocaleString('pt-BR') : '';
      const v = Number(o.totalAmount || 0)
        .toFixed(2)
        .replace('.', ',');
      const cols = [
        `#${o.wcOrderNumber || ''}`,
        (o.customerName || '').replace(/;/g, ','),
        (o.sellerName || 'Sem atribuição').replace(/;/g, ','),
        v,
        d,
      ];
      lines.push(cols.join(';'));
    }
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vendedoras_${from}_a_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Atalhos de período
  const setPeriodo = (preset: 'mes-atual' | 'mes-passado' | '7d' | '30d') => {
    const now2 = new Date();
    if (preset === 'mes-atual') {
      setFrom(toInputDate(new Date(now2.getFullYear(), now2.getMonth(), 1)));
      setTo(toInputDate(new Date(now2.getFullYear(), now2.getMonth() + 1, 0)));
    } else if (preset === 'mes-passado') {
      setFrom(toInputDate(new Date(now2.getFullYear(), now2.getMonth() - 1, 1)));
      setTo(toInputDate(new Date(now2.getFullYear(), now2.getMonth(), 0)));
    } else if (preset === '7d') {
      const d = new Date(now2);
      d.setDate(d.getDate() - 7);
      setFrom(toInputDate(d));
      setTo(toInputDate(now2));
    } else if (preset === '30d') {
      const d = new Date(now2);
      d.setDate(d.getDate() - 30);
      setFrom(toInputDate(d));
      setTo(toInputDate(now2));
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-brand text-white shadow">
        <div className="px-4 py-3 flex items-center gap-3 max-w-6xl mx-auto">
          <Link href="/" className="p-2 hover:bg-white/10 rounded" title="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-2 font-bold">
              <TrendingUp className="w-5 h-5" />
              Vendas por Vendedora
            </div>
            <div className="text-xs opacity-80">
              Pedidos WC atribuídos no período (exclui cancelados/reembolsados)
            </div>
          </div>
          <button
            onClick={load}
            className="p-2 hover:bg-white/10 rounded"
            title="Atualizar"
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-3 sm:p-4 space-y-3">
        {/* Filtros */}
        <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
            <label className="flex flex-col text-xs text-slate-600">
              De
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="border border-slate-200 rounded-lg text-sm py-2 px-2 mt-0.5 focus:outline-none focus:border-brand"
              />
            </label>
            <label className="flex flex-col text-xs text-slate-600">
              Até
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="border border-slate-200 rounded-lg text-sm py-2 px-2 mt-0.5 focus:outline-none focus:border-brand"
              />
            </label>
            <button
              onClick={load}
              disabled={loading}
              className="bg-brand text-white rounded-lg px-4 text-sm font-bold hover:opacity-90 disabled:opacity-50 mt-[18px]"
            >
              {loading ? 'Carregando…' : 'Gerar'}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 text-xs">
            <button
              onClick={() => setPeriodo('mes-atual')}
              className="px-2 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200"
            >
              Mês atual
            </button>
            <button
              onClick={() => setPeriodo('mes-passado')}
              className="px-2 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200"
            >
              Mês passado
            </button>
            <button
              onClick={() => setPeriodo('7d')}
              className="px-2 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200"
            >
              Últimos 7d
            </button>
            <button
              onClick={() => setPeriodo('30d')}
              className="px-2 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200"
            >
              Últimos 30d
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-4 text-sm">
            {error}
          </div>
        )}

        {data && (
          <>
            {/* KPIs totais */}
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-white rounded-xl border border-slate-200 p-3">
                <div className="text-[11px] uppercase font-semibold text-slate-500">
                  Total de pedidos
                </div>
                <div className="text-2xl font-bold text-slate-800">
                  {data.totals.orderCount}
                </div>
              </div>
              <div className="bg-white rounded-xl border border-emerald-200 p-3">
                <div className="text-[11px] uppercase font-semibold text-emerald-700">
                  Total vendido
                </div>
                <div className="text-2xl font-bold text-emerald-700">
                  {formatBRL(data.totals.totalAmount)}
                </div>
              </div>
            </div>

            {/* Ranking */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
                <Users className="w-4 h-4 text-slate-600" />
                <div className="text-sm font-bold text-slate-800">Ranking</div>
                <div className="text-xs text-slate-500">
                  (clique pra filtrar a lista abaixo)
                </div>
              </div>
              {data.sellers.length === 0 ? (
                <div className="p-6 text-center text-slate-500 text-sm">
                  Nenhum pedido encontrado no período.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-600 uppercase">
                      <tr>
                        <th className="text-left px-3 py-2">Vendedora</th>
                        <th className="text-right px-3 py-2">Pedidos</th>
                        <th className="text-right px-3 py-2">Total vendido</th>
                        <th className="text-right px-3 py-2">Ticket médio</th>
                        <th className="text-right px-3 py-2">%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sellers.map((s, i) => {
                        const pct =
                          data.totals.totalAmount > 0
                            ? Math.round((s.totalAmount / data.totals.totalAmount) * 100)
                            : 0;
                        const ticket = s.orderCount > 0 ? s.totalAmount / s.orderCount : 0;
                        const key = s.sellerId || '__none__';
                        const isNone = !s.sellerId;
                        const isActive = filtroSeller === key;
                        return (
                          <tr
                            key={key}
                            onClick={() =>
                              setFiltroSeller(filtroSeller === key ? 'all' : key)
                            }
                            className={`border-t border-slate-100 cursor-pointer hover:bg-slate-50 ${
                              isActive ? 'bg-brand/10' : ''
                            } ${isNone ? 'text-slate-500 italic' : ''}`}
                          >
                            <td className="px-3 py-2">
                              {i === 0 && !isNone && (
                                <span className="text-xs mr-1" title="Líder do período">🏆</span>
                              )}
                              <span className="font-semibold">{s.sellerName}</span>
                            </td>
                            <td className="text-right px-3 py-2 font-mono">
                              {s.orderCount}
                            </td>
                            <td className="text-right px-3 py-2 font-mono font-bold text-emerald-700">
                              {formatBRL(s.totalAmount)}
                            </td>
                            <td className="text-right px-3 py-2 font-mono text-slate-600">
                              {formatBRL(ticket)}
                            </td>
                            <td className="text-right px-3 py-2 font-mono text-slate-600">
                              {pct}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Detalhe de pedidos */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
                <div className="text-sm font-bold text-slate-800">
                  Pedidos ({ordersFiltered.length})
                </div>
                {filtroSeller !== 'all' && (
                  <button
                    onClick={() => setFiltroSeller('all')}
                    className="text-xs text-brand hover:underline"
                  >
                    limpar filtro
                  </button>
                )}
                <button
                  onClick={exportCSV}
                  disabled={ordersFiltered.length === 0}
                  className="ml-auto inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" /> Exportar CSV
                </button>
              </div>
              {ordersFiltered.length === 0 ? (
                <div className="p-6 text-center text-slate-500 text-sm">
                  Nenhum pedido nessa seleção.
                </div>
              ) : (
                <div className="overflow-x-auto max-h-[60vh]">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-600 uppercase sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2">Pedido</th>
                        <th className="text-left px-3 py-2">Cliente</th>
                        <th className="text-left px-3 py-2">Vendedora</th>
                        <th className="text-right px-3 py-2">Valor</th>
                        <th className="text-right px-3 py-2">Data</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ordersFiltered.map((o) => (
                        <tr key={`${o.wcOrderNumber}-${o.date}`} className="border-t border-slate-100">
                          <td className="px-3 py-2 font-mono text-slate-700">
                            {o.wcOrderNumber ? (
                              <Link
                                href={`/pedidos/wc/${o.wcOrderNumber}`}
                                className="text-brand hover:underline"
                              >
                                #{o.wcOrderNumber}
                              </Link>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {o.customerName || <span className="text-slate-400">—</span>}
                          </td>
                          <td className="px-3 py-2">
                            {o.sellerName ? (
                              <span className="font-semibold">{o.sellerName}</span>
                            ) : (
                              <span className="text-slate-400 italic">Sem atribuição</span>
                            )}
                          </td>
                          <td className="text-right px-3 py-2 font-mono text-emerald-700">
                            {formatBRL(o.totalAmount)}
                          </td>
                          <td className="text-right px-3 py-2 text-xs text-slate-500">
                            {o.date
                              ? new Date(o.date).toLocaleString('pt-BR', {
                                  day: '2-digit',
                                  month: '2-digit',
                                  year: '2-digit',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
