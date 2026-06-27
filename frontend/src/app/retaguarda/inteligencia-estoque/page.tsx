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
  Printer, CalendarRange,
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
    vendas?: number;
    vendaDiariaPecas: number;
    coberturaDias: number | null;
  };
  comparativo?: {
    periodoAnterior: { from: string; to: string };
    vendidoPecas: number;
    vendidoValor: number;
    variacao: { pecas: number | null; valor: number | null };
  };
  byDay?: Array<{ date: string; pecas: number; valor: number }>;
  topVendedoras?: Array<{
    codigo: string; nome: string; pecas: number; valor: number; vendas: number;
    comissao: number; ticketMedio: number;
  }>;
  topMarcas?: Array<{ marca: string; pecas: number; valor: number }>;
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
  { id: 'porano', label: 'Estoque por ano (PDF)', icon: CalendarRange },
] as const;

type TabId = (typeof TABS)[number]['id'];

type StockByYear = {
  years: string[];
  rows: Array<{
    storeCode: string;
    storeName: string;
    tipo: 'REDE' | 'FILIAL';
    byYear: Record<string, number>;
    total: number;
  }>;
  totalsByYear: Record<string, number>;
  grandTotal: number;
  plusSize: boolean;
  geradoEm: string;
};

const anoLabel = (k: string) => (k === 'pre2020' ? '≤ 2020' : k === 'sem_data' ? 'Sem data' : k);

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

