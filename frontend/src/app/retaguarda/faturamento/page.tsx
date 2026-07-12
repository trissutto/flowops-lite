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

import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
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
    metaMes?: number;
  };
  metaMesPeriodo?: { from: string; to: string };
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
        live?: { faturamento: number; cupons: number };
      } | null;
    };
    anterior: { faturamento: number; cupons: number; pecas: number; ticketMedio: number };
    variacaoPct: number;
    metaMes?: number;
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

// Valida data do filtro ANTES de buscar. O input date dispara onChange com
// ano PARCIAL enquanto digita ("0002-07-01") — isso já mandou uma consulta
// de 1902→hoje pro Giga (base inteira na tela + pool MySQL sofrendo).
const isValidPeriodDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return false;
  const y = Number(m[1]);
  return y >= 2000 && y <= 2100;
};

export default function FaturamentoPage() {
  const router = useRouter();
  const [from, setFrom] = useState(firstOfMonthIso());
  const [to, setTo] = useState(todayIso());
  const [granularity] = useState<Granularity>('day'); // fixo em "dia" — toggle removido
  const [data, setData] = useState<Resumo | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Drill-down: storeCode expandida + vendas detalhadas em cache
  const [expandedStore, setExpandedStore] = useState<string | null>(null);
  // Separação do card SITE (clique): Site efetivo · Venda online WhatsApp · Live
  const [breakdownOpen, setBreakdownOpen] = useState<Record<string, boolean>>({});
  const [storeVendas, setStoreVendas] = useState<Record<string, any[]>>({});
  const [storeMeta, setStoreMeta] = useState<Record<string, { source?: string; sourceWarning?: string; zumbisOcultas?: number }>>({});
  const [loadingVendas, setLoadingVendas] = useState<string | null>(null);
  // Modal de estorno: venda alvo + estado
  const [estornoTarget, setEstornoTarget] = useState<any | null>(null);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) router.push('/login');
  }, [router]);

  // Sequência de requests — a resposta de um load ANTIGO (ex: a consulta
  // gigante de um ano digitado pela metade) chegava DEPOIS e sobrescrevia a
  // certa. Só a resposta do último load() aplica.
  const loadSeqRef = useRef(0);

  const load = async (
    forceRefresh = false,
    override?: { from?: string; to?: string },
  ) => {
    const useFrom = override?.from ?? from;
    const useTo = override?.to ?? to;
    // NUNCA busca com data inválida/parcial — era isso que varria o Giga
    // de 1902 até hoje quando se digitava o ano no campo.
    if (!isValidPeriodDate(useFrom) || !isValidPeriodDate(useTo)) {
      setErr('Período inválido — confira as datas De/Até (ano com 4 dígitos).');
      return;
    }
    if (useFrom > useTo) {
      setErr('A data "De" está depois da data "Até".');
      return;
    }
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setErr(null);
    // Limpa cache de drill-down — qualquer mudança no resumo invalida detalhes
    setStoreVendas({});
    setStoreMeta({});
    try {
      const qs = new URLSearchParams({ from: useFrom, to: useTo, granularity });
      if (forceRefresh) qs.set('refresh', '1');
      const r = await api<Resumo>(`/faturamento/resumo?${qs.toString()}`);
      if (seq !== loadSeqRef.current) return; // resposta velha — descarta
      setData(r);
      // Loja expandida: recarrega o drill-down já com o período aplicado
      if (expandedStore) {
        const sc = expandedStore;
        setLoadingVendas(sc);
        try {
          const rv = await api<{ vendas: any[]; source?: string; sourceWarning?: string }>(
            `/faturamento/loja/${encodeURIComponent(sc)}/vendas?from=${useFrom}&to=${useTo}`,
          );
          if (seq === loadSeqRef.current) {
            setStoreVendas((prev) => ({ ...prev, [sc]: rv.vendas || [] }));
            setStoreMeta((prev) => ({ ...prev, [sc]: { source: rv.source, sourceWarning: rv.sourceWarning, zumbisOcultas: (rv as any).zumbisOcultas } }));
          }
        } catch {}
        setLoadingVendas(null);
      }
    } catch (e: any) {
      if (seq !== loadSeqRef.current) return;
      setErr(e?.message || 'Falha ao carregar faturamento');
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  };

  // Carrega vendas detalhadas de uma loja (drill-down) — com cache local
  // Guarda também source ('pdv_sale' | 'wincred_caixa') e sourceWarning
  const toggleStore = async (storeCode: string) => {
    if (expandedStore === storeCode) {
      setExpandedStore(null);
      return;
    }
    setExpandedStore(storeCode);
    // Se já tem cache, não recarrega
    if (storeVendas[storeCode]) return;
    setLoadingVendas(storeCode);
    try {
      const r = await api<{ vendas: any[]; source?: string; sourceWarning?: string; zumbisOcultas?: number }>(
        `/faturamento/loja/${encodeURIComponent(storeCode)}/vendas?from=${from}&to=${to}`,
      );
      setStoreVendas((prev) => ({ ...prev, [storeCode]: r.vendas || [] }));
      setStoreMeta((prev) => ({ ...prev, [storeCode]: { source: r.source, sourceWarning: r.sourceWarning, zumbisOcultas: r.zumbisOcultas } }));
    } catch (e: any) {
      setErr(e?.message || 'Falha ao carregar vendas detalhadas');
    } finally {
      setLoadingVendas(null);
    }
  };

  // Após estornar, recarrega vendas da loja + invalida cache + recarrega resumo
  const onEstornoConcluido = async (storeCode: string) => {
    setStoreVendas((prev) => {
      const copy = { ...prev };
      delete copy[storeCode];
      return copy;
    });
    if (expandedStore === storeCode) {
      // Recarrega vendas
      setLoadingVendas(storeCode);
      try {
        const r = await api<{ vendas: any[] }>(
          `/faturamento/loja/${encodeURIComponent(storeCode)}/vendas?from=${from}&to=${to}`,
        );
        setStoreVendas((prev) => ({ ...prev, [storeCode]: r.vendas || [] }));
      } catch {}
      setLoadingVendas(null);
    }
    load(true); // FORÇA refresh — limpa cache pra estorno aparecer na hora
  };

  // Carrega SÓ no mount. As datas digitadas NÃO disparam busca sozinhas —
  // o input date emite onChange com ano parcial ("0002-...") enquanto digita,
  // e isso mandava uma consulta de 1902→hoje pro Giga a cada tecla (incidente
  // 03/07: R$ 169mi na tela). Buscar = botão Aplicar ou atalhos.
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
            onClick={() => load()}
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
          <button
            onClick={() => load()}
            className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-sm font-bold"
          >
            Aplicar
          </button>

          {/* Atalhos rápidos — disparam load() na hora, sem precisar clicar Aplicar */}
          <div className="flex gap-1">
            <button
              onClick={() => {
                const t = todayIso();
                setFrom(t); setTo(t);
                load(false, { from: t, to: t });
              }}
              className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md text-xs font-bold"
              title="Hoje"
            >
              Hoje
            </button>
            <button
              onClick={() => {
                const d = new Date();
                d.setDate(d.getDate() - 1);
                const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                setFrom(iso); setTo(iso);
                load(false, { from: iso, to: iso });
              }}
              className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md text-xs font-bold"
              title="Ontem"
            >
              Ontem
            </button>
            <button
              onClick={() => {
                const d = new Date();
                d.setDate(d.getDate() - 7);
                const fromIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                const toIso = todayIso();
                setFrom(fromIso); setTo(toIso);
                load(false, { from: fromIso, to: toIso });
              }}
              className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md text-xs font-bold"
              title="Últimos 7 dias"
            >
              7 dias
            </button>
            <button
              onClick={() => {
                const fromIso = firstOfMonthIso();
                const toIso = todayIso();
                setFrom(fromIso); setTo(toIso);
                load(false, { from: fromIso, to: toIso });
              }}
              className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md text-xs font-bold"
              title="Mês atual"
            >
              Mês
            </button>
          </div>

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
                    formatter={(v: any) => brl(Number(v) || 0)}
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

        {/* TABELA RANKING 2026 vs 2025 */}
        {data && data.lojas.length > 0 && (() => {
          const maxFat = Math.max(...data.lojas.map((l) => Math.max(l.atual.faturamento, l.anterior.faturamento, 1)));
          return (
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                <div className="text-sm font-bold text-slate-700">
                  📊 Ranking de Lojas — {data.from.split('-').reverse().join('/').slice(0, 5)} vs ano anterior
                </div>
                <div className="text-[11px] text-slate-500">Ordenado por faturamento atual</div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                    <tr>
                      <th className="px-3 py-2 text-left w-10">#</th>
                      <th className="px-3 py-2 text-left">Loja</th>
                      <th className="px-3 py-2 text-right">2026</th>
                      <th className="px-3 py-2 text-right">2025</th>
                      <th className="px-3 py-2 text-right w-24">Δ R$</th>
                      <th className="px-3 py-2 text-right w-20">Δ%</th>
                      <th className="px-3 py-2 text-right w-32" title="Faturamento do mês inteiro do ano passado vs realizado">Falta Meta</th>
                      <th className="px-3 py-2 text-left w-1/4">Visual</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.lojas.map((l, idx) => {
                      const pct2026 = (l.atual.faturamento / maxFat) * 100;
                      const pct2025 = (l.anterior.faturamento / maxFat) * 100;
                      const variacao = l.variacaoPct;
                      const varColor = variacao > 0 ? 'text-emerald-700' : variacao < 0 ? 'text-rose-700' : 'text-slate-500';
                      const varBg = variacao > 0 ? 'bg-emerald-50' : variacao < 0 ? 'bg-rose-50' : 'bg-slate-50';
                      const isExpanded = expandedStore === l.storeCode;
                      const vendasDessaLoja = storeVendas[l.storeCode];
                      const isLoadingExp = loadingVendas === l.storeCode;
                      return (
                        <React.Fragment key={l.storeCode}>
                          <tr
                            className={`hover:bg-blue-50 transition cursor-pointer ${isExpanded ? 'bg-blue-50 border-l-4 border-blue-500' : ''}`}
                            onClick={() => toggleStore(l.storeCode)}
                          >
                            <td className="px-3 py-2 text-slate-400 font-mono font-bold text-xs">
                              <div className="flex items-center gap-1">
                                <span className={`text-slate-500 transition ${isExpanded ? 'rotate-90' : ''}`}>▸</span>
                                {String(idx + 1).padStart(2, '0')}
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-mono text-slate-400">{l.storeCode}</span>
                                <span className="font-bold text-slate-800">{l.storeName}</span>
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right font-bold text-slate-900 tabular-nums">
                              {brl(l.atual.faturamento)}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-500 tabular-nums">
                              {brl(l.anterior.faturamento)}
                            </td>
                            {/* Δ R$ — diferença absoluta atual - ano anterior */}
                            {(() => {
                              const deltaRs = l.atual.faturamento - l.anterior.faturamento;
                              const dColor = deltaRs > 0 ? 'text-emerald-700' : deltaRs < 0 ? 'text-rose-700' : 'text-slate-500';
                              const dBg = deltaRs > 0 ? 'bg-emerald-50' : deltaRs < 0 ? 'bg-rose-50' : 'bg-slate-50';
                              return (
                                <td className={`px-3 py-2 text-right font-bold tabular-nums ${dColor}`}>
                                  <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded ${dBg}`}>
                                    {deltaRs > 0 ? '+' : ''}{brl(deltaRs)}
                                  </span>
                                </td>
                              );
                            })()}
                            <td className={`px-3 py-2 text-right font-bold tabular-nums ${varColor}`}>
                              <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded ${varBg}`}>
                                {variacao > 0 ? '▲' : variacao < 0 ? '▼' : '='}
                                {variacao >= 0 ? '+' : ''}{variacao.toFixed(1)}%
                              </span>
                            </td>
                            {/* Falta Meta — meta = mês inteiro ano anterior */}
                            {(() => {
                              const meta = Number(l.metaMes || 0);
                              const falta = meta - l.atual.faturamento;
                              if (meta <= 0) {
                                return <td className="px-3 py-2 text-right text-slate-300 text-xs italic">—</td>;
                              }
                              const bateu = falta <= 0;
                              const pctAtingido = Math.min(100, (l.atual.faturamento / meta) * 100);
                              return (
                                <td className="px-3 py-2 text-right tabular-nums">
                                  <div className="flex flex-col items-end gap-0.5">
                                    <span className={`text-xs font-bold ${bateu ? 'text-emerald-700' : 'text-amber-700'}`}>
                                      {bateu ? `✓ +${brl(Math.abs(falta))}` : `falta ${brl(falta)}`}
                                    </span>
                                    <div className="w-20 bg-slate-100 rounded-sm h-1 overflow-hidden">
                                      <div
                                        className={`h-full rounded-sm ${bateu ? 'bg-emerald-500' : 'bg-amber-500'}`}
                                        style={{ width: `${pctAtingido}%` }}
                                      />
                                    </div>
                                    <span className="text-[9px] text-slate-400">meta {brl(meta)}</span>
                                  </div>
                                </td>
                              );
                            })()}
                            <td className="px-3 py-2">
                              <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 bg-slate-100 rounded-sm h-3 overflow-hidden">
                                    <div
                                      className="h-full bg-emerald-500 rounded-sm transition-all"
                                      style={{ width: `${pct2026}%` }}
                                    />
                                  </div>
                                  <span className="text-[9px] font-bold text-emerald-700 w-8 text-right">26</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 bg-slate-100 rounded-sm h-2 overflow-hidden">
                                    <div
                                      className="h-full bg-slate-400 rounded-sm transition-all"
                                      style={{ width: `${pct2025}%` }}
                                    />
                                  </div>
                                  <span className="text-[9px] font-bold text-slate-500 w-8 text-right">25</span>
                                </div>
                              </div>
                            </td>
                          </tr>
                          {/* ─── DRILL-DOWN ─── */}
                          {isExpanded && (
                            <tr>
                              <td colSpan={8} className="p-0 bg-slate-50 border-l-4 border-blue-500">
                                <div className="p-3">
                                  {isLoadingExp ? (
                                    <div className="text-center text-slate-500 py-4 text-sm">
                                      Carregando vendas de {l.storeName}…
                                    </div>
                                  ) : !vendasDessaLoja || vendasDessaLoja.length === 0 ? (
                                    <div className="text-center text-slate-400 py-4 text-sm italic">
                                      Nenhuma venda no período pra essa loja.
                                    </div>
                                  ) : (
                                    <>
                                      {storeMeta[l.storeCode]?.sourceWarning && (
                                        <div className="mb-2 px-3 py-2 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-900 flex items-start gap-2">
                                          <span>⚠️</span>
                                          <span>{storeMeta[l.storeCode]?.sourceWarning}</span>
                                        </div>
                                      )}
                                      <DrilldownVendas
                                        storeName={l.storeName}
                                        storeCode={l.storeCode}
                                        vendas={vendasDessaLoja}
                                        onEstornar={(v) => setEstornoTarget({ ...v, storeCode: l.storeCode, storeName: l.storeName })}
                                        periodLabel={from === to ? from : `${from} → ${to}`}
                                        zumbisOcultas={storeMeta[l.storeCode]?.zumbisOcultas}
                                      />
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-slate-100 text-sm font-bold border-t-2 border-slate-200">
                    <tr>
                      <td className="px-3 py-2"></td>
                      <td className="px-3 py-2 text-slate-700">TOTAL REDE</td>
                      <td className="px-3 py-2 text-right text-emerald-700 tabular-nums">
                        {brl(data.totalRede.atual)}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-600 tabular-nums">
                        {brl(data.totalRede.anterior)}
                      </td>
                      {/* TOTAL Δ R$ */}
                      {(() => {
                        const deltaTot = data.totalRede.atual - data.totalRede.anterior;
                        const cor = deltaTot > 0 ? 'text-emerald-700' : deltaTot < 0 ? 'text-rose-700' : 'text-slate-500';
                        return (
                          <td className={`px-3 py-2 text-right tabular-nums ${cor}`}>
                            {deltaTot > 0 ? '+' : ''}{brl(deltaTot)}
                          </td>
                        );
                      })()}
                      <td className={`px-3 py-2 text-right tabular-nums ${data.totalRede.variacaoPct >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {data.totalRede.variacaoPct >= 0 ? '+' : ''}{data.totalRede.variacaoPct.toFixed(1)}%
                      </td>
                      {/* TOTAL Falta Meta */}
                      {(() => {
                        const meta = Number(data.totalRede.metaMes || 0);
                        if (meta <= 0) return <td className="px-3 py-2 text-right text-slate-300 italic">—</td>;
                        const falta = meta - data.totalRede.atual;
                        const bateu = falta <= 0;
                        const pct = Math.min(100, (data.totalRede.atual / meta) * 100);
                        return (
                          <td className="px-3 py-2 text-right tabular-nums">
                            <div className="flex flex-col items-end gap-0.5">
                              <span className={`text-xs font-extrabold ${bateu ? 'text-emerald-700' : 'text-amber-700'}`}>
                                {bateu ? `✓ +${brl(Math.abs(falta))}` : `falta ${brl(falta)}`}
                              </span>
                              <div className="w-24 bg-slate-200 rounded-sm h-1.5 overflow-hidden">
                                <div
                                  className={`h-full rounded-sm ${bateu ? 'bg-emerald-500' : 'bg-amber-500'}`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="text-[9px] text-slate-500">{pct.toFixed(0)}% de {brl(meta)}</span>
                            </div>
                          </td>
                        );
                      })()}
                      <td className="px-3 py-2"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          );
        })()}

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
                  onClick={() => {
                    if (l.atual.breakdown) {
                      setBreakdownOpen((s) => ({ ...s, [l.storeCode]: !s[l.storeCode] }));
                    }
                  }}
                  className={`rounded-xl p-3 border ${
                    l.atual.breakdown ? 'cursor-pointer hover:ring-2 hover:ring-violet-300' : ''
                  } ${
                    l.storeCode === 'SITE' || l.atual.breakdown
                      ? 'bg-violet-50 border-violet-200'
                      : 'bg-white border-slate-200'
                  }`}
                  title={l.atual.breakdown ? 'Clique pra abrir/fechar a separação Site efetivo · WhatsApp · Live' : undefined}
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

                  {/* Breakdown SITE (clique no card): Site efetivo · Venda online WhatsApp · Live */}
                  {l.atual.breakdown && !breakdownOpen[l.storeCode] && (
                    <div className="mt-2 text-[10px] font-semibold text-violet-500">
                      ▸ clique pra ver: Site efetivo · WhatsApp · Live
                    </div>
                  )}
                  {l.atual.breakdown && breakdownOpen[l.storeCode] && (
                    <div className="mt-2 bg-white border border-violet-200 rounded-md p-2 text-[11px] space-y-0.5">
                      <div className="flex justify-between">
                        <span className="text-slate-600">🛒 Site efetivo (e-commerce)</span>
                        <span className="font-bold text-violet-800">
                          {brl(l.atual.breakdown.flowops.faturamento)}
                          <span className="ml-1 font-normal text-slate-400">· {l.atual.breakdown.flowops.cupons}</span>
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-600">💬 Venda online WhatsApp</span>
                        <span className="font-bold text-violet-800">
                          {brl(l.atual.breakdown.giga.faturamento)}
                          <span className="ml-1 font-normal text-slate-400">· {l.atual.breakdown.giga.cupons}</span>
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-600">🔴 Live Commerce</span>
                        <span className="font-bold text-rose-700">
                          {brl(l.atual.breakdown.live?.faturamento ?? 0)}
                          <span className="ml-1 font-normal text-slate-400">· {l.atual.breakdown.live?.cupons ?? 0}</span>
                        </span>
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

      {/* MODAL DE ESTORNO */}
      {estornoTarget && (
        <EstornoModal
          venda={estornoTarget}
          onClose={() => setEstornoTarget(null)}
          onSuccess={() => {
            const sc = estornoTarget.storeCode;
            setEstornoTarget(null);
            onEstornoConcluido(sc);
          }}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 *  DRILLDOWN — tabela de vendas detalhadas por loja
 * ═══════════════════════════════════════════════════════════════════════ */

function DrilldownVendas({
  storeName,
  storeCode,
  vendas,
  onEstornar,
  periodLabel,
  zumbisOcultas,
}: {
  storeName: string;
  storeCode: string;
  vendas: any[];
  onEstornar: (v: any) => void;
  periodLabel?: string;
  /** Vendas "zumbi" (canceladas, R$0, sem pagamento) ocultadas pelo backend */
  zumbisOcultas?: number;
}) {
  const fmtDate = (iso: string) =>
    iso ? new Date(iso).toLocaleString('pt-BR') : '—';
  const totalLoja = vendas.reduce(
    (s, v) => s + (v.status === 'cancelled' ? 0 : Number(v.total || 0)),
    0,
  );
  const qtdCancelled = vendas.filter((v) => v.status === 'cancelled').length;

  return (
    <div className="bg-white border border-blue-200 rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-blue-50 border-b border-blue-200 flex items-center justify-between text-xs">
        <div className="font-bold text-blue-900">
          📊 {storeName} — {vendas.length} venda{vendas.length === 1 ? '' : 's'}
          {periodLabel && <span className="text-blue-700/70 font-normal"> · período {periodLabel}</span>}
          {qtdCancelled > 0 && (
            <span className="ml-2 text-rose-700">({qtdCancelled} estorno{qtdCancelled === 1 ? '' : 's'})</span>
          )}
          {(zumbisOcultas || 0) > 0 && (
            <span className="ml-2 text-slate-400 font-normal" title="Vendas abandonadas no PDV (sem nenhum pagamento), canceladas automaticamente no fechamento de caixa ou pela limpeza. Sem efeito em caixa ou estoque — não são estornos.">
              · {zumbisOcultas} abandonada{zumbisOcultas === 1 ? '' : 's'} oculta{zumbisOcultas === 1 ? '' : 's'} (auto-limpeza)
            </span>
          )}
        </div>
        <div className="text-blue-900 font-bold">
          Total ativo: {brl(totalLoja)}
        </div>
      </div>
      <div className="overflow-x-auto max-h-96 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 sticky top-0">
            <tr>
              <th className="px-2 py-1.5 text-left">Quando</th>
              <th className="px-2 py-1.5 text-left">NFC-e/ID</th>
              <th className="px-2 py-1.5 text-left">Vendedora</th>
              <th className="px-2 py-1.5 text-left">Cliente</th>
              <th className="px-2 py-1.5 text-left">Pgto</th>
              <th className="px-2 py-1.5 text-right">Total</th>
              <th className="px-2 py-1.5 text-center">Status</th>
              <th className="px-2 py-1.5 text-center">Ação</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {vendas.map((v) => (
              <tr key={v.id} className={v.status === 'cancelled' ? 'bg-rose-50/40' : 'hover:bg-slate-50'}>
                <td className="px-2 py-1.5 whitespace-nowrap font-mono text-[11px] text-slate-600">
                  {fmtDate(v.createdAt)}
                </td>
                <td className="px-2 py-1.5 font-mono text-[11px]">
                  <div className="font-bold text-slate-800">{v.number}</div>
                  {v.nfceChave && (
                    <div className="text-[9px] text-slate-400 truncate max-w-[120px]" title={v.nfceChave}>
                      {v.nfceChave.slice(0, 12)}…
                    </div>
                  )}
                </td>
                <td className="px-2 py-1.5">{v.sellerName || '—'}</td>
                <td className="px-2 py-1.5">
                  <div>{v.customerName || <span className="text-slate-400 italic">avulso</span>}</div>
                  {v.customerCpf && <div className="text-[9px] text-slate-500 font-mono">{v.customerCpf}</div>}
                </td>
                <td className="px-2 py-1.5 uppercase text-[10px] font-bold text-slate-600">
                  {v.paymentMethod || '—'}
                </td>
                <td className="px-2 py-1.5 text-right font-bold tabular-nums">
                  {v.status === 'cancelled' ? (
                    <span className="text-rose-600 line-through">{brl(v.total)}</span>
                  ) : (
                    brl(v.total)
                  )}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {v.status === 'cancelled' ? (
                    <span className="px-1.5 py-0.5 bg-rose-100 text-rose-800 rounded text-[9px] font-bold">
                      ESTORNADA
                    </span>
                  ) : v.nfceStatus === 'authorized' ? (
                    <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-800 rounded text-[9px] font-bold">
                      NFC-e OK
                    </span>
                  ) : v.nfceStatus === 'rejected' ? (
                    <span className="px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded text-[9px] font-bold">
                      REJEITADA
                    </span>
                  ) : v.nfceStatus === 'preview' ? (
                    <span className="px-1.5 py-0.5 bg-slate-100 text-slate-700 rounded text-[9px] font-bold">
                      PREVIEW
                    </span>
                  ) : (
                    <span className="text-[9px] text-slate-400">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {v.canEstornar ? (
                    <button
                      onClick={() => onEstornar(v)}
                      className="px-2 py-1 bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold rounded transition"
                      title="Estornar (exige senha master)"
                    >
                      ESTORNAR
                    </button>
                  ) : (
                    <span className="text-[9px] text-slate-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 *  MODAL DE ESTORNO — senha master + motivo + relatório
 * ═══════════════════════════════════════════════════════════════════════ */

function EstornoModal({
  venda,
  onClose,
  onSuccess,
}: {
  venda: any;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<any | null>(null);

  const isValid = motivo.trim().length >= 5 && password.trim().length >= 3;

  const confirmar = async () => {
    if (!isValid || loading) return;
    setError(null);
    setLoading(true);
    try {
      const r = await api<any>(`/pdv/sales/${venda.id}/master/estornar`, {
        method: 'POST',
        body: JSON.stringify({ motivo: motivo.trim(), password: password.trim() }),
      });
      setResultado(r);
      setPassword(''); // limpa senha após resposta
    } catch (e: any) {
      setError(e?.message || 'Falha ao estornar');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={resultado ? onSuccess : onClose}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* HEADER */}
        <div className="px-5 py-4 bg-gradient-to-r from-rose-600 to-rose-700 text-white">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-lg flex items-center gap-2">
              ⚠️ ESTORNO DE VENDA
            </h2>
            <button onClick={resultado ? onSuccess : onClose} className="text-white/80 hover:text-white">
              ✕
            </button>
          </div>
          <p className="text-xs text-rose-100 mt-1">
            Ação IRREVERSÍVEL. Reverte NFC-e + estoque + cashback.
          </p>
        </div>

        {/* CORPO */}
        <div className="p-5 space-y-4">
          {!resultado ? (
            <>
              {/* Resumo da venda */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-600">Loja:</span>
                  <strong>{venda.storeName}</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">NFC-e/ID:</span>
                  <strong className="font-mono">{venda.number}</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Cliente:</span>
                  <span>{venda.customerName || 'avulso'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Pagamento:</span>
                  <span className="uppercase text-xs">{venda.paymentMethod || '—'}</span>
                </div>
                <div className="flex justify-between text-base pt-1 border-t border-slate-200">
                  <strong>Total a estornar:</strong>
                  <strong className="text-rose-700">{brl(venda.total)}</strong>
                </div>
              </div>

              {/* Motivo */}
              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-slate-700 mb-1 block">
                  Motivo do estorno <span className="text-rose-600">*</span>
                </label>
                <textarea
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  placeholder="Ex: Cliente desistiu da compra. Produto devolvido em perfeito estado."
                  rows={3}
                  maxLength={300}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:border-rose-500 focus:ring-1 focus:ring-rose-500"
                />
                <div className="text-[10px] text-slate-400 mt-0.5">
                  Mín 5 chars · {motivo.length}/300
                </div>
              </div>

              {/* Senha master */}
              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-slate-700 mb-1 block">
                  Senha master <span className="text-rose-600">*</span>
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Senha de nível MASTER"
                  autoComplete="off"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:border-rose-500 focus:ring-1 focus:ring-rose-500"
                />
              </div>

              {error && (
                <div className="px-3 py-2 bg-rose-50 border border-rose-200 rounded text-sm text-rose-800">
                  ❌ {error}
                </div>
              )}

              {/* Avisos */}
              <div className="bg-amber-50 border border-amber-200 rounded p-2.5 text-[11px] text-amber-900 space-y-0.5">
                <div><strong>O que vai acontecer:</strong></div>
                <div>• Cancela NFC-e na SEFAZ (se autorizada e dentro da janela 30min)</div>
                <div>• Devolve estoque ao Wincred automaticamente</div>
                <div>• Revoga cashback do cliente</div>
                {(['credito', 'debito', 'cartao'].includes(String(venda.paymentMethod || '').toLowerCase())) && (
                  <div className="font-bold pt-1 border-t border-amber-300">
                    ⚠️ Pagamento em CARTÃO — você precisa estornar MANUALMENTE na maquininha
                  </div>
                )}
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  onClick={onClose}
                  disabled={loading}
                  className="flex-1 px-4 py-2.5 border border-slate-300 hover:bg-slate-50 text-slate-700 font-bold rounded-lg transition"
                >
                  Cancelar
                </button>
                <button
                  onClick={confirmar}
                  disabled={!isValid || loading}
                  className="flex-1 px-4 py-2.5 bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-bold rounded-lg transition flex items-center justify-center gap-2"
                >
                  {loading ? '⏳ Processando…' : '✓ ESTORNAR'}
                </button>
              </div>
            </>
          ) : (
            <>
              {/* RESULTADO */}
              <div className={`p-3 rounded-lg ${
                resultado.passos?.some((p: any) => p.status === 'falhou')
                  ? 'bg-amber-50 border border-amber-300'
                  : 'bg-emerald-50 border border-emerald-300'
              }`}>
                <div className="font-bold text-sm mb-1">
                  {resultado.passos?.some((p: any) => p.status === 'falhou')
                    ? '⚠️ Estorno parcial — atenção aos avisos'
                    : '✅ Estorno concluído'}
                </div>
                <div className="text-xs text-slate-700">
                  Total estornado: <strong>{brl(resultado.totalEstornado || 0)}</strong>
                </div>
              </div>

              <div>
                <div className="text-xs font-bold uppercase tracking-wider text-slate-700 mb-2">
                  Detalhamento
                </div>
                <div className="space-y-1.5">
                  {(resultado.passos || []).map((p: any, i: number) => (
                    <div
                      key={i}
                      className={`flex items-start gap-2 p-2 rounded text-xs border ${
                        p.status === 'ok' ? 'bg-emerald-50 border-emerald-200' :
                        p.status === 'falhou' ? 'bg-rose-50 border-rose-200' :
                        p.status === 'atencao' ? 'bg-amber-50 border-amber-200' :
                        'bg-slate-50 border-slate-200'
                      }`}
                    >
                      <span className="text-base shrink-0 mt-[-2px]">
                        {p.status === 'ok' ? '✅' :
                         p.status === 'falhou' ? '❌' :
                         p.status === 'atencao' ? '⚠️' :
                         '⊝'}
                      </span>
                      <div className="flex-1">
                        <div className="font-bold">{p.passo}</div>
                        <div className="text-slate-600 mt-0.5">{p.detalhe}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <button
                onClick={onSuccess}
                className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg transition"
              >
                Entendi, fechar
              </button>
                  </>
          )}
        </div>
      </div>
    </div>
  );
}
