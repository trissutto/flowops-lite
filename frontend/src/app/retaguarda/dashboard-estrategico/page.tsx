'use client';

/**
 * /retaguarda/dashboard-estrategico — Dashboard executivo Lurd's Plus Size.
 *
 * Layout BI completo:
 *  - Sidebar roxa fixa
 *  - Topo: filtros + comparação + exportar
 *  - 5 KPIs principais com YoY
 *  - Gráfico de barras: faturamento últimos 5 anos no mês
 *  - Tabela: ranking 15 lojas com TOP 3 / piores 3
 *  - Top 5 vendedoras + top 10 produtos
 *  - Gráfico horizontal: ticket médio por loja
 *  - Gráfico de linha: evolução 12 meses
 *  - Card insights automáticos
 *  - 5 KPIs crescimento por indicador
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Loader2, BarChart3, Filter, Download, RefreshCw,
  TrendingUp, TrendingDown, ShoppingBag, Users, Receipt, Package,
  DollarSign, Award, Target, Lightbulb, Trophy, AlertTriangle,
  Store as StoreIcon, Tag, Calendar, Crown, Medal,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  LineChart, Line, Legend, Cell,
} from 'recharts';
import { api } from '@/lib/api';

// ─── TYPES ───────────────────────────────────────────────────────────
type Kpi = { atual: number; anterior: number; variacao: number | null };

type Dashboard = {
  periodo: { from: string; to: string; refMonth: number; refYear: number };
  kpis: {
    faturamento: Kpi; pedidos: Kpi; unidades: Kpi; ticketMedio: Kpi; clientes: Kpi;
  };
  historicoAnos: Array<{ year: number; valor: number; pecas: number }>;
  evolucao12m: Array<{ year: number; month: number; valor: number; pecas: number }>;
  ranking: Array<{
    posicao: number; code: string; name: string; tipo: string;
    pecas: number; valor: number; valorAnterior: number;
    variacao: number | null; ticketMedio: number;
  }>;
  mediaRede: number;
  lojasResumo: { ativas: number; acimaMedia: number; abaixoMedia: number };
  topVendedoras: Array<{ codigo: string; nome: string; pecas: number; valor: number; vendas: number; comissao: number }>;
  topProdutos: Array<{ refCode: string; descricao: string | null; pecas: number; valor: number }>;
  topMarcas: Array<{ marca: string; pecas: number; valor: number }>;
  insights: Array<{ tone: 'success' | 'warning' | 'info' | 'danger'; text: string }>;
};

// ─── HELPERS ─────────────────────────────────────────────────────────
const brl = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brlCompact = (n: number) => {
  if (n >= 1_000_000) return `R$ ${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `R$ ${(n / 1_000).toFixed(1)}K`;
  return `R$ ${brl(n)}`;
};
const num = (n: number) => n.toLocaleString('pt-BR');

const isoToday = () => new Date().toISOString().slice(0, 10);
const isoFirstOfMonth = () => {
  const d = new Date(); d.setDate(1);
  return d.toISOString().slice(0, 10);
};

const MES_NOMES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

const PRESETS = [
  { label: 'Mês atual', from: isoFirstOfMonth, to: isoToday },
  { label: 'Mês passado', from: () => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 10);
  }, to: () => {
    const d = new Date(); d.setDate(0);
    return d.toISOString().slice(0, 10);
  }},
  { label: '30 dias', from: () => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  }, to: isoToday },
  { label: '90 dias', from: () => {
    const d = new Date(); d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10);
  }, to: isoToday },
  { label: 'Ano atual', from: () => {
    const d = new Date(); d.setMonth(0); d.setDate(1);
    return d.toISOString().slice(0, 10);
  }, to: isoToday },
];

// ─── PÁGINA ──────────────────────────────────────────────────────────
export default function DashboardEstrategicoPage() {
  const [from, setFrom] = useState(isoFirstOfMonth());
  const [to, setTo] = useState(isoToday());
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchData() {
    setLoading(true);
    setError(null);
    try {
      const r = await api<Dashboard>(`/intelligence/strategic-dashboard?from=${from}&to=${to}`);
      setData(r);
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchData(); /* eslint-disable-next-line */ }, []);

  function applyPreset(p: typeof PRESETS[0]) {
    setFrom(p.from()); setTo(p.to());
    setTimeout(() => fetchData(), 50);
  }

  function exportCsv() {
    if (!data) return;
    const lines: string[] = [];
    lines.push('Ranking de Lojas');
    lines.push('Posição;Código;Nome;Faturamento;Variação %;Ticket Médio');
    for (const r of data.ranking) {
      lines.push(`${r.posicao};${r.code};${r.name};${r.valor.toFixed(2)};${r.variacao ?? ''};${r.ticketMedio.toFixed(2)}`);
    }
    lines.push('');
    lines.push('Top Vendedoras');
    lines.push('Nome;Código;Vendas;Faturamento;Comissão 2%');
    for (const v of data.topVendedoras) {
      lines.push(`${v.nome || ''};${v.codigo};${v.vendas};${v.valor.toFixed(2)};${v.comissao.toFixed(2)}`);
    }
    const csv = '﻿' + lines.join('\n'); // BOM pra Excel pegar UTF-8
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dashboard-${from}-a-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Top 3 / piores 3 do ranking
  const top3 = useMemo(() => data?.ranking.slice(0, 3) || [], [data]);
  const piores3 = useMemo(() => {
    if (!data?.ranking) return [];
    const comVenda = data.ranking.filter((r) => r.valor > 0);
    return comVenda.slice(-3).reverse();
  }, [data]);

  // Meta: assume meta = mediaRede × 1.1 (10% acima da média)
  const meta = (data?.mediaRede || 0) * 1.1;
  const metaPct = data && meta > 0
    ? Math.min(100, (data.kpis.faturamento.atual / (meta * (data.lojasResumo.ativas || 1))) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-slate-50 flex">

      {/* ─── SIDEBAR ─────────────────────────────────────────────────── */}
      <aside className="w-56 bg-gradient-to-b from-violet-900 via-violet-800 to-fuchsia-900 text-white flex flex-col fixed inset-y-0 left-0 z-30 hidden lg:flex">
        <div className="px-4 py-4 border-b border-white/10">
          <Link href="/retaguarda" className="flex items-center gap-2 text-white/80 hover:text-white text-xs mb-3">
            <ArrowLeft className="w-3.5 h-3.5" /> Retaguarda
          </Link>
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-fuchsia-300" />
            <div>
              <h1 className="text-sm font-black leading-none">Dashboard</h1>
              <p className="text-[10px] text-white/60 mt-0.5">Estratégico</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          <SidebarItem icon={BarChart3} label="Visão Geral" active />
          <SidebarItem icon={StoreIcon} label="Lojas" href="/retaguarda/inteligencia-estoque" />
          <SidebarItem icon={TrendingUp} label="Vendas" href="/retaguarda/inteligencia-vendas" />
          <SidebarItem icon={Users} label="Vendedoras" href="/retaguarda/vendedoras" />
          <SidebarItem icon={Package} label="Estoque" href="/retaguarda/inteligencia-estoque" />
        </nav>

        <div className="p-3 border-t border-white/10 text-[10px] text-white/50">
          Lurd&apos;s Plus Size · 15 lojas
        </div>
      </aside>

      {/* ─── MAIN ────────────────────────────────────────────────────── */}
      <div className="flex-1 lg:ml-56">

        {/* Topo */}
        <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
          <div className="px-6 py-4 flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-0">
              <h2 className="text-2xl font-black text-slate-900">Dashboard Estratégico</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {data ? `Período: ${new Date(from + 'T12:00:00').toLocaleDateString('pt-BR')} a ${new Date(to + 'T12:00:00').toLocaleDateString('pt-BR')} · vs mesmo período ano anterior` : 'Carregando…'}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => applyPreset(p)}
                  className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold border bg-white hover:bg-violet-50 border-slate-200 hover:border-violet-300 text-slate-700 hover:text-violet-700 transition"
                >
                  {p.label}
                </button>
              ))}
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs" />
              <span className="text-xs text-slate-400">até</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs" />
              <button
                onClick={fetchData}
                disabled={loading}
                className="bg-violet-600 hover:bg-violet-700 text-white px-3 py-1.5 rounded-lg flex items-center gap-1.5 font-bold text-xs disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Filter className="w-3.5 h-3.5" />}
                Filtrar
              </button>
              <button
                onClick={exportCsv}
                disabled={!data}
                className="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg flex items-center gap-1.5 font-bold text-xs disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" />
                Exportar
              </button>
            </div>
          </div>
        </header>

        <main className="px-6 py-5 space-y-5 max-w-[1600px] mx-auto">

          {error && (
            <div className="bg-rose-50 border-2 border-rose-300 text-rose-800 p-3 rounded-xl text-sm flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-rose-600" />
              <div>
                <div className="font-bold">Erro ao carregar dashboard</div>
                <div className="text-xs mt-0.5">{error}</div>
              </div>
            </div>
          )}

          {loading && !data && (
            <div className="text-center py-20 text-slate-400">
              <Loader2 className="w-10 h-10 animate-spin mx-auto" />
              <p className="text-xs mt-3">Carregando dados estratégicos…</p>
            </div>
          )}

          {data && (
            <>
              {/* ─── KPIs PRINCIPAIS ─────────────────────────────────── */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                <KpiCard
                  label="Faturamento"
                  value={brlCompact(data.kpis.faturamento.atual)}
                  variacao={data.kpis.faturamento.variacao}
                  icon={DollarSign}
                  color="emerald"
                  primary
                />
                <KpiCard
                  label="Pedidos"
                  value={num(data.kpis.pedidos.atual)}
                  variacao={data.kpis.pedidos.variacao}
                  icon={Receipt}
                  color="violet"
                />
                <KpiCard
                  label="Unidades"
                  value={num(data.kpis.unidades.atual)}
                  variacao={data.kpis.unidades.variacao}
                  icon={Package}
                  color="sky"
                />
                <KpiCard
                  label="Ticket Médio"
                  value={`R$ ${brl(data.kpis.ticketMedio.atual)}`}
                  variacao={data.kpis.ticketMedio.variacao}
                  icon={ShoppingBag}
                  color="amber"
                />
                <KpiCard
                  label="Clientes únicos"
                  value={num(data.kpis.clientes.atual)}
                  variacao={data.kpis.clientes.variacao}
                  icon={Users}
                  color="rose"
                />
              </div>

              {/* ─── INSIGHTS + META ─────────────────────────────────── */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Card insights — destaca-se */}
                <div className="lg:col-span-2 bg-gradient-to-br from-violet-600 via-fuchsia-600 to-rose-500 rounded-2xl p-5 text-white shadow-lg">
                  <div className="flex items-center gap-2 mb-3">
                    <Lightbulb className="w-5 h-5" />
                    <h3 className="text-sm font-black uppercase tracking-wider">Resumo Inteligente</h3>
                  </div>
                  {data.insights.length === 0 ? (
                    <p className="text-white/80 text-sm">Sem insights significativos no período.</p>
                  ) : (
                    <div className="space-y-2">
                      {data.insights.map((ins, i) => {
                        const iconMap = {
                          success: Trophy,
                          warning: AlertTriangle,
                          danger: TrendingDown,
                          info: Lightbulb,
                        };
                        const Icon = iconMap[ins.tone];
                        return (
                          <div key={i} className="bg-white/10 backdrop-blur rounded-lg px-3 py-2 flex items-start gap-2 text-sm">
                            <Icon className="w-4 h-4 shrink-0 mt-0.5" />
                            <span className="leading-relaxed">{ins.text}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Meta + lojas resumo */}
                <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200 space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-black uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                        <Target className="w-3.5 h-3.5 text-emerald-600" /> Meta da rede
                      </span>
                      <span className={`text-sm font-black ${metaPct >= 100 ? 'text-emerald-600' : metaPct >= 80 ? 'text-amber-600' : 'text-rose-600'}`}>
                        {metaPct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="bg-slate-100 rounded-full h-3 overflow-hidden">
                      <div
                        className={`h-full transition-all ${metaPct >= 100 ? 'bg-emerald-500' : metaPct >= 80 ? 'bg-amber-500' : 'bg-rose-500'}`}
                        style={{ width: `${Math.min(100, metaPct)}%` }}
                      />
                    </div>
                    <p className="text-[10px] text-slate-500 mt-1">Baseado em 110% da média da rede</p>
                  </div>

                  <div className="border-t border-slate-100 pt-3 space-y-2">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-slate-600 flex items-center gap-1.5"><StoreIcon className="w-3 h-3" /> Lojas ativas</span>
                      <span className="font-black text-slate-800">{data.lojasResumo.ativas} <span className="text-slate-400 font-normal">/ 15</span></span>
                    </div>
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-emerald-700 flex items-center gap-1.5"><TrendingUp className="w-3 h-3" /> Acima da média</span>
                      <span className="font-black text-emerald-700">{data.lojasResumo.acimaMedia}</span>
                    </div>
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-amber-700 flex items-center gap-1.5"><TrendingDown className="w-3 h-3" /> Abaixo da média</span>
                      <span className="font-black text-amber-700">{data.lojasResumo.abaixoMedia}</span>
                    </div>
                    <div className="flex justify-between items-center text-xs pt-2 border-t border-slate-100">
                      <span className="text-slate-600">Média / loja</span>
                      <span className="font-bold text-slate-800 tabular-nums">{brlCompact(data.mediaRede)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* ─── COMPARATIVO 5 ANOS + EVOLUÇÃO 12 MESES ──────────── */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <ChartCard
                  title={`Faturamento em ${MES_NOMES[data.periodo.refMonth - 1]} - últimos 5 anos`}
                  icon={Calendar}
                >
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={data.historicoAnos.map((d) => ({ ...d, label: String(d.year) }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
                      <YAxis stroke="#64748b" fontSize={10} tickFormatter={(v) => brlCompact(v)} />
                      <Tooltip
                        contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 }}
                        formatter={(v: any) => `R$ ${brl(v)}`}
                      />
                      <Bar dataKey="valor" radius={[8, 8, 0, 0]}>
                        {data.historicoAnos.map((d, i) => (
                          <Cell key={i} fill={i === data.historicoAnos.length - 1 ? '#7c3aed' : '#c4b5fd'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>

                <ChartCard title="Evolução mensal — últimos 12 meses" icon={TrendingUp}>
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={data.evolucao12m.map((d) => ({
                      label: `${MES_NOMES[d.month - 1]}/${String(d.year).slice(2)}`,
                      valor: d.valor,
                    }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="label" stroke="#64748b" fontSize={10} />
                      <YAxis stroke="#64748b" fontSize={10} tickFormatter={(v) => brlCompact(v)} />
                      <Tooltip
                        contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 }}
                        formatter={(v: any) => `R$ ${brl(v)}`}
                      />
                      <Line type="monotone" dataKey="valor" stroke="#10b981" strokeWidth={3} dot={{ fill: '#10b981', r: 4 }} activeDot={{ r: 6 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>

              {/* ─── RANKING DE LOJAS + TICKET MÉDIO ─────────────────── */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

                {/* Tabela ranking */}
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
                    <Trophy className="w-4 h-4 text-violet-600" />
                    <h3 className="text-sm font-black uppercase tracking-wider text-slate-700">Ranking de Lojas</h3>
                    <span className="text-[10px] text-slate-400 ml-auto">{data.ranking.length} lojas</span>
                  </div>
                  <div className="max-h-[480px] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 border-b border-slate-100 sticky top-0">
                        <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                          <th className="text-left px-3 py-2 w-10">#</th>
                          <th className="text-left px-3 py-2">Loja</th>
                          <th className="text-right px-3 py-2">Faturamento</th>
                          <th className="text-right px-3 py-2">vs Ano Ant.</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {data.ranking.map((r) => {
                          const isTop3 = r.posicao <= 3 && r.valor > 0;
                          const isPior3 = piores3.find((p) => p.code === r.code);
                          const rowCls = isTop3
                            ? 'bg-emerald-50/50'
                            : isPior3
                            ? 'bg-rose-50/50'
                            : 'hover:bg-slate-50';
                          return (
                            <tr key={r.code} className={rowCls}>
                              <td className="px-3 py-2">
                                {isTop3 ? (
                                  <div className="flex items-center justify-center">
                                    {r.posicao === 1 && <Crown className="w-4 h-4 text-amber-500" />}
                                    {r.posicao === 2 && <Medal className="w-4 h-4 text-slate-400" />}
                                    {r.posicao === 3 && <Medal className="w-4 h-4 text-amber-700" />}
                                  </div>
                                ) : (
                                  <span className="text-xs text-slate-500 tabular-nums">{r.posicao}</span>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <div className="font-bold text-slate-800 text-sm">{r.name}</div>
                                <div className="text-[10px] text-slate-400 font-mono">cód {r.code} · {r.tipo}</div>
                              </td>
                              <td className="px-3 py-2 text-right">
                                <div className="font-bold text-emerald-700 tabular-nums">R$ {brl(r.valor)}</div>
                                <div className="text-[10px] text-slate-400 tabular-nums">{r.pecas} pç</div>
                              </td>
                              <td className="px-3 py-2 text-right">
                                <VariationBadge variacao={r.variacao} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Ticket médio por loja — gráfico horizontal */}
                <ChartCard title="Ticket médio por loja" icon={ShoppingBag}>
                  <ResponsiveContainer width="100%" height={Math.max(260, data.ranking.length * 24)}>
                    <BarChart
                      data={data.ranking
                        .filter((r) => r.ticketMedio > 0)
                        .map((r) => ({ name: r.name, ticket: r.ticketMedio, code: r.code }))
                      }
                      layout="vertical"
                      margin={{ left: 80, right: 16 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis type="number" stroke="#64748b" fontSize={10} tickFormatter={(v) => brlCompact(v)} />
                      <YAxis type="category" dataKey="name" stroke="#64748b" fontSize={10} width={80} />
                      <Tooltip
                        contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 }}
                        formatter={(v: any) => `R$ ${brl(v)}`}
                      />
                      <Bar dataKey="ticket" fill="#7c3aed" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>

              {/* ─── TOP VENDEDORAS + TOP PRODUTOS + TOP MARCAS ──────── */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Vendedoras */}
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
                    <Award className="w-4 h-4 text-violet-600" />
                    <h3 className="text-sm font-black uppercase tracking-wider text-slate-700">Top 5 Vendedoras</h3>
                  </div>
                  {data.topVendedoras.length === 0 ? (
                    <div className="text-center text-xs text-slate-400 py-8">Sem dados</div>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {data.topVendedoras.slice(0, 5).map((v, i) => (
                        <li key={v.codigo + i} className="px-4 py-3 flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center font-black text-xs shrink-0 ${
                            i === 0 ? 'bg-amber-100 text-amber-700' :
                            i === 1 ? 'bg-slate-200 text-slate-700' :
                            i === 2 ? 'bg-amber-50 text-amber-900' :
                            'bg-slate-100 text-slate-500'
                          }`}>{i + 1}º</div>
                          <div className="flex-1 min-w-0">
                            <div className="font-bold text-slate-800 truncate text-sm">{v.nome || `cód ${v.codigo}`}</div>
                            <div className="text-[10px] text-slate-500">{v.vendas} venda(s) · R$ {brl(v.comissao)} comissão</div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="font-black text-emerald-700 tabular-nums text-sm">R$ {brl(v.valor)}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Produtos */}
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
                    <Package className="w-4 h-4 text-violet-600" />
                    <h3 className="text-sm font-black uppercase tracking-wider text-slate-700">Top 10 Produtos</h3>
                  </div>
                  {data.topProdutos.length === 0 ? (
                    <div className="text-center text-xs text-slate-400 py-8">Sem dados</div>
                  ) : (
                    <ul className="divide-y divide-slate-100 max-h-[420px] overflow-y-auto">
                      {data.topProdutos.map((p, i) => (
                        <li key={p.refCode + i} className="px-4 py-2 flex items-center gap-2">
                          <span className="text-[10px] font-bold text-slate-400 w-5 tabular-nums">{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-xs font-bold text-violet-700">{p.refCode}</div>
                            <div className="text-[10px] text-slate-500 truncate" title={p.descricao || ''}>{p.descricao || '—'}</div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="font-bold text-emerald-700 tabular-nums text-xs">R$ {brl(p.valor)}</div>
                            <div className="text-[10px] text-slate-400 tabular-nums">{p.pecas} pç</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Marcas */}
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
                    <Tag className="w-4 h-4 text-violet-600" />
                    <h3 className="text-sm font-black uppercase tracking-wider text-slate-700">Top Marcas</h3>
                  </div>
                  {data.topMarcas.length === 0 ? (
                    <div className="text-center text-xs text-slate-400 py-8">Sem dados</div>
                  ) : (
                    <ul className="divide-y divide-slate-100 max-h-[420px] overflow-y-auto">
                      {data.topMarcas.map((m, i) => (
                        <li key={m.marca + i} className="px-4 py-2 flex items-center gap-2">
                          <span className="text-[10px] font-bold text-slate-400 w-5 tabular-nums">{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <div className="font-bold text-slate-800 text-sm truncate">{m.marca}</div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="font-bold text-emerald-700 tabular-nums text-xs">R$ {brl(m.valor)}</div>
                            <div className="text-[10px] text-slate-400 tabular-nums">{m.pecas} pç</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

            </>
          )}

        </main>
      </div>

    </div>
  );
}

// ─── COMPONENTES ─────────────────────────────────────────────────────

function SidebarItem({ icon: Icon, label, active, href }: { icon: any; label: string; active?: boolean; href?: string }) {
  const cls = `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-bold transition ${
    active ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
  }`;
  if (href) return <Link href={href} className={cls}><Icon className="w-4 h-4" />{label}</Link>;
  return <div className={cls}><Icon className="w-4 h-4" />{label}</div>;
}

function KpiCard({
  label, value, variacao, icon: Icon, color, primary,
}: {
  label: string;
  value: string;
  variacao: number | null;
  icon: any;
  color: 'emerald' | 'violet' | 'sky' | 'amber' | 'rose';
  primary?: boolean;
}) {
  const colorMap: Record<string, { iconBg: string; iconText: string; valueText: string }> = {
    emerald: { iconBg: 'bg-emerald-100', iconText: 'text-emerald-600', valueText: 'text-emerald-700' },
    violet: { iconBg: 'bg-violet-100', iconText: 'text-violet-600', valueText: 'text-violet-700' },
    sky: { iconBg: 'bg-sky-100', iconText: 'text-sky-600', valueText: 'text-sky-700' },
    amber: { iconBg: 'bg-amber-100', iconText: 'text-amber-600', valueText: 'text-amber-700' },
    rose: { iconBg: 'bg-rose-100', iconText: 'text-rose-600', valueText: 'text-rose-700' },
  };
  const c = colorMap[color];
  return (
    <div className={`bg-white rounded-2xl border ${primary ? 'border-emerald-200 ring-2 ring-emerald-100' : 'border-slate-200'} shadow-sm p-4`}>
      <div className="flex items-start justify-between mb-2">
        <div className={`w-10 h-10 rounded-xl ${c.iconBg} ${c.iconText} flex items-center justify-center`}>
          <Icon className="w-5 h-5" />
        </div>
        <VariationBadge variacao={variacao} />
      </div>
      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`text-2xl font-black tabular-nums ${c.valueText} mt-0.5`}>{value}</div>
    </div>
  );
}

function VariationBadge({ variacao }: { variacao: number | null }) {
  if (variacao === null) {
    return <span className="text-[10px] font-bold text-violet-700 bg-violet-50 border border-violet-200 px-2 py-0.5 rounded-full">novo</span>;
  }
  const isPos = variacao > 0;
  const isNeg = variacao < 0;
  const cls = isPos
    ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
    : isNeg
    ? 'text-rose-700 bg-rose-50 border-rose-200'
    : 'text-slate-500 bg-slate-50 border-slate-200';
  return (
    <span className={`text-[10px] font-bold tabular-nums px-2 py-0.5 rounded-full border ${cls} flex items-center gap-0.5`}>
      {isPos && <TrendingUp className="w-2.5 h-2.5" />}
      {isNeg && <TrendingDown className="w-2.5 h-2.5" />}
      {variacao > 0 ? '+' : ''}{variacao.toFixed(1)}%
    </span>
  );
}

function ChartCard({ title, icon: Icon, children }: { title: string; icon: any; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-violet-600" />
        <h3 className="text-sm font-black uppercase tracking-wider text-slate-700">{title}</h3>
      </div>
      {children}
    </div>
  );
}
