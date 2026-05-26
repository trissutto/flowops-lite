'use client';

/**
 * /retaguarda/faturamento
 *
 * Tela sintética de faturamento por loja com:
 *  - Filtro de data (from/to)
 *  - Toggle granularidade (Dia/Semana/Mês)
 *  - Card TOTAL REDE com comparação % vs mesmo período ano anterior
 *  - Gráfico de linhas (Recharts) — atual vs ano anterior
 *  - Cards por loja (faturamento, cupons, ticket médio, peças, variação %)
 *  - SITE composta: Giga + Flowops (breakdown visível)
 *
 * Fonte: tabela `caixa` do Giga (MySQL) + Order do flowops (status=completed)
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, RefreshCw, TrendingUp, TrendingDown, Calendar,
  DollarSign, ShoppingBag, Receipt, Package, Loader2,
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import { api } from '@/lib/api';

type Granularity = 'day' | 'week' | 'month';

type Resumo = {
  from: string;
  to: string;
  granularity: Granularity;
  periodoAnterior: { from: string; to: string };
  totalRede: {
    atual: number;
    anterior: number;
    variacaoPct: number;
    cupons: number;
    pecas: number;
    ticketMedio: number;
  };
  lojas: Array<{
    storeCode: string;
    storeName: string;
    atual: {
      faturamento: number;
      cupons: number;
      pecas: number;
      ticketMedio: number;
      breakdown?: {
        giga: { faturamento: number; cupons: number };
        flowops: { faturamento: number; cupons: number };
      } | null;
    };
    anterior: { faturamento: number; cupons: number; pecas: number; ticketMedio: number };
    variacaoPct: number;
  }>;
  series: Array<{ bucket: string; atual: number; anterior: number }>;
  cached: boolean;
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const brlCompact = (n: number) => {
  if (Math.abs(n) >= 1_000_000) return `R$ ${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `R$ ${(n / 1_000).toFixed(1)}k`;
  return brl(n);
};

const fmtDate = (iso: string) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const firstOfMonthIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

export default function FaturamentoPage() {
  const router = useRouter();
  const [from, setFrom] = useState(firstOfMonthIso());
  const [to, setTo] = useState(todayIso());
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [data, setData] = useState<Resumo | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) router.push('/login');
  }, [router]);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const qs = new URLSearchParams({ from, to, granularity });
      const r = await api<Resumo>(`/faturamento/resumo?${qs.toString()}`);
      setData(r);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao carregar faturamento');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Formata bucket pro eixo X do gráfico
  const chartData = useMemo(() => {
    if (!data?.series) return [];
    return data.series.map((s) => {
      let label = s.bucket;
      if (granularity === 'day') {
        const [y, m, d] = s.bucket.split('-');
        if (y && m && d) label = `${d}/${m}`;
      } else if (granularity === 'month') {
        const [y, m] = s.bucket.split('-');
        if (y && m) label = `${m}/${y.slice(-2)}`;
      } else if (granularity === 'week') {
        // formato '2026-W21'
        const m = s.bucket.match(/W(\d+)/);
        if (m) label = `Sem ${m[1]}`;
      }
      return { ...s, label };
    });
  }, [data, granularity]);

  const variacaoIcon = (pct: number) =>
    pct >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />;
  const variacaoColor = (pct: number) =>
    pct > 0 ? 'text-emerald-700 bg-emerald-100'
    : pct < 0 ? 'text-rose-700 bg-rose-100'
    : 'text-slate-600 bg-slate-100';

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="p-2 rounded hover:bg-slate-100" title="Voltar">
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </Link>
          <DollarSign className="w-6 h-6 text-emerald-600" />
          <div className="flex-1">
            <h1 className="text-lg font-black text-slate-800">Faturamento por Loja</h1>
            <p className="text-xs text-slate-500">
              Vendas Giga + Site Flowops · comparação com ano anterior
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-md text-sm font-bold"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Atualizar
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 space-y-4">
        {/* Filtros */}
        <div className="bg-white border border-slate-200 rounded-lg p-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="text-[11px] font-bold uppercase text-slate-600 tracking-wider">De</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="block mt-0.5 px-3 py-1.5 border border-slate-300 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="text-[11px] font-bold uppercase text-slate-600 tracking-wider">Até</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="block mt-0.5 px-3 py-1.5 border border-slate-300 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="text-[11px] font-bold uppercase text-slate-600 tracking-wider">Granularidade</label>
            <div className="flex gap-0.5 mt-0.5 bg-slate-100 p-0.5 rounded-md">
              {(['day', 'week', 'month'] as Granularity[]).map((g) => (
                <button
                  key={g}
                  onClick={() => setGranularity(g)}
                  className={`px-3 py-1 text-xs font-bold rounded ${
                    granularity === g ? 'bg-white text-emerald-700 shadow' : 'text-slate-600'
                  }`}
                >
                  {g === 'day' ? 'Dia' : g === 'week' ? 'Semana' : 'Mês'}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={load}
            className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-sm font-bold"
          >
            Aplicar
          </button>
          {data?.periodoAnterior && (
            <div className="text-xs text-slate-500 ml-auto flex items-center gap-1">
              <Calendar className="w-3 h-3" />
              Comparando com {fmtDate(data.periodoAnterior.from)} – {fmtDate(data.periodoAnterior.to)}
            </div>
          )}
        </div>

        {err && (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-lg p-3 text-sm">
            ❌ {err}
          </div>
        )}

        {/* TOTAL REDE */}
        {data && (
          <div className="bg-gradient-to-br from-emerald-600 to-teal-600 text-white rounded-xl shadow-lg p-5">
            <div className="text-xs uppercase font-bold tracking-widest opacity-90">Total da Rede</div>
            <div className="flex items-baseline gap-4 mt-1 flex-wrap">
              <div className="text-4xl sm:text-5xl font-black tabular-nums">
                {brl(data.totalRede.atual)}
              </div>
              <span
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-sm font-bold ${
                  data.totalRede.variacaoPct >= 0 ? 'bg-emerald-900/30' : 'bg-rose-700/30'
                }`}
              >
                {variacaoIcon(data.totalRede.variacaoPct)}
                {data.totalRede.variacaoPct >= 0 ? '+' : ''}
                {data.totalRede.variacaoPct.toFixed(1)}%
              </span>
            </div>
            <div className="text-sm opacity-90 mt-1">
              Ano anterior (mesmo período): <b>{brl(data.totalRede.anterior)}</b>
            </div>
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
              <div className="bg-white/10 rounded-lg px-3 py-2">
                <div className="text-[10px] uppercase opacity-80 flex items-center gap-1">
                  <Receipt className="w-3 h-3" /> Cupons
                </div>
                <div className="font-bold text-lg">{data.totalRede.cupons.toLocaleString('pt-BR')}</div>
              </div>
              <div className="bg-white/10 rounded-lg px-3 py-2">
                <div className="text-[10px] uppercase opacity-80 flex items-center gap-1">
                  <ShoppingBag className="w-3 h-3" /> Ticket médio
                </div>
                <div className="font-bold text-lg">{brl(data.totalRede.ticketMedio)}</div>
              </div>
              <div className="bg-white/10 rounded-lg px-3 py-2">
                <div className="text-[10px] uppercase opacity-80 flex items-center gap-1">
                  <Package className="w-3 h-3" /> Peças
                </div>
                <div className="font-bold text-lg">{data.totalRede.pecas.toLocaleString('pt-BR')}</div>
              </div>
            </div>
          </div>
        )}

        {/* GRÁFICO */}
        {data && data.series.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="text-sm font-bold text-slate-700 mb-3">
              📈 Faturamento por {granularity === 'day' ? 'dia' : granularity === 'week' ? 'semana' : 'mês'}
            </div>
            <div style={{ width: '100%', height: 340 }}>
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={brlCompact} tick={{ fontSize: 11 }} />
                  <Tooltip
                    formatter={(v: number) => brl(v)}
                    labelStyle={{ color: '#475569', fontWeight: 'bold' }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="atual"
                    name="Período atual"
                    stroke="#059669"
                    strokeWidth={2.5}
                    dot={{ r: 3 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="anterior"
                    name="Ano anterior"
                    stroke="#94a3b8"
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={{ r: 2 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* CARDS POR LOJA */}
        {data && data.lojas.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-bold text-slate-700">
              🏪 Por loja ({data.lojas.length})
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {data.lojas.map((l) => (
                <div
                  key={l.storeCode}
                  className={`rounded-xl p-3 border ${
                    l.storeCode === 'SITE'
                      ? 'bg-violet-50 border-violet-200'
                      : 'bg-white border-slate-200'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-mono font-bold text-slate-400">{l.storeCode}</span>
                      <span className="font-bold text-slate-800 text-sm truncate">{l.storeName}</span>
                    </div>
                    <span
                      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold ${variacaoColor(l.variacaoPct)}`}
                    >
                      {variacaoIcon(l.variacaoPct)}
                      {l.variacaoPct >= 0 ? '+' : ''}
                      {l.variacaoPct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="text-2xl font-black text-slate-900 tabular-nums">
                    {brl(l.atual.faturamento)}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    Ano ant.: {brl(l.anterior.faturamento)}
                  </div>

                  {/* Breakdown SITE: Giga + Flowops */}
                  {l.atual.breakdown && (
                    <div className="mt-2 bg-white border border-violet-200 rounded-md p-2 text-[11px] space-y-0.5">
                      <div className="flex justify-between">
                        <span className="text-slate-600">📦 Flowops (WC)</span>
                        <span className="font-bold text-violet-800">{brl(l.atual.breakdown.flowops.faturamento)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-600">🗄 Giga (legacy)</span>
                        <span className="font-bold text-violet-800">{brl(l.atual.breakdown.giga.faturamento)}</span>
                      </div>
                    </div>
                  )}

                  {/* Métricas */}
                  <div className="mt-2 grid grid-cols-3 gap-1 text-center">
                    <div>
                      <div className="text-[9px] uppercase text-slate-400 font-bold">Cupons</div>
                      <div className="text-sm font-bold text-slate-700">{l.atual.cupons}</div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase text-slate-400 font-bold">Tkt médio</div>
                      <div className="text-sm font-bold text-slate-700">{brlCompact(l.atual.ticketMedio)}</div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase text-slate-400 font-bold">Peças</div>
                      <div className="text-sm font-bold text-slate-700">{l.atual.pecas}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty / loading */}
        {!data && loading && (
          <div className="text-center py-16 text-slate-500">
            <Loader2 className="w-8 h-8 animate-spin mx-auto" />
            <div className="text-sm mt-2">Carregando…</div>
          </div>
        )}

        {data && data.cached && (
          <div className="text-[10px] text-slate-400 text-right">
            (cache 5 min — clique Atualizar pra forçar)
          </div>
        )}
      </main>
    </div>
  );
}
