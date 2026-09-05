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
  // Site + PDV das lojas (dono 29/07)
  totalSite?: number;
  pdvCount?: number;
  totalPdv?: number;
  lojas?: string[];
  lojaLabel?: string | null;
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
  totals: { orderCount: number; totalAmount: number; pdvCount?: number; totalSite?: number; totalPdv?: number };
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

  // CONFERIDOR Flow × Giga (dono 29/07): por loja, componentes do Flow +
  // caixa do Giga lado a lado — pra achar divergência com nome.
  const [confLoja, setConfLoja] = useState('');
  const [confData, setConfData] = useState<any | null>(null);
  const [confLoading, setConfLoading] = useState(false);
  const conferir = async () => {
    const loja = confLoja.trim();
    if (!loja) return;
    setConfLoading(true);
    setConfData(null);
    try {
      const fromISO = new Date(`${from}T00:00:00`).toISOString();
      const toISO = new Date(`${to}T23:59:59`).toISOString();
      const qs = new URLSearchParams({ from: fromISO, to: toISO, storeCode: loja });
      setConfData(await api<any>(`/sellers/report-conferidor?${qs.toString()}`));
    } catch (e: any) {
      setConfData({ erro: e?.message || 'falha' });
    } finally {
      setConfLoading(false);
    }
  };

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
    <div className="min-h-screen pastel-page">
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
              Site (pedidos WC atribuídos) + PDV de TODAS as lojas no período — a lista detalhada abaixo é só do site
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
            {/* KPIs totais — SITE + PDV de todas as lojas (dono 29/07) */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <div className="bg-white rounded-xl border border-slate-200 p-3">
                <div className="text-[11px] uppercase font-semibold text-slate-500">
                  Pedidos site
                </div>
                <div className="text-2xl font-bold text-slate-800">
                  {data.totals.orderCount}
                </div>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-3">
                <div className="text-[11px] uppercase font-semibold text-slate-500">
                  Vendas lojas (PDV)
                </div>
                <div className="text-2xl font-bold text-slate-800">
                  {data.totals.pdvCount ?? 0}
                </div>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-3">
                <div className="text-[11px] uppercase font-semibold text-slate-500">
                  Total site
                </div>
                <div className="text-xl font-bold text-slate-700">
                  {formatBRL(data.totals.totalSite ?? data.totals.totalAmount)}
                </div>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-3">
                <div className="text-[11px] uppercase font-semibold text-slate-500">
                  Total lojas
                </div>
                <div className="text-xl font-bold text-slate-700">
                  {formatBRL(data.totals.totalPdv ?? 0)}
                </div>
              </div>
              <div className="col-span-2 sm:col-span-1 bg-white rounded-xl border border-emerald-200 p-3">
                <div className="text-[11px] uppercase font-semibold text-emerald-700">
                  Total geral
                </div>
                <div className="text-xl font-bold text-emerald-700">
                  {formatBRL(data.totals.totalAmount)}
                </div>
              </div>
            </div>

            {/* CONFERIDOR faturamento × caixa por loja (dono 29/07).
                Os dois lados são do Postgres do Flow hoje: à esquerda o relatório
                montado das vendas do PDV, à direita a CAIXA (giga_caixa_mov,
                tabela nativa alimentada pelo próprio Flow). Serve pra pegar
                venda que ficou fora de um dos dois. */}
            <div className="bg-white rounded-xl border border-amber-200 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-amber-800">🔍 Conferidor faturamento × caixa</span>
                <input
                  value={confLoja}
                  onChange={(e) => setConfLoja(e.target.value)}
                  placeholder="Código da loja (ex.: 06)"
                  className="border border-slate-300 rounded-lg text-sm py-1.5 px-2 w-40"
                />
                <button
                  onClick={conferir}
                  disabled={confLoading || !confLoja.trim()}
                  className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {confLoading ? 'Conferindo…' : 'Conferir período'}
                </button>
                <span className="text-[11px] text-slate-500">
                  Abre os componentes do faturamento por vendedora e traz a CAIXA da loja ao lado — a diferença aparece com nome.
                </span>
              </div>
              {confData?.erro && <div className="text-sm text-rose-600">{confData.erro}</div>}
              {confData?.flow && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-amber-50 text-[10px] uppercase text-amber-900">
                      <tr>
                        <th className="text-left px-2 py-1.5">Vendedora (Flow)</th>
                        <th className="text-right px-2 py-1.5">Bruto (itens)</th>
                        <th className="text-right px-2 py-1.5">− Desc. avulso</th>
                        <th className="text-right px-2 py-1.5">= FATURAMENTO</th>
                        <th className="text-right px-2 py-1.5">Vale-troca (só comissão)</th>
                        <th className="text-right px-2 py-1.5">Recebido</th>
                        <th className="text-right px-2 py-1.5">Marcados (fora)</th>
                        <th className="text-right px-2 py-1.5">Caixa da loja</th>
                        <th className="text-right px-2 py-1.5">Diferença (fat − caixa)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {confData.flow.map((c: any) => {
                        const normN = (s: any) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
                        const g = (confData.giga || []).find((x: any) => normN(x.nome) === normN(c.vendedora));
                        const gigaVal = g ? Number(g.valor) : null;
                        // Régua oficial (29/07): a caixa é CHEIA — compara
                        // com o FATURAMENTO (bruto − desc). Vale-troca NÃO entra
                        // aqui; ele só abate na BASE DE COMISSÃO.
                        const fat = Math.round((c.bruto - c.descontoAvulso) * 100) / 100;
                        const diff = gigaVal != null ? Math.round((fat - gigaVal) * 100) / 100 : null;
                        return (
                          <tr key={c.vendedora} className="border-t border-slate-100">
                            <td className="px-2 py-1 font-semibold">{c.vendedora}</td>
                            <td className="text-right px-2 py-1 font-mono">{formatBRL(c.bruto)}</td>
                            <td className="text-right px-2 py-1 font-mono text-slate-500">{formatBRL(c.descontoAvulso)}</td>
                            <td className="text-right px-2 py-1 font-mono font-bold">{formatBRL(fat)}</td>
                            <td className="text-right px-2 py-1 font-mono text-slate-400">{formatBRL(c.valeTroca)}</td>
                            <td className="text-right px-2 py-1 font-mono text-slate-500">{formatBRL(c.liquido)}</td>
                            <td className="text-right px-2 py-1 font-mono text-amber-700">{formatBRL(c.marcados)}</td>
                            <td className="text-right px-2 py-1 font-mono text-indigo-700">{gigaVal != null ? formatBRL(gigaVal) : '—'}</td>
                            <td className={`text-right px-2 py-1 font-mono font-bold ${diff && Math.abs(diff) > 1 ? 'text-rose-600' : 'text-emerald-600'}`}>
                              {diff != null ? formatBRL(diff) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                      {(confData.giga || [])
                        .filter((g2: any) => !confData.flow.some((c: any) =>
                          String(c.vendedora || '').trim().toUpperCase().replace(/\s+/g, ' ') === String(g2.nome || '').trim().toUpperCase().replace(/\s+/g, ' ')))
                        .map((g2: any) => (
                          <tr key={`giga-${g2.codigo}`} className="border-t border-slate-100 bg-indigo-50/40">
                            <td className="px-2 py-1 font-semibold text-indigo-800">{g2.nome || g2.codigo} <span className="text-[10px] font-normal">(só na caixa)</span></td>
                            <td className="text-right px-2 py-1 font-mono text-slate-400" colSpan={6}>sem venda no PDV Flow</td>
                            <td className="text-right px-2 py-1 font-mono text-indigo-700">{formatBRL(Number(g2.valor) || 0)}</td>
                            <td className="text-right px-2 py-1 font-mono font-bold text-rose-600">{formatBRL(-(Number(g2.valor) || 0))}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  {confData.gigaErro && <p className="text-[11px] text-rose-600 mt-1">Não deu pra ler a caixa da loja: {confData.gigaErro}</p>}
                </div>
              )}
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
                        <th className="text-right px-3 py-2">Ped. site</th>
                        <th className="text-right px-3 py-2">Vendas lojas</th>
                        <th className="text-right px-3 py-2">R$ site</th>
                        <th className="text-right px-3 py-2">R$ lojas</th>
                        <th className="text-right px-3 py-2">Total</th>
                        <th className="text-right px-3 py-2">%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sellers.map((s, i) => {
                        const pct =
                          data.totals.totalAmount > 0
                            ? Math.round((s.totalAmount / data.totals.totalAmount) * 100)
                            : 0;
                        // Vendedoras do PDV não têm sellerId — chave nome×loja
                        // (homônimas em lojas diferentes são linhas separadas)
                        const key = s.sellerId || (s.orderCount > 0 ? '__none__' : `nome:${s.sellerName}:${(s.lojas || []).join('-')}`);
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
                              {/* Identificação da LOJA ao lado do nome (dono 29/07) */}
                              {(s.lojaLabel || (s.lojas?.length ? `loja ${s.lojas.join(', ')}` : '')) !== '' && (
                                <span className={`ml-2 inline-block align-middle rounded px-1.5 py-0.5 text-[10px] font-bold not-italic border ${
                                  s.lojaLabel === 'SITE'
                                    ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                                    : 'bg-slate-100 border-slate-200 text-slate-600'
                                }`}>
                                  {s.lojaLabel || `loja ${s.lojas!.join(', ')}`}
                                </span>
                              )}
                            </td>
                            <td className="text-right px-3 py-2 font-mono">
                              {s.orderCount}
                            </td>
                            <td className="text-right px-3 py-2 font-mono">
                              {s.pdvCount ?? 0}
                            </td>
                            <td className="text-right px-3 py-2 font-mono text-slate-600">
                              {formatBRL(s.totalSite ?? 0)}
                            </td>
                            <td className="text-right px-3 py-2 font-mono text-slate-600">
                              {formatBRL(s.totalPdv ?? 0)}
                            </td>
                            <td className="text-right px-3 py-2 font-mono font-bold text-emerald-700">
                              {formatBRL(s.totalAmount)}
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
