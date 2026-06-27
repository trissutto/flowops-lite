'use client';

/**
 * /retaguarda/inteligencia-vendas — Dashboard de relatório de vendas.
 *
 * Fonte de dados: tabela `caixa` do Giga (rede toda — Wincred até 26/04
 * + nosso PDV depois). Loja 13 (Site) entra natural na agregação.
 *
 * Componentes:
 *  - Filtros: período (presets + custom), loja, comissão %, plus size
 *  - 4 KPIs: Total vendido, Peças, Vendas, Ticket médio
 *  - Gráfico: Vendas por dia (barras)
 *  - 4 tabelas: Top Lojas, Top Vendedoras (com comissão), Top Marcas, Top Produtos
 *
 * Layout 2 colunas em desktop, empilhado em mobile. Cores neutras pra ficar
 * fácil de ler — sem competição visual.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Loader2, BarChart3, Calendar, Filter, RefreshCw, Store,
  TrendingUp, ShoppingBag, Users, Receipt, Tag, Package, AlertCircle,
} from 'lucide-react';
import { api } from '@/lib/api';

type Summary = { pecas: number; valor: number; vendas: number; ticketMedio: number };
type ByStore = { code: string; name: string; tipo: string | null; pecas: number; valor: number; ticketMedio: number };
type ByDay = { date: string; pecas: number; valor: number };
type Vendedora = { codigo: string; nome: string; pecas: number; valor: number; vendas: number; comissao: number; ticketMedio: number };
type Marca = { marca: string; pecas: number; valor: number };
type Produto = { refCode: string; descricao: string | null; pecas: number; valor: number };

type Report = {
  periodo: { from: string; to: string; dias: number };
  filtros: { storeCode: string | null; comissaoPct: number; plusSize: boolean; compareYoY?: boolean };
  summary: Summary;
  byStore: ByStore[];
  byDay: ByDay[];
  topVendedoras: Vendedora[];
  topMarcas: Marca[];
  topProdutos: Produto[];
  yoy?: {
    periodoAnterior: { from: string; to: string };
    summary: Summary;
    byDay: ByDay[];
    variacao: {
      valor: number | null;
      pecas: number | null;
      vendas: number | null;
      ticketMedio: number | null;
    };
  } | null;
};

type Store = { code: string; name: string; active: boolean };

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const isoToday = () => new Date().toISOString().slice(0, 10);
const isoTodayMinusDays = (d: number) => {
  const date = new Date();
  date.setDate(date.getDate() - d);
  return date.toISOString().slice(0, 10);
};

// Presets de período
const PRESETS = [
  { label: 'Hoje', from: () => isoToday(), to: () => isoToday() },
  { label: 'Ontem', from: () => isoTodayMinusDays(1), to: () => isoTodayMinusDays(1) },
  { label: '7 dias', from: () => isoTodayMinusDays(7), to: () => isoToday() },
  { label: '30 dias', from: () => isoTodayMinusDays(30), to: () => isoToday() },
  { label: 'Mês atual', from: () => {
    const d = new Date(); d.setDate(1);
    return d.toISOString().slice(0, 10);
  }, to: () => isoToday() },
  { label: 'Mês passado', from: () => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 10);
  }, to: () => {
    const d = new Date(); d.setDate(0); // último dia do mês passado
    return d.toISOString().slice(0, 10);
  }},
  { label: 'Ano', from: () => {
    const d = new Date(); d.setMonth(0); d.setDate(1);
    return d.toISOString().slice(0, 10);
  }, to: () => isoToday() },
];

export default function InteligenciaVendasPage() {
  const [from, setFrom] = useState(isoTodayMinusDays(30));
  const [to, setTo] = useState(isoToday());
  const [storeCode, setStoreCode] = useState('');
  const [comissaoPct, setComissaoPct] = useState(2);
  const [plusSize, setPlusSize] = useState(false);
  const [compareYoY, setCompareYoY] = useState(true); // default ON — comparativo é a feature principal
  const [stores, setStores] = useState<Store[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Carrega lojas no boot
  useEffect(() => {
    (async () => {
      try {
        const r = await api<Store[]>('/admin/stores');
        setStores((r || []).filter((s) => s.active));
      } catch {/* ignora */}
    })();
  }, []);

  async function fetchReport() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        from, to,
        comissaoPct: String(comissaoPct),
      });
      if (storeCode) params.set('storeCode', storeCode);
      if (plusSize) params.set('plusSize', 'true');
      if (compareYoY) params.set('compareYoY', 'true');
      const r = await api<Report>(`/intelligence/sales-report?${params.toString()}`);
      setReport(r);
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar relatório');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchReport(); /* eslint-disable-next-line */ }, []);

  // Aplica preset de período
  function applyPreset(p: typeof PRESETS[0]) {
    setFrom(p.from());
    setTo(p.to());
    setTimeout(() => fetchReport(), 50);
  }

  // Calcula valor máximo do gráfico (pra escala das barras) — considerando
  // período atual E período anterior (se YoY ativo) pra alinhar escala.
  const maxByDay = useMemo(() => {
    if (!report?.byDay?.length) return 0;
    const atual = Math.max(...report.byDay.map((d) => d.valor));
    const prev = report.yoy?.byDay?.length
      ? Math.max(...report.yoy.byDay.map((d) => d.valor))
      : 0;
    return Math.max(atual, prev);
  }, [report?.byDay, report?.yoy?.byDay]);

  // Cria mapa indexado por "MM-DD" do período anterior pra alinhar com atual
  const prevByMMDD = useMemo(() => {
    const m = new Map<string, ByDay>();
    for (const d of report?.yoy?.byDay || []) {
      m.set(d.date.slice(5), d); // "MM-DD"
    }
    return m;
  }, [report?.yoy?.byDay]);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-gradient-to-r from-violet-800 via-violet-700 to-fuchsia-700 border-b border-violet-900/40 shadow-md sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="text-white/80 hover:text-white" aria-label="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <BarChart3 className="w-6 h-6 text-white" />
          <div className="flex-1">
            <h1 className="text-xl font-black text-white leading-none drop-shadow">
              Inteligência de Vendas
            </h1>
            <p className="text-[11px] text-white/85 font-medium mt-0.5">
              Relatório agregado · rede + site (loja 13)
            </p>
          </div>
          <button
            onClick={fetchReport}
            disabled={loading}
            className="bg-white/95 hover:bg-white text-violet-800 px-3 py-2 rounded-lg flex items-center gap-1.5 font-bold text-xs disabled:opacity-50 shadow-md"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Atualizar
          </button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-4 space-y-4">

        {/* ─── FILTROS ─────────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-violet-700">
            <Filter className="w-4 h-4" /> Filtros
          </div>

          {/* Presets */}
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => applyPreset(p)}
                className="px-3 py-1.5 rounded-lg text-xs font-bold border bg-white hover:bg-violet-50 border-slate-200 hover:border-violet-300 text-slate-700 hover:text-violet-700 transition"
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Inputs */}
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">De</label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-full border border-slate-200 rounded px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Até</label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-full border border-slate-200 rounded px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Loja</label>
              <select
                value={storeCode}
                onChange={(e) => setStoreCode(e.target.value)}
                className="w-full border border-slate-200 rounded px-2 py-1.5 text-sm bg-white"
              >
                <option value="">Todas as lojas</option>
                {stores.map((s) => (
                  <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Comissão %</label>
              <input
                type="number"
                step="0.5"
                min="0"
                max="20"
                value={comissaoPct}
                onChange={(e) => setComissaoPct(Number(e.target.value) || 0)}
                className="w-full border border-slate-200 rounded px-2 py-1.5 text-sm"
              />
            </div>
            <div className="flex items-end gap-2">
              <button
                onClick={fetchReport}
                disabled={loading}
                className="w-full bg-violet-600 hover:bg-violet-700 text-white px-3 py-1.5 rounded-lg font-bold text-sm disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <BarChart3 className="w-4 h-4" />}
                Gerar
              </button>
            </div>
          </div>

          {/* Toggles */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={compareYoY}
                onChange={(e) => setCompareYoY(e.target.checked)}
                className="w-4 h-4 rounded text-violet-600 border-slate-300"
              />
              <span className="font-bold">Comparar com mesmo período do ano anterior (YoY)</span>
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={plusSize}
                onChange={(e) => setPlusSize(e.target.checked)}
                className="w-4 h-4 rounded text-violet-600 border-slate-300"
              />
              <span>Somente PLUS SIZE</span>
            </label>
          </div>
        </div>

        {/* ─── ERRO ────────────────────────────────────────────────────── */}
        {error && (
          <div className="bg-rose-50 border-2 border-rose-300 text-rose-800 p-3 rounded-xl text-sm flex items-start gap-2">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-rose-600" />
            <div>
              <div className="font-bold">Erro ao carregar relatório</div>
              <div className="text-xs mt-0.5">{error}</div>
            </div>
          </div>
        )}

        {/* ─── KPIs ────────────────────────────────────────────────────── */}
        {report && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi
              label="Total vendido"
              value={`R$ ${brl(report.summary.valor)}`}
              icon={TrendingUp}
              color="emerald"
              prevValue={report.yoy ? `R$ ${brl(report.yoy.summary.valor)}` : undefined}
              variacao={report.yoy?.variacao.valor}
            />
            <Kpi
              label="Peças"
              value={report.summary.pecas.toLocaleString('pt-BR')}
              icon={Package}
              color="violet"
              prevValue={report.yoy ? report.yoy.summary.pecas.toLocaleString('pt-BR') : undefined}
              variacao={report.yoy?.variacao.pecas}
            />
            <Kpi
              label="Vendas"
              value={report.summary.vendas.toLocaleString('pt-BR')}
              icon={Receipt}
              color="sky"
              prevValue={report.yoy ? report.yoy.summary.vendas.toLocaleString('pt-BR') : undefined}
              variacao={report.yoy?.variacao.vendas}
            />
            <Kpi
              label="Ticket médio"
              value={`R$ ${brl(report.summary.ticketMedio)}`}
              icon={ShoppingBag}
              color="amber"
              prevValue={report.yoy ? `R$ ${brl(report.yoy.summary.ticketMedio)}` : undefined}
              variacao={report.yoy?.variacao.ticketMedio}
            />
          </div>
        )}

        {/* Banner período anterior */}
        {report?.yoy && (
          <div className="bg-violet-50 border border-violet-200 rounded-lg px-3 py-2 text-xs text-violet-800 flex items-center gap-2">
            <TrendingUp className="w-3.5 h-3.5" />
            <span>
              Comparando com período anterior: <strong>{new Date(report.yoy.periodoAnterior.from + 'T12:00:00').toLocaleDateString('pt-BR')}</strong> a <strong>{new Date(report.yoy.periodoAnterior.to + 'T12:00:00').toLocaleDateString('pt-BR')}</strong>
            </span>
          </div>
        )}

        {/* ─── GRÁFICO POR DIA ─────────────────────────────────────────── */}
        {report && report.byDay.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-black uppercase tracking-wider text-violet-700 flex items-center gap-1.5">
                <Calendar className="w-4 h-4" /> Vendas por dia
              </div>
              <div className="flex items-center gap-3 text-[10px]">
                {report.yoy && (
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1">
                      <span className="w-3 h-3 rounded bg-gradient-to-t from-violet-600 to-fuchsia-500" /> Atual
                    </span>
                    <span className="flex items-center gap-1 text-slate-500">
                      <span className="w-3 h-3 rounded bg-slate-300" /> Ano anterior
                    </span>
                  </div>
                )}
                <span className="text-slate-500">
                  {report.periodo.dias} dia{report.periodo.dias > 1 ? 's' : ''}
                </span>
              </div>
            </div>
            <div className="overflow-x-auto pb-2">
              <div className="flex items-end gap-1 min-h-[180px]" style={{ minWidth: `${report.byDay.length * (report.yoy ? 36 : 28)}px` }}>
                {report.byDay.map((d) => {
                  const h = maxByDay > 0 ? Math.max(2, (d.valor / maxByDay) * 150) : 0;
                  // Busca o mesmo MM-DD no ano anterior
                  const prev = report.yoy ? prevByMMDD.get(d.date.slice(5)) : null;
                  const hPrev = prev && maxByDay > 0 ? Math.max(2, (prev.valor / maxByDay) * 150) : 0;
                  const dt = new Date(d.date + 'T12:00:00');
                  return (
                    <div key={d.date} className="flex flex-col items-center gap-1 group" style={{ width: report.yoy ? '32px' : '24px' }}>
                      <div className="text-[9px] font-bold text-slate-700 tabular-nums opacity-0 group-hover:opacity-100 transition whitespace-nowrap">
                        R$ {Math.round(d.valor).toLocaleString('pt-BR')}
                      </div>
                      {/* Barras lado a lado: atual + anterior */}
                      <div className="flex items-end gap-0.5 w-full" style={{ height: '150px' }}>
                        <div
                          className="flex-1 bg-gradient-to-t from-violet-600 to-fuchsia-500 rounded-t hover:from-violet-700 transition cursor-default"
                          style={{ height: `${h}px`, alignSelf: 'flex-end' }}
                          title={`${d.date}: R$ ${brl(d.valor)} · ${d.pecas} peças`}
                        />
                        {report.yoy && (
                          <div
                            className="flex-1 bg-slate-300 hover:bg-slate-400 rounded-t transition cursor-default"
                            style={{ height: `${hPrev}px`, alignSelf: 'flex-end' }}
                            title={prev ? `Ano anterior (${prev.date}): R$ ${brl(prev.valor)} · ${prev.pecas} peças` : 'Sem dados ano anterior'}
                          />
                        )}
                      </div>
                      <div className="text-[8px] text-slate-400 tabular-nums" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                        {dt.getDate()}/{dt.getMonth() + 1}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ─── TABELAS ─────────────────────────────────────────────────── */}
        {report && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

            {/* TOP LOJAS */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                <Store className="w-4 h-4 text-violet-700" />
                <h2 className="text-xs font-black uppercase tracking-wider text-violet-700">Top Lojas</h2>
                <span className="text-[10px] text-slate-400 ml-auto">{report.byStore.length} loja{report.byStore.length === 1 ? '' : 's'}</span>
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-100">
                  <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                    <th className="text-left px-3 py-2">Loja</th>
                    <th className="text-right px-3 py-2">Peças</th>
                    <th className="text-right px-3 py-2">Valor</th>
                    <th className="text-right px-3 py-2">Tk médio</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.byStore.map((s) => (
                    <tr key={s.code} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-bold text-slate-800">
                        <span className="font-mono text-violet-700 mr-1.5">{s.code}</span>
                        {s.name}
                        {s.code === '13' && (
                          <span className="ml-1.5 text-[9px] bg-fuchsia-100 text-fuchsia-700 px-1.5 py-0.5 rounded font-bold">SITE</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.pecas.toLocaleString('pt-BR')}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-bold text-emerald-700">R$ {brl(s.valor)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">R$ {brl(s.ticketMedio)}</td>
                    </tr>
                  ))}
                  {report.byStore.length === 0 && (
                    <tr><td colSpan={4} className="text-center text-slate-400 py-8 text-xs">Nenhuma venda no período</td></tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>

            {/* TOP VENDEDORAS — com comissão */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                <Users className="w-4 h-4 text-violet-700" />
                <h2 className="text-xs font-black uppercase tracking-wider text-violet-700">Top Vendedoras</h2>
                <span className="text-[10px] text-slate-400 ml-auto">comissão {comissaoPct}%</span>
              </div>
              <div className="max-h-[420px] overflow-y-auto">
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-100 sticky top-0">
                    <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                      <th className="text-left px-3 py-2">Vendedora</th>
                      <th className="text-right px-3 py-2">Vendas</th>
                      <th className="text-right px-3 py-2">Valor</th>
                      <th className="text-right px-3 py-2 text-emerald-600">Comissão</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.topVendedoras.map((v, i) => (
                      <tr key={v.codigo + i} className="hover:bg-slate-50">
                        <td className="px-3 py-2">
                          <div className="font-bold text-slate-800 truncate max-w-[200px]" title={v.nome}>
                            {v.nome || `Cód ${v.codigo}`}
                          </div>
                          {v.nome && <div className="text-[10px] text-slate-400 font-mono">cód {v.codigo}</div>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{v.vendas}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-700">R$ {brl(v.valor)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-bold text-emerald-700">R$ {brl(v.comissao)}</td>
                      </tr>
                    ))}
                    {report.topVendedoras.length === 0 && (
                      <tr><td colSpan={4} className="text-center text-slate-400 py-8 text-xs">Sem dados de vendedora no período<br /><span className="text-[10px]">(coluna VENDEDOR não detectada na caixa do Giga)</span></td></tr>
                    )}
                  </tbody>
                </table>
                </div>
              </div>
            </div>

            {/* TOP MARCAS */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                <Tag className="w-4 h-4 text-violet-700" />
                <h2 className="text-xs font-black uppercase tracking-wider text-violet-700">Top Marcas</h2>
              </div>
              <div className="max-h-[360px] overflow-y-auto">
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-100 sticky top-0">
                    <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                      <th className="text-left px-3 py-2">Marca</th>
                      <th className="text-right px-3 py-2">Peças</th>
                      <th className="text-right px-3 py-2">Valor</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.topMarcas.map((m, i) => (
                      <tr key={m.marca + i} className="hover:bg-slate-50">
                        <td className="px-3 py-2 font-bold text-slate-800">{m.marca}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{m.pecas.toLocaleString('pt-BR')}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-bold text-emerald-700">R$ {brl(m.valor)}</td>
                      </tr>
                    ))}
                    {report.topMarcas.length === 0 && (
                      <tr><td colSpan={3} className="text-center text-slate-400 py-8 text-xs">Sem dados de marca<br /><span className="text-[10px]">(coluna MARCA não detectada em produtos)</span></td></tr>
                    )}
                  </tbody>
                </table>
                </div>
              </div>
            </div>

            {/* TOP PRODUTOS */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                <Package className="w-4 h-4 text-violet-700" />
                <h2 className="text-xs font-black uppercase tracking-wider text-violet-700">Top Produtos</h2>
              </div>
              <div className="max-h-[360px] overflow-y-auto">
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-100 sticky top-0">
                    <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                      <th className="text-left px-3 py-2">REF</th>
                      <th className="text-left px-3 py-2">Descrição</th>
                      <th className="text-right px-3 py-2">Peças</th>
                      <th className="text-right px-3 py-2">Valor</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.topProdutos.map((p, i) => (
                      <tr key={p.refCode + i} className="hover:bg-slate-50">
                        <td className="px-3 py-2 font-mono text-xs font-bold text-violet-700">{p.refCode}</td>
                        <td className="px-3 py-2 text-xs text-slate-700 truncate max-w-[200px]" title={p.descricao || ''}>{p.descricao || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs">{p.pecas}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-bold text-emerald-700 text-xs">R$ {brl(p.valor)}</td>
                      </tr>
                    ))}
                    {report.topProdutos.length === 0 && (
                      <tr><td colSpan={4} className="text-center text-slate-400 py-8 text-xs">Sem produtos vendidos no período</td></tr>
                    )}
                  </tbody>
                </table>
                </div>
              </div>
            </div>

          </div>
        )}

        {!report && !loading && !error && (
          <div className="text-center py-20 text-slate-400">
            <BarChart3 className="w-12 h-12 mx-auto mb-2 opacity-50" />
            <p className="text-sm">Configure os filtros e clique em <strong>Gerar</strong></p>
          </div>
        )}

        {loading && !report && (
          <div className="text-center py-20 text-slate-400">
            <Loader2 className="w-8 h-8 animate-spin mx-auto" />
            <p className="text-xs mt-2">Carregando relatório…</p>
          </div>
        )}

      </div>
    </div>
  );
}

// ─── KPI CARD ────────────────────────────────────────────────────────
function Kpi({
  label, value, icon: Icon, color, prevValue, variacao,
}: {
  label: string; value: string;
  icon: any;
  color: 'emerald' | 'violet' | 'sky' | 'amber';
  prevValue?: string;
  variacao?: number | null;
}) {
  const colorMap: Record<string, { bg: string; text: string; iconBg: string }> = {
    emerald: { bg: 'border-emerald-200', text: 'text-emerald-700', iconBg: 'bg-emerald-100 text-emerald-600' },
    violet: { bg: 'border-violet-200', text: 'text-violet-700', iconBg: 'bg-violet-100 text-violet-600' },
    sky: { bg: 'border-sky-200', text: 'text-sky-700', iconBg: 'bg-sky-100 text-sky-600' },
    amber: { bg: 'border-amber-200', text: 'text-amber-700', iconBg: 'bg-amber-100 text-amber-600' },
  };
  const c = colorMap[color];
  // Cor da variação: verde se positiva, rosa se negativa, cinza se zero/null
  const isPositive = variacao !== undefined && variacao !== null && variacao > 0;
  const isNegative = variacao !== undefined && variacao !== null && variacao < 0;
  const variationCls = isPositive
    ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
    : isNegative
    ? 'text-rose-700 bg-rose-50 border-rose-200'
    : 'text-slate-500 bg-slate-50 border-slate-200';
  return (
    <div className={`bg-white rounded-xl border ${c.bg} shadow-sm p-3 flex items-start gap-3`}>
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${c.iconBg}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
        <div className={`text-lg sm:text-xl font-black tabular-nums ${c.text} truncate`}>{value}</div>
        {prevValue !== undefined && (
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {variacao !== undefined && variacao !== null && (
              <span className={`text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded border ${variationCls}`}>
                {variacao > 0 ? '+' : ''}{variacao.toFixed(1)}%
              </span>
            )}
            {variacao === null && (
              <span className="text-[10px] font-bold text-violet-700 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded">novo</span>
            )}
            <span className="text-[10px] text-slate-400 truncate">vs {prevValue}</span>
          </div>
        )}
      </div>
    </div>
  );
}