// Botões de filtro por ano de cadastro da peça (data de entrada no Giga).
// Cores hardcoded como classes literais — Tailwind purge não suporta `bg-${x}-600`.
const YEAR_FILTER_OPTIONS = [
  { v: '',        label: 'Todas',  activeCls: 'bg-slate-700 text-white border border-slate-800',     idleCls: 'bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200' },
  { v: 'pre2020', label: '≤ 2020', activeCls: 'bg-rose-600 text-white border border-rose-700',       idleCls: 'bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200' },
  { v: '2021',    label: '2021',   activeCls: 'bg-orange-600 text-white border border-orange-700',   idleCls: 'bg-orange-50 hover:bg-orange-100 text-orange-700 border border-orange-200' },
  { v: '2022',    label: '2022',   activeCls: 'bg-amber-600 text-white border border-amber-700',     idleCls: 'bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200' },
  { v: '2023',    label: '2023',   activeCls: 'bg-emerald-600 text-white border border-emerald-700', idleCls: 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200' },
  { v: '2024',    label: '2024',   activeCls: 'bg-sky-600 text-white border border-sky-700',         idleCls: 'bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200' },
  { v: '2025',    label: '2025',   activeCls: 'bg-violet-600 text-white border border-violet-700',   idleCls: 'bg-violet-50 hover:bg-violet-100 text-violet-700 border border-violet-200' },
] as const;

export default function InteligenciaEstoquePage() {
  const [tab, setTab] = useState<TabId>('overview');

  // Filtros
  const [from, setFrom] = useState(isoTodayMinusDays(30));
  const [to, setTo] = useState(isoToday());
  const [plusSize, setPlusSize] = useState(false);
  // Ano de cadastro da peça (data de entrada no sistema). Valores:
  // '' (todos), 'pre2020' (≤2020), '2021', '2022', '2023', '2024', '2025'
  const [yearFilter, setYearFilter] = useState<string>('');

  // Overview
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // (Top sellers da rede inteira foi removido — query pesada demais.
  // O drill-down por loja continua mostrando top vendas da loja específica.)

  // Drill-down modal
  const [detailCode, setDetailCode] = useState<string | null>(null);
  const [detail, setDetail] = useState<StoreDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Heatmap
  const [heatmap, setHeatmap] = useState<Heatmap | null>(null);
  const [heatmapLoading, setHeatmapLoading] = useState(false);

  // Estoque por ano (relatório PDF)
  const [porAno, setPorAno] = useState<StockByYear | null>(null);
  const [porAnoLoading, setPorAnoLoading] = useState(false);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (plusSize) params.set('plusSize', 'true');
    if (yearFilter) params.set('year', yearFilter);
    return params.toString();
  }, [from, to, plusSize, yearFilter]);

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

  const loadPorAno = async () => {
    setPorAnoLoading(true);
    try {
      const params = new URLSearchParams();
      if (plusSize) params.set('plusSize', 'true');
      const data = await api<StockByYear>(`/intelligence/stock-by-year?${params.toString()}`);
      setPorAno(data);
    } catch {
      setPorAno(null);
    } finally {
      setPorAnoLoading(false);
    }
  };

  // Abre uma janela limpa só com o relatório e manda imprimir (Salvar como PDF).
  const imprimirPorAnoPdf = () => {
    if (!porAno) return;
    const w = window.open('', '_blank', 'width=1100,height=800');
    if (!w) {
      alert('Permita pop-ups para gerar o PDF.');
      return;
    }
    const fmt = (n: number) => n.toLocaleString('pt-BR');
    const yearTh = porAno.years.map((y) => `<th class="num">${anoLabel(y)}</th>`).join('');
    const bodyRows = porAno.rows
      .map((r) => {
        const cells = porAno.years.map((y) => `<td class="num">${fmt(r.byYear[y] || 0)}</td>`).join('');
        return `<tr>
          <td>${r.storeCode} · ${r.storeName}</td>
          <td class="tipo">${r.tipo === 'FILIAL' ? 'FRANQ' : 'REDE'}</td>
          ${cells}
          <td class="num tot">${fmt(r.total)}</td>
        </tr>`;
      })
      .join('');
    const footCells = porAno.years.map((y) => `<td class="num">${fmt(porAno.totalsByYear[y] || 0)}</td>`).join('');
    const geradoEm = new Date(porAno.geradoEm).toLocaleString('pt-BR');
    w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
      <title>Estoque por ano de cadastro</title>
      <style>
        @page { size: A4 landscape; margin: 12mm; }
        * { font-family: Arial, Helvetica, sans-serif; }
        body { color: #1e293b; margin: 0; }
        h1 { font-size: 16px; margin: 0 0 2px; }
        .sub { font-size: 11px; color: #64748b; margin: 0 0 12px; }
        table { width: 100%; border-collapse: collapse; font-size: 10px; }
        th, td { border: 0.5px solid #cbd5e1; padding: 3px 6px; text-align: left; }
        th { background: #f1f5f9; font-size: 9px; text-transform: uppercase; letter-spacing: .03em; }
        td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
        td.tipo { color: #64748b; font-size: 9px; }
        td.tot { font-weight: bold; }
        tfoot td { background: #f8fafc; font-weight: bold; border-top: 1.5px solid #94a3b8; }
        tbody tr:nth-child(even) { background: #fafafa; }
      </style></head><body>
      <h1>Estoque por ano de cadastro — todas as lojas</h1>
      <p class="sub">Peças em estoque por ano (DATAALT do produto)${porAno.plusSize ? ' · só PLUS SIZE' : ''} · gerado em ${geradoEm} · total geral ${fmt(porAno.grandTotal)} peças</p>
      <table>
        <thead><tr><th>Loja</th><th>Tipo</th>${yearTh}<th class="num">Total</th></tr></thead>
        <tbody>${bodyRows}</tbody>
        <tfoot><tr><td>TOTAL</td><td></td>${footCells}<td class="num">${fmt(porAno.grandTotal)}</td></tr></tfoot>
      </table>
      </body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 350);
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
    } else if (tab === 'heatmap') {
      loadHeatmap();
    } else if (tab === 'porano') {
      loadPorAno();
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
            onClick={() => (tab === 'overview' ? loadOverview() : tab === 'heatmap' ? loadHeatmap() : loadPorAno())}
            disabled={loading || heatmapLoading || porAnoLoading}
            className="text-sm flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading || heatmapLoading || porAnoLoading ? 'animate-spin' : ''}`} />
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

        {/* Filtro por ANO DE CADASTRO da peça (data de entrada no Giga) */}
        <div className="bg-white rounded-lg border p-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700 mr-1">
            <Calendar className="w-3.5 h-3.5 text-violet-500" />
            DATA DE ENTRADA DA PEÇA:
          </div>
          {YEAR_FILTER_OPTIONS.map((opt) => {
            const active = yearFilter === opt.v;
            return (
              <button
                key={opt.v || 'all'}
                onClick={() => setYearFilter(opt.v)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${active ? opt.activeCls + ' shadow-sm' : opt.idleCls}`}
              >
                {opt.label}
              </button>
            );
          })}
          {yearFilter && (
            <span className="text-[10px] text-slate-500 ml-2 italic">
              Filtrando peças com data de cadastro {yearFilter === 'pre2020' ? 'até 2020' : `de ${yearFilter}`}
            </span>
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

            {/* Tabela full-width */}
            <div className="bg-white rounded-lg border overflow-hidden">
                {loading ? (
                  <SkeletonTable />
                ) : !overview || overview.rows.length === 0 ? (
                  <div className="text-center py-10 text-slate-400">
                    <Store className="w-10 h-10 inline-block mb-2 opacity-50" />
                    <div className="text-sm">Sem dados pra esse período</div>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
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
                  </div>
                )}
              </div>

            <div className="text-xs text-slate-500 text-center">
              Clique numa loja pra ver top vendas, rupturas e parados dela.
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

        {tab === 'porano' && (
          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm text-slate-500">
                Peças em estoque por <b>ano de cadastro</b> (DATAALT), por loja — todas as lojas.
                {plusSize && <span className="ml-1 text-amber-600 font-semibold">Só PLUS SIZE.</span>}
              </div>
              <button
                onClick={imprimirPorAnoPdf}
                disabled={!porAno || porAnoLoading}
                className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-3 py-2 text-sm font-bold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                <Printer className="w-4 h-4" /> Imprimir / Salvar PDF
              </button>
            </div>

            <div className="bg-white rounded-lg border overflow-x-auto">
              {porAnoLoading ? (
                <div className="text-center py-10 text-slate-400">
                  <Loader2 className="w-6 h-6 animate-spin inline-block mb-2" />
                  <div className="text-sm">Calculando estoque por ano...</div>
                </div>
              ) : !porAno || porAno.rows.length === 0 ? (
                <div className="text-center py-10 text-slate-400">
                  <CalendarRange className="w-10 h-10 inline-block mb-2 opacity-50" />
                  <div className="text-sm">Sem dados</div>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Loja</th>
                      <th className="px-3 py-2 text-left">Tipo</th>
                      {porAno.years.map((y) => (
                        <th key={y} className="px-3 py-2 text-right">{anoLabel(y)}</th>
                      ))}
                      <th className="px-3 py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {porAno.rows.map((r) => (
                      <tr key={r.storeCode} className="hover:bg-slate-50">
                        <td className="px-3 py-2 whitespace-nowrap text-slate-800">
                          <span className="text-slate-400">{r.storeCode}</span> {r.storeName}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${r.tipo === 'FILIAL' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
                            {r.tipo === 'FILIAL' ? 'FRANQ' : 'REDE'}
                          </span>
                        </td>
                        {porAno.years.map((y) => (
                          <td key={y} className="px-3 py-2 text-right tabular-nums text-slate-700">{num(r.byYear[y] || 0)}</td>
                        ))}
                        <td className="px-3 py-2 text-right font-bold tabular-nums text-slate-900">{num(r.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 bg-slate-50 font-bold text-slate-800">
                      <td className="px-3 py-2">TOTAL</td>
                      <td className="px-3 py-2" />
                      {porAno.years.map((y) => (
                        <td key={y} className="px-3 py-2 text-right tabular-nums">{num(porAno.totalsByYear[y] || 0)}</td>
                      ))}
                      <td className="px-3 py-2 text-right tabular-nums">{num(porAno.grandTotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
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
            className="bg-white rounded-lg max-w-5xl w-full my-8 overflow-hidden max-h-[90vh] overflow-y-auto"
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
  sub?: React.ReactNode;
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
  // Variação % helper
  const varColor = (v: number | null | undefined) => {
    if (v === null || v === undefined) return 'text-slate-400';
    if (v > 0) return 'text-emerald-600';
    if (v < 0) return 'text-rose-600';
    return 'text-slate-500';
  };
  const varText = (v: number | null | undefined) => {
    if (v === null || v === undefined) return '—';
    return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
  };

  // Calcula max do gráfico
  const maxByDay = (detail.byDay || []).reduce((m, d) => Math.max(m, d.valor), 0);

  return (
    <div className="space-y-4">
      {/* Botão pra dashboard completo de vendas (tela inteligencia-vendas) */}
      <div className="flex justify-end">
        <a
          href={`/retaguarda/inteligencia-vendas?storeCode=${detail.store.code}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-bold bg-violet-600 hover:bg-violet-700 text-white px-3 py-2 rounded-lg shadow-sm"
        >
          <BarChart3 className="w-3.5 h-3.5" />
          Dashboard completo desta loja
        </a>
      </div>

      {/* KPIs da loja com comparativo vs período anterior */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <KpiCard label="Estoque" value={num(detail.kpis.estoqueAtual)} sub="peças" tone="blue" icon={Boxes} />
        <KpiCard
          label="Vendido"
          value={num(detail.kpis.vendidoPecas)}
          sub={detail.comparativo ? (
            <span className={varColor(detail.comparativo.variacao.pecas)}>
              {varText(detail.comparativo.variacao.pecas)} vs ant.
            </span>
          ) : `${detail.periodo.dias}d`}
          tone="emerald"
          icon={TrendingUp}
        />
        <KpiCard
          label="Faturamento"
          value={brl(detail.kpis.vendidoValor)}
          sub={detail.comparativo ? (
            <span className={varColor(detail.comparativo.variacao.valor)}>
              {varText(detail.comparativo.variacao.valor)} · Tk {brl(detail.kpis.ticketMedio)}
            </span>
          ) : `Tk ${brl(detail.kpis.ticketMedio)}`}
          tone="violet"
          icon={DollarSign}
        />
        <KpiCard
          label="Cobertura"
          value={detail.kpis.coberturaDias !== null ? `${Math.round(detail.kpis.coberturaDias)} dias` : '—'}
          sub={detail.kpis.coberturaDias !== null ? `${detail.kpis.vendaDiariaPecas.toFixed(1)} pç/dia` : 'sem venda'}
          tone={detail.kpis.coberturaDias !== null && detail.kpis.coberturaDias < 15 ? 'amber' : 'blue'}
          icon={Calendar}
        />
      </div>

      {/* Mini gráfico de vendas por dia */}
      {detail.byDay && detail.byDay.length > 0 && (
        <div className="bg-white border rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
              <BarChart3 className="w-3.5 h-3.5 text-violet-600" />
              Vendas por dia
            </div>
            <span className="text-[10px] text-slate-400">
              {detail.byDay.length} dias com venda · max R$ {brl(maxByDay)}
            </span>
          </div>
          <div className="overflow-x-auto pb-1">
            <div className="flex items-end gap-0.5 min-h-[80px]" style={{ minWidth: `${detail.byDay.length * 14}px` }}>
              {detail.byDay.map((d) => {
                const h = maxByDay > 0 ? Math.max(2, (d.valor / maxByDay) * 70) : 0;
                const dt = new Date(d.date + 'T12:00:00');
                return (
                  <div key={d.date} className="flex flex-col items-center gap-0.5 group" style={{ width: '12px' }}>
                    <div
                      className="w-full bg-gradient-to-t from-violet-600 to-fuchsia-500 rounded-t hover:from-violet-700 transition cursor-default"
                      style={{ height: `${h}px` }}
                      title={`${dt.getDate()}/${dt.getMonth() + 1}: R$ ${brl(d.valor)} · ${d.pecas} pç`}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Top vendedoras + top marcas — 2 cards lado a lado */}
      {(detail.topVendedoras?.length || detail.topMarcas?.length) ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Top vendedoras com comissão */}
          <DrillCard title="Top Vendedoras (comissão 2%)" icon={TrendingUp} color="emerald">
            {detail.topVendedoras && detail.topVendedoras.length > 0 ? (
              <div className="space-y-1">
                {detail.topVendedoras.slice(0, 8).map((v, i) => (
                  <div key={v.codigo + i} className="flex items-center justify-between text-xs gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-slate-700 truncate">{v.nome || `Cód ${v.codigo}`}</div>
                      <div className="text-[10px] text-slate-400">{v.vendas} venda(s) · {v.pecas} pç</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-bold text-slate-700 tabular-nums">R$ {brl(v.valor)}</div>
                      <div className="text-[10px] font-bold text-emerald-600 tabular-nums">+R$ {brl(v.comissao)}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-slate-400 text-center py-4">Sem dados de vendedora<br /><span className="text-[10px]">(coluna não detectada na caixa do Giga)</span></div>
            )}
          </DrillCard>

          {/* Top marcas */}
          <DrillCard title="Top Marcas" icon={DollarSign} color="violet">
            {detail.topMarcas && detail.topMarcas.length > 0 ? (
              <div className="space-y-1">
                {detail.topMarcas.slice(0, 8).map((m, i) => (
                  <div key={m.marca + i} className="flex items-center justify-between text-xs gap-2">
                    <div className="font-semibold text-slate-700 truncate flex-1">{m.marca}</div>
                    <div className="text-right shrink-0">
                      <span className="font-bold text-slate-700 tabular-nums">R$ {brl(m.valor)}</span>
                      <span className="text-[10px] text-slate-400 ml-1.5">{m.pecas} pç</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-slate-400 text-center py-4">Sem dados de marca</div>
            )}
          </DrillCard>
        </div>
      ) : null}

      {/* 4 quadrantes — top produtos + rupturas + parados */}
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
