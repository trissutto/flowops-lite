'use client';

/**
 * /retaguarda/inteligencia-estoque
 *
 * Dashboard de inteligência de estoque por loja em tempo real.
 *
 * Fontes:
 *   - Giga (estoque atual + venda do `caixa`)
 *   - Postgres (movimentação de remessas)
 *
 * Camadas:
 *   1. Filtros: data inicio/fim + PLUS SIZE
 *   2. KPIs gerais (estoque rede vs franquia, vendas)
 *   3. Tabela principal (1 linha por loja, clickable pra drill-down)
 *   4. Card lateral: top REFs (peças e valor, alternável)
 *   5. Modal drill-down por loja: top vendas, rupturas, parados, cobertura
 *   6. Aba "Heatmap" REF×Loja
 *   7. Botão Exportar CSV (abre no Excel)
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, RefreshCw, Loader2, AlertTriangle, Calendar, Filter,
  Package, TrendingUp, TrendingDown, Store, BarChart3, Grid3x3,
  Download, X, ChevronRight, AlertCircle, Boxes, DollarSign,
} from 'lucide-react';
import { api } from '@/lib/api';

type StoreRow = {
  storeCode: string;
  storeName: string;
  tipo: 'REDE' | 'FILIAL';
  estoqueAtual: number;
  recebido: number;
  enviado: number;
  vendidoPecas: number;
  vendidoValor: number;
  saldoMovimento: number;
  ticketMedio: number;
};

type Overview = {
  periodo: { from: string; to: string; plusSize: boolean };
  totaisGerais: {
    estoqueRede: number;
    estoqueFranquia: number;
    estoqueTotal: number;
    vendidoRede: { pecas: number; valor: number };
    vendidoFranquia: { pecas: number; valor: number };
    vendidoTotal: { pecas: number; valor: number };
  };
  rows: StoreRow[];
};

type TopRef = {
  refCode: string;
  descricao: string | null;
  pecas: number;
  valor: number;
};

type Ruptura = {
  refCode: string;
  descricao: string | null;
  pecasVendidas: number;
  estoqueAtual: number;
};

type Parado = {
  refCode: string;
  descricao: string | null;
  estoqueAtual: number;
  ultimaVenda: string | null;
};

type StoreDetail = {
  store: { code: string; name: string; tipo: 'REDE' | 'FILIAL' };
  periodo: { from: string; to: string; dias: number; plusSize: boolean };
  kpis: {
    estoqueAtual: number;
    vendidoPecas: number;
    vendidoValor: number;
    ticketMedio: number;
    vendaDiariaPecas: number;
    coberturaDias: number | null;
  };
  topVendasPorPeca: TopRef[];
  topVendasPorValor: TopRef[];
  rupturas: Ruptura[];
  parados: Parado[];
};

type Heatmap = {
  refs: Array<{ refCode: string; descricao: string | null; totalRede: number }>;
  lojas: string[];
  matrix: Record<string, Record<string, number>>;
};

const TABS = [
  { id: 'overview', label: 'Visão geral', icon: BarChart3 },
  { id: 'heatmap', label: 'Heatmap REF × Loja', icon: Grid3x3 },
] as const;

type TabId = (typeof TABS)[number]['id'];

// ─── helpers ─────────────────────────────────────────────────────────
const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (n: number) => n.toLocaleString('pt-BR');

function isoTodayMinusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function InteligenciaEstoquePage() {
  const [tab, setTab] = useState<TabId>('overview');

  // Filtros
  const [from, setFrom] = useState(isoTodayMinusDays(30));
  const [to, setTo] = useState(isoToday());
  const [plusSize, setPlusSize] = useState(false);

  // Overview
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Top sellers (rede inteira)
  const [topPecas, setTopPecas] = useState<TopRef[]>([]);
  const [topValor, setTopValor] = useState<TopRef[]>([]);
  const [topMode, setTopMode] = useState<'pecas' | 'valor'>('pecas');
  const [topLoading, setTopLoading] = useState(false);

  // Drill-down modal
  const [detailCode, setDetailCode] = useState<string | null>(null);
  const [detail, setDetail] = useState<StoreDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Heatmap
  const [heatmap, setHeatmap] = useState<Heatmap | null>(null);
  const [heatmapLoading, setHeatmapLoading] = useState(false);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (plusSize) params.set('plusSize', 'true');
    return params.toString();
  }, [from, to, plusSize]);

  // ── Loaders ──
  const loadOverview = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<Overview>(`/intelligence/overview?${queryString}`);
      setOverview(data);
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar overview');
    } finally {
      setLoading(false);
    }
  };

  const loadTopSellers = async () => {
    setTopLoading(true);
    try {
      const [pecas, valor] = await Promise.all([
        api<TopRef[]>(`/intelligence/top-sellers?${queryString}&orderBy=pecas&limit=10`),
        api<TopRef[]>(`/intelligence/top-sellers?${queryString}&orderBy=valor&limit=10`),
      ]);
      setTopPecas(pecas);
      setTopValor(valor);
    } catch {
      setTopPecas([]);
      setTopValor([]);
    } finally {
      setTopLoading(false);
    }
  };

  const loadHeatmap = async () => {
    setHeatmapLoading(true);
    try {
      const params = new URLSearchParams();
      if (plusSize) params.set('plusSize', 'true');
      params.set('limit', '20');
      const data = await api<Heatmap>(`/intelligence/heatmap?${params.toString()}`);
      setHeatmap(data);
    } catch {
      setHeatmap(null);
    } finally {
      setHeatmapLoading(false);
    }
  };

  const openDetail = async (code: string) => {
    setDetailCode(code);
    setDetail(null);
    setDetailLoading(true);
    try {
      const d = await api<StoreDetail>(`/intelligence/store/${code}?${queryString}`);
      setDetail(d);
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
      setDetailCode(null);
    } finally {
      setDetailLoading(false);
    }
  };

  // ── Effects ──
  useEffect(() => {
    if (tab === 'overview') {
      loadOverview();
      loadTopSellers();
    } else if (tab === 'heatmap') {
      loadHeatmap();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, queryString]);

  // ── Export CSV ──
  const exportOverviewCsv = () => {
    if (!overview) return;
    const headers = [
      'Loja',
      'Nome',
      'Tipo',
      'Estoque atual (peças)',
      'Recebido (peças)',
      'Enviado (peças)',
      'Vendido (peças)',
      'Vendido (R$)',
      'Saldo movimento',
      'Ticket médio (R$)',
    ];
    const lines = [headers.join(';')];
    for (const r of overview.rows) {
      lines.push(
        [
          r.storeCode,
          `"${r.storeName.replace(/"/g, '""')}"`,
          r.tipo === 'FILIAL' ? 'FRANQUIA' : 'REDE',
          r.estoqueAtual,
          r.recebido,
          r.enviado,
          r.vendidoPecas,
          r.vendidoValor.toFixed(2).replace('.', ','),
          r.saldoMovimento,
          r.ticketMedio.toFixed(2).replace('.', ','),
        ].join(';'),
      );
    }
    const csv = '﻿' + lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inteligencia-estoque-${from}-a-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Atalhos de período
  const setLastDays = (days: number) => {
    setTo(isoToday());
    setFrom(isoTodayMinusDays(days));
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-white border-b shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/loja" className="text-slate-500 hover:text-slate-700" aria-label="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-violet-600" />
              Inteligência de Estoque
            </h1>
            <p className="text-xs text-slate-500">
              Estoque + venda + movimentação por loja em tempo real
            </p>
          </div>
          <button
            onClick={() => (tab === 'overview' ? (loadOverview(), loadTopSellers()) : loadHeatmap())}
            disabled={loading || heatmapLoading}
            className="text-sm flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading || heatmapLoading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>
        {/* Tabs */}
        <div className="max-w-7xl mx-auto px-4 flex gap-1 border-b">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-3 py-2 text-sm font-medium flex items-center gap-1.5 border-b-2 transition-colors ${
                  tab === t.id
                    ? 'border-violet-600 text-violet-700'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                <Icon className="w-4 h-4" />
                {t.label}
              </button>
            );
          })}
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 space-y-4">
        {/* Filtros */}
        <div className="bg-white rounded-lg border p-3 flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-1">
            <Calendar className="w-4 h-4 text-slate-400" />
            <label className="text-xs text-slate-500 mr-1">De</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="text-sm border rounded-md px-2 py-1.5"
            />
          </div>
          <div className="flex items-center gap-1">
            <label className="text-xs text-slate-500 mr-1">Até</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="text-sm border rounded-md px-2 py-1.5"
            />
          </div>
          <div className="flex gap-1">
            <button onClick={() => setLastDays(7)} className="text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200">
              7d
            </button>
            <button onClick={() => setLastDays(30)} className="text-xs px-2 py-1 rounded bg-violet-100 hover:bg-violet-200 text-violet-700 font-bold">
              30d
            </button>
            <button onClick={() => setLastDays(90)} className="text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200">
              90d
            </button>
          </div>
          <label className="flex items-center gap-1.5 ml-2 text-sm">
            <input
              type="checkbox"
              checked={plusSize}
              onChange={(e) => setPlusSize(e.target.checked)}
              className="rounded"
            />
            <Filter className="w-3.5 h-3.5 text-rose-500" />
            <span>Só PLUS SIZE</span>
          </label>
          <div className="flex-1" />
          {tab === 'overview' && overview && (
            <button
              onClick={exportOverviewCsv}
              className="text-xs flex items-center gap-1 px-3 py-1.5 rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200"
            >
              <Download className="w-3 h-3" />
              CSV
            </button>
          )}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-md text-sm">
            {error}
          </div>
        )}

        {/* TAB: OVERVIEW */}
        {tab === 'overview' && (
          <>
            {/* KPIs gerais */}
            {overview && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <KpiCard
                  label="Estoque REDE"
                  value={num(overview.totaisGerais.estoqueRede)}
                  sub="peças"
                  tone="blue"
                  icon={Boxes}
                />
                <KpiCard
                  label="Estoque FRANQUIAS"
                  value={num(overview.totaisGerais.estoqueFranquia)}
                  sub="peças"
                  tone="amber"
                  icon={Boxes}
                />
                <KpiCard
                  label="Vendido total"
                  value={num(overview.totaisGerais.vendidoTotal.pecas)}
                  sub="peças no período"
                  tone="emerald"
                  icon={TrendingUp}
                />
                <KpiCard
                  label="Faturamento"
                  value={brl(overview.totaisGerais.vendidoTotal.valor)}
                  sub="bruto no período"
                  tone="violet"
                  icon={DollarSign}
                />
              </div>
            )}

            {/* Tabela + Top sellers */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 bg-white rounded-lg border overflow-hidden">
                {loading ? (
                  <SkeletonTable />
                ) : !overview || overview.rows.length === 0 ? (
                  <div className="text-center py-10 text-slate-400">
                    <Store className="w-10 h-10 inline-block mb-2 opacity-50" />
                    <div className="text-sm">Sem dados pra esse período</div>
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 border-b text-xs uppercase text-slate-500">
                      <tr>
                        <th className="text-left px-3 py-2">Loja</th>
                        <th className="text-center px-2 py-2">Tipo</th>
                        <th className="text-right px-2 py-2" title="Estoque atual em peças">Estoque</th>
                        <th className="text-right px-2 py-2" title="Recebido no período (peças)">Recebido</th>
                        <th className="text-right px-2 py-2" title="Enviado no período (peças)">Enviado</th>
                        <th className="text-right px-2 py-2" title="Peças vendidas">Vendido</th>
                        <th className="text-right px-2 py-2" title="Faturamento bruto">R$ Vendido</th>
                        <th className="text-right px-2 py-2">Saldo</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.rows.map((r) => {
                        const isFilial = r.tipo === 'FILIAL';
                        const saldoNeg = r.saldoMovimento < 0;
                        return (
                          <tr
                            key={r.storeCode}
                            onClick={() => openDetail(r.storeCode)}
                            className="border-b last:border-0 hover:bg-violet-50/50 cursor-pointer transition-colors"
                          >
                            <td className="px-3 py-2">
                              <div className="font-medium text-slate-800">{r.storeName}</div>
                              <div className="text-xs text-slate-400 font-mono">{r.storeCode}</div>
                            </td>
                            <td className="px-2 py-2 text-center">
                              <span
                                className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                                  isFilial ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
                                }`}
                              >
                                {isFilial ? 'FRANQ' : 'REDE'}
                              </span>
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums font-semibold text-slate-700">
                              {num(r.estoqueAtual)}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums text-emerald-600">
                              {r.recebido > 0 ? `+${num(r.recebido)}` : '0'}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums text-rose-600">
                              {r.enviado > 0 ? `−${num(r.enviado)}` : '0'}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums text-slate-700">
                              {num(r.vendidoPecas)}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums font-semibold text-emerald-700">
                              {brl(r.vendidoValor)}
                            </td>
                            <td className={`px-2 py-2 text-right tabular-nums font-bold ${saldoNeg ? 'text-rose-700' : 'text-slate-600'}`}>
                              {r.saldoMovimento >= 0 ? '+' : ''}{num(r.saldoMovimento)}
                            </td>
                            <td className="px-2 py-2 text-slate-400">
                              <ChevronRight className="w-4 h-4" />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Top sellers card */}
              <div className="bg-white rounded-lg border overflow-hidden">
                <div className="px-3 py-2 border-b bg-slate-50 flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
                    <TrendingUp className="w-4 h-4 text-emerald-600" />
                    Top 10 vendidas (rede)
                  </div>
                  <div className="flex bg-slate-100 rounded p-0.5">
                    <button
                      onClick={() => setTopMode('pecas')}
                      className={`text-xs px-2 py-0.5 rounded ${topMode === 'pecas' ? 'bg-white shadow-sm font-bold' : 'text-slate-500'}`}
                    >
                      Peças
                    </button>
                    <button
                      onClick={() => setTopMode('valor')}
                      className={`text-xs px-2 py-0.5 rounded ${topMode === 'valor' ? 'bg-white shadow-sm font-bold' : 'text-slate-500'}`}
                    >
                      R$
                    </button>
                  </div>
                </div>
                <div className="p-2">
                  {topLoading ? (
                    <div className="text-center py-6 text-slate-400">
                      <Loader2 className="w-5 h-5 animate-spin inline-block" />
                    </div>
                  ) : (
                    <TopList items={topMode === 'pecas' ? topPecas : topValor} mode={topMode} />
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* TAB: HEATMAP */}
        {tab === 'heatmap' && (
          <div className="bg-white rounded-lg border overflow-hidden">
            {heatmapLoading ? (
              <div className="text-center py-10 text-slate-400">
                <Loader2 className="w-6 h-6 animate-spin inline-block mb-2" />
                <div className="text-sm">Calculando heatmap...</div>
              </div>
            ) : !heatmap || heatmap.refs.length === 0 ? (
              <div className="text-center py-10 text-slate-400">
                <Grid3x3 className="w-10 h-10 inline-block mb-2 opacity-50" />
                <div className="text-sm">Sem dados</div>
              </div>
            ) : (
              <HeatmapTable heatmap={heatmap} />
            )}
          </div>
        )}
      </main>

      {/* Modal drill-down */}
      {detailCode && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-y-auto"
          onClick={() => setDetailCode(null)}
        >
          <div
            className="bg-white rounded-lg max-w-5xl w-full my-8 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b flex items-center justify-between bg-slate-50 sticky top-0">
              <div>
                <h2 className="font-semibold text-slate-800 flex items-center gap-2">
                  <Store className="w-4 h-4" />
                  {detail?.store.name || detailCode}
                </h2>
                {detail && (
                  <div className="text-xs text-slate-500">
                    {detail.store.code} · {detail.store.tipo === 'FILIAL' ? 'FRANQUIA' : 'REDE'} · {detail.periodo.dias} dias
                  </div>
                )}
              </div>
              <button onClick={() => setDetailCode(null)} className="p-1.5 hover:bg-slate-200 rounded">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4">
              {detailLoading ? (
                <div className="text-center py-10 text-slate-400">
                  <Loader2 className="w-6 h-6 animate-spin inline-block mb-2" />
                  <div className="text-sm">Carregando...</div>
                </div>
              ) : detail ? (
                <DrilldownContent detail={detail} />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Subcomponentes ────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: 'blue' | 'amber' | 'emerald' | 'violet';
  icon: any;
}) {
  const TONES: Record<string, { bg: string; text: string }> = {
    blue: { bg: '#dde7ea', text: '#2e4750' },
    amber: { bg: '#fef3c7', text: '#854d0e' },
    emerald: { bg: '#e3ebd9', text: '#475636' },
    violet: { bg: '#ebe2eb', text: '#4f4054' },
  };
  const t = TONES[tone];
  return (
    <div className="rounded-lg border p-3" style={{ background: t.bg, borderColor: t.text + '30' }}>
      <div className="flex items-center justify-between mb-1">
        <Icon className="w-4 h-4" style={{ color: t.text }} />
      </div>
      <div className="text-xl font-bold tabular-nums" style={{ color: t.text }}>
        {value}
      </div>
      <div className="text-[10px] uppercase font-semibold" style={{ color: t.text, opacity: 0.7 }}>
        {label}
      </div>
      {sub && (
        <div className="text-[10px]" style={{ color: t.text, opacity: 0.6 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function TopList({ items, mode }: { items: TopRef[]; mode: 'pecas' | 'valor' }) {
  if (!items.length) {
    return <div className="text-center py-6 text-slate-400 text-sm">Sem vendas no período</div>;
  }
  const max = Math.max(...items.map((i) => (mode === 'pecas' ? i.pecas : i.valor)));
  return (
    <div className="space-y-1">
      {items.map((it, idx) => {
        const v = mode === 'pecas' ? it.pecas : it.valor;
        const pct = max > 0 ? (v / max) * 100 : 0;
        return (
          <div key={it.refCode} className="text-xs">
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-slate-400 tabular-nums w-4 text-right">{idx + 1}.</span>
                <span className="font-mono font-semibold text-slate-700">{it.refCode}</span>
                {it.descricao && (
                  <span className="text-slate-500 truncate">{it.descricao}</span>
                )}
              </div>
              <span className="font-bold text-emerald-700 tabular-nums shrink-0">
                {mode === 'pecas' ? num(it.pecas) : brl(it.valor)}
              </span>
            </div>
            <div className="h-1 bg-slate-100 rounded overflow-hidden">
              <div className="h-full bg-emerald-400" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DrilldownContent({ detail }: { detail: StoreDetail }) {
  return (
    <div className="space-y-4">
      {/* KPIs da loja */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <KpiCard label="Estoque" value={num(detail.kpis.estoqueAtual)} sub="peças" tone="blue" icon={Boxes} />
        <KpiCard label="Vendido" value={num(detail.kpis.vendidoPecas)} sub={`${detail.periodo.dias}d`} tone="emerald" icon={TrendingUp} />
        <KpiCard label="Faturamento" value={brl(detail.kpis.vendidoValor)} sub={`Ticket ${brl(detail.kpis.ticketMedio)}`} tone="violet" icon={DollarSign} />
        <KpiCard
          label="Cobertura"
          value={detail.kpis.coberturaDias !== null ? `${Math.round(detail.kpis.coberturaDias)} dias` : '—'}
          sub={detail.kpis.coberturaDias !== null ? `${detail.kpis.vendaDiariaPecas.toFixed(1)} pç/dia` : 'sem venda'}
          tone={detail.kpis.coberturaDias !== null && detail.kpis.coberturaDias < 15 ? 'amber' : 'blue'}
          icon={Calendar}
        />
      </div>

      {/* 4 quadrantes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <DrillCard title="Top vendas — peças" icon={TrendingUp} color="emerald">
          <TopList items={detail.topVendasPorPeca} mode="pecas" />
        </DrillCard>
        <DrillCard title="Top vendas — R$" icon={DollarSign} color="violet">
          <TopList items={detail.topVendasPorValor} mode="valor" />
        </DrillCard>
        <DrillCard
          title="Rupturas (vendeu, estoque 0)"
          icon={AlertCircle}
          color="rose"
          subtitle="Repor com urgência"
        >
          {detail.rupturas.length === 0 ? (
            <div className="text-xs text-slate-400 text-center py-4">Sem rupturas — bom!</div>
          ) : (
            <div className="space-y-1">
              {detail.rupturas.map((r) => (
                <div key={r.refCode} className="flex items-center justify-between text-xs gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono font-semibold text-slate-700">{r.refCode}</div>
                    {r.descricao && <div className="text-slate-500 truncate">{r.descricao}</div>}
                  </div>
                  <span className="font-bold text-rose-700 tabular-nums shrink-0">
                    {r.pecasVendidas} vendida(s)
                  </span>
                </div>
              ))}
            </div>
          )}
        </DrillCard>
        <DrillCard
          title="Parados (estoque alto, sem venda 30d)"
          icon={TrendingDown}
          color="amber"
          subtitle="Candidatos a realinhar"
        >
          {detail.parados.length === 0 ? (
            <div className="text-xs text-slate-400 text-center py-4">Sem parados — bom!</div>
          ) : (
            <div className="space-y-1">
              {detail.parados.map((p) => (
                <div key={p.refCode} className="flex items-center justify-between text-xs gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono font-semibold text-slate-700">{p.refCode}</div>
                    {p.descricao && <div className="text-slate-500 truncate">{p.descricao}</div>}
                    {p.ultimaVenda && (
                      <div className="text-[10px] text-slate-400">Última venda: {p.ultimaVenda}</div>
                    )}
                  </div>
                  <span className="font-bold text-amber-700 tabular-nums shrink-0">
                    {num(p.estoqueAtual)} pç
                  </span>
                </div>
              ))}
            </div>
          )}
        </DrillCard>
      </div>
    </div>
  );
}

function DrillCard({
  title,
  subtitle,
  icon: Icon,
  color,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: any;
  color: 'emerald' | 'violet' | 'rose' | 'amber';
  children: React.ReactNode;
}) {
  const COLORS: Record<string, string> = {
    emerald: 'text-emerald-600',
    violet: 'text-violet-600',
    rose: 'text-rose-600',
    amber: 'text-amber-600',
  };
  return (
    <div className="border rounded-lg overflow-hidden bg-white">
      <div className="px-3 py-2 border-b bg-slate-50">
        <div className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
          <Icon className={`w-4 h-4 ${COLORS[color]}`} />
          {title}
        </div>
        {subtitle && <div className="text-[10px] text-slate-500">{subtitle}</div>}
      </div>
      <div className="p-2">{children}</div>
    </div>
  );
}

function HeatmapTable({ heatmap }: { heatmap: Heatmap }) {
  // Calcula valor max global pra escala de cor
  const allValues: number[] = [];
  for (const ref of heatmap.refs) {
    for (const code of heatmap.lojas) {
      const v = heatmap.matrix[ref.refCode]?.[code] || 0;
      if (v > 0) allValues.push(v);
    }
  }
  const max = Math.max(...allValues, 1);

  const colorFor = (v: number) => {
    if (v === 0) return 'bg-slate-50 text-slate-300';
    const intensity = Math.min(1, v / max);
    if (intensity > 0.66) return 'bg-emerald-300 text-emerald-900 font-bold';
    if (intensity > 0.33) return 'bg-emerald-100 text-emerald-700';
    return 'bg-emerald-50 text-emerald-600';
  };

  return (
    <div className="overflow-auto max-h-[70vh]">
      <table className="text-xs">
        <thead className="sticky top-0 bg-white z-10">
          <tr className="border-b">
            <th className="text-left px-2 py-2 sticky left-0 bg-white z-20 min-w-[200px]">REF</th>
            <th className="text-right px-2 py-2 sticky left-[200px] bg-white z-20 min-w-[60px]">Total</th>
            {heatmap.lojas.map((code) => (
              <th key={code} className="px-1 py-2 text-center font-mono min-w-[40px]">{code}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {heatmap.refs.map((ref) => (
            <tr key={ref.refCode} className="border-b hover:bg-slate-50">
              <td className="px-2 py-1 sticky left-0 bg-white z-10">
                <div className="font-mono font-semibold text-slate-700">{ref.refCode}</div>
                {ref.descricao && (
                  <div className="text-[10px] text-slate-400 truncate max-w-[180px]">{ref.descricao}</div>
                )}
              </td>
              <td className="px-2 py-1 text-right font-bold tabular-nums sticky left-[200px] bg-white z-10">
                {num(ref.totalRede)}
              </td>
              {heatmap.lojas.map((code) => {
                const v = heatmap.matrix[ref.refCode]?.[code] || 0;
                return (
                  <td
                    key={code}
                    className={`px-1 py-1 text-center tabular-nums ${colorFor(v)}`}
                    title={`${ref.refCode} em ${code}: ${v} peças`}
                  >
                    {v || '·'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SkeletonTable() {
  return (
    <div className="p-4 space-y-2">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="h-8 bg-slate-100 rounded animate-pulse" />
      ))}
    </div>
  );
}
