'use client';

/**
 * /retaguarda/transferencias-rede-franquia — Síntese REDE × FRANQUIA
 *
 * Relatório SINTÉTICO de transferências por TIPO de loja (não loja-a-loja).
 * Responde diretamente: quanto a REDE mandou pra FRANQUIA (FILIAL) e vice-versa.
 *
 * 4 fluxos consolidados:
 *   REDE → FRANQUIA · FRANQUIA → REDE · REDE → REDE · FRANQUIA → FRANQUIA
 *
 * Métricas por fluxo: peças, valor total (preço de venda) e valor de custo (÷2,5).
 * Dados: GET /api/transferencias/rede-franquia?period=...
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Calendar,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Network,
  Package,
  Printer,
  Store,
} from 'lucide-react';
import { api } from '@/lib/api';

/* ─── Types ─── */
interface FlowMetrics {
  pecas: number;
  valorTotal: number;
  valorCusto: number;
  shipments: number;
}
interface Pair {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  fromTipo: string;
  toTipo: string;
  direction: string;
  pecas: number;
  valorTotal: number;
  valorCusto: number;
}
interface Summary {
  period: { from: string; to: string };
  divisor: number;
  flows: {
    redeToFilial: FlowMetrics;
    filialToRede: FlowMetrics;
    redeToRede: FlowMetrics;
    filialToFilial: FlowMetrics;
  };
  totals: FlowMetrics;
  pairs: Pair[];
  meta?: { ordersWithoutPrice: number; ordersTotal: number };
}

type FlowKey = 'redeToFilial' | 'filialToRede' | 'redeToRede' | 'filialToFilial';

const PERIODS: Array<{ value: string; label: string }> = [
  { value: '7d', label: '7 dias' },
  { value: '30d', label: '30 dias' },
  { value: '90d', label: '90 dias' },
  { value: 'ytd', label: 'Este ano' },
  { value: '12m', label: '12 meses' },
];

const FLOW_DEFS: Array<{
  key: FlowKey;
  label: string;
  fromTipo: 'REDE' | 'FRANQUIA';
  toTipo: 'REDE' | 'FRANQUIA';
  accent: string; // tailwind border/text accent
  bg: string;
}> = [
  { key: 'redeToFilial', label: 'REDE → FRANQUIA', fromTipo: 'REDE', toTipo: 'FRANQUIA', accent: 'text-blue-600', bg: 'bg-blue-50 border-blue-200' },
  { key: 'filialToRede', label: 'FRANQUIA → REDE', fromTipo: 'FRANQUIA', toTipo: 'REDE', accent: 'text-amber-600', bg: 'bg-amber-50 border-amber-200' },
  { key: 'redeToRede', label: 'REDE → REDE', fromTipo: 'REDE', toTipo: 'REDE', accent: 'text-slate-600', bg: 'bg-slate-50 border-slate-200' },
  { key: 'filialToFilial', label: 'FRANQUIA → FRANQUIA', fromTipo: 'FRANQUIA', toTipo: 'FRANQUIA', accent: 'text-purple-600', bg: 'bg-purple-50 border-purple-200' },
];

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (n: number) => n.toLocaleString('pt-BR');

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export default function TransferenciasRedeFranquiaPage() {
  const [period, setPeriod] = useState('90d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const isCustom = period === 'custom';

  useEffect(() => {
    // No modo personalizado só busca quando as duas datas estão preenchidas.
    if (isCustom && (!customFrom || !customTo)) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    const qs = isCustom
      ? `from=${customFrom}&to=${customTo}`
      : `period=${period}`;
    api<Summary>(`/transferencias/rede-franquia?${qs}`)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(String(e?.message || e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [period, customFrom, customTo, isCustom]);

  /** Ativa o modo personalizado, pré-preenchendo os últimos 30 dias. */
  function enableCustom() {
    if (!customFrom || !customTo) {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 30);
      setCustomFrom(ymd(from));
      setCustomTo(ymd(to));
    }
    setPeriod('custom');
  }

  const pairsByFlow = useMemo(() => {
    const map: Record<string, Pair[]> = {
      redeToFilial: [],
      filialToRede: [],
      redeToRede: [],
      filialToFilial: [],
    };
    for (const p of data?.pairs || []) {
      if (map[p.direction]) map[p.direction].push(p);
    }
    return map;
  }, [data]);

  function exportCsv() {
    if (!data) return;
    const lines: string[] = [];
    lines.push('Fluxo;Pecas;Valor Total (R$);Valor Custo /2,5 (R$);Remessas');
    for (const f of FLOW_DEFS) {
      const m = data.flows[f.key];
      lines.push(
        `${f.label};${m.pecas};${m.valorTotal.toFixed(2)};${m.valorCusto.toFixed(2)};${m.shipments}`,
      );
    }
    const t = data.totals;
    lines.push(`TOTAL;${t.pecas};${t.valorTotal.toFixed(2)};${t.valorCusto.toFixed(2)};${t.shipments}`);
    lines.push('');
    lines.push('Detalhe loja-a-loja');
    lines.push('Direcao;Origem;Destino;Pecas;Valor Total (R$);Valor Custo /2,5 (R$)');
    for (const p of data.pairs) {
      lines.push(
        `${p.direction};${p.from} ${p.fromName};${p.to} ${p.toName};${p.pecas};${p.valorTotal.toFixed(2)};${p.valorCusto.toFixed(2)}`,
      );
    }
    const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const suffix = isCustom && data.period ? `${data.period.from}_a_${data.period.to}` : period;
    a.download = `transferencias-rede-franquia-${suffix}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-slate-100 p-4 md:p-6 print:bg-white print:p-0">
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:mb-3">
          <div>
            <Link
              href="/retaguarda"
              className="mb-1 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 print:hidden"
            >
              <ArrowLeft className="h-4 w-4" /> Retaguarda
            </Link>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-800">
              <Network className="h-6 w-6 text-blue-600" />
              Transferências REDE × FRANQUIA
            </h1>
            <p className="text-sm text-slate-500">
              Consolidado por tipo de loja — quanto cada categoria enviou pra outra.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <div className="flex overflow-hidden rounded-lg border border-slate-300 bg-white">
              {PERIODS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => setPeriod(p.value)}
                  className={`px-3 py-1.5 text-sm font-medium transition ${
                    period === p.value
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {p.label}
                </button>
              ))}
              <button
                onClick={enableCustom}
                className={`inline-flex items-center gap-1 border-l border-slate-300 px-3 py-1.5 text-sm font-medium transition ${
                  isCustom ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                <Calendar className="h-4 w-4" /> Personalizado
              </button>
            </div>
            {isCustom && (
              <div className="flex items-center gap-1.5 rounded-lg border border-blue-300 bg-blue-50 px-2 py-1">
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700"
                />
                <span className="text-sm text-slate-500">até</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700"
                />
              </div>
            )}
            <button
              onClick={exportCsv}
              disabled={!data}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              <Download className="h-4 w-4" /> CSV
            </button>
            <button
              onClick={() => window.print()}
              disabled={!data}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              <Printer className="h-4 w-4" /> Imprimir
            </button>
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-24 text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" /> Carregando relatório…
          </div>
        )}

        {error && !loading && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            Falha ao carregar: {error}
          </div>
        )}

        {data && !loading && (
          <>
            {data.period && (
              <p className="mb-4 text-xs text-slate-400">
                Período: {data.period.from} a {data.period.to} · valor de custo = valor de
                venda ÷ {String(data.divisor).replace('.', ',')}
                {data.meta && data.meta.ordersWithoutPrice > 0 && (
                  <> · {data.meta.ordersWithoutPrice}/{data.meta.ordersTotal} itens sem preço no Giga (contam só em peças)</>
                )}
              </p>
            )}

            {/* 4 quadrant cards */}
            <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {FLOW_DEFS.map((f) => {
                const m = data.flows[f.key];
                return (
                  <div key={f.key} className={`rounded-xl border p-4 ${f.bg}`}>
                    <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                      <TipoBadge tipo={f.fromTipo} />
                      <ArrowRight className={`h-4 w-4 ${f.accent}`} />
                      <TipoBadge tipo={f.toTipo} />
                      <span className="ml-auto text-xs font-normal text-slate-500">
                        {num(m.shipments)} remessas
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <Metric label="Peças" value={num(m.pecas)} icon={<Package className="h-3.5 w-3.5" />} />
                      <Metric label="Valor total" value={brl(m.valorTotal)} />
                      <Metric label="Custo ÷2,5" value={brl(m.valorCusto)} strong />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Summary table */}
            <div className="mb-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Fluxo</th>
                    <th className="px-4 py-3 text-right">Peças</th>
                    <th className="px-4 py-3 text-right">Valor total</th>
                    <th className="px-4 py-3 text-right">Custo ÷2,5</th>
                    <th className="px-4 py-3 text-right">Remessas</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {FLOW_DEFS.map((f) => {
                    const m = data.flows[f.key];
                    const pairs = pairsByFlow[f.key] || [];
                    const isOpen = !!expanded[f.key];
                    return (
                      <FlowRows
                        key={f.key}
                        label={f.label}
                        metrics={m}
                        pairs={pairs}
                        open={isOpen}
                        onToggle={() => setExpanded((e) => ({ ...e, [f.key]: !e[f.key] }))}
                      />
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold text-slate-800">
                    <td className="px-4 py-3">TOTAL</td>
                    <td className="px-4 py-3 text-right">{num(data.totals.pecas)}</td>
                    <td className="px-4 py-3 text-right">{brl(data.totals.valorTotal)}</td>
                    <td className="px-4 py-3 text-right">{brl(data.totals.valorCusto)}</td>
                    <td className="px-4 py-3 text-right">{num(data.totals.shipments)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <p className="text-xs text-slate-400 print:hidden">
              Clique numa linha pra ver o detalhe loja-a-loja daquele fluxo.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Subcomponents ─── */
function TipoBadge({ tipo }: { tipo: 'REDE' | 'FRANQUIA' }) {
  const isRede = tipo === 'REDE';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-bold ${
        isRede ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'
      }`}
    >
      {isRede ? <Building2 className="h-3 w-3" /> : <Store className="h-3 w-3" />}
      {tipo}
    </span>
  );
}

function Metric({
  label,
  value,
  icon,
  strong,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="rounded-lg bg-white/70 px-2 py-1.5">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-400">
        {icon}
        {label}
      </div>
      <div className={`truncate text-sm ${strong ? 'font-bold text-slate-900' : 'font-semibold text-slate-700'}`}>
        {value}
      </div>
    </div>
  );
}

function FlowRows({
  label,
  metrics,
  pairs,
  open,
  onToggle,
}: {
  label: string;
  metrics: FlowMetrics;
  pairs: Pair[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="cursor-pointer hover:bg-slate-50"
        onClick={onToggle}
      >
        <td className="px-4 py-3 font-medium text-slate-800">
          <span className="inline-flex items-center gap-1.5">
            {pairs.length > 0 ? (
              open ? (
                <ChevronDown className="h-4 w-4 text-slate-400" />
              ) : (
                <ChevronRight className="h-4 w-4 text-slate-400" />
              )
            ) : (
              <span className="inline-block w-4" />
            )}
            {label}
          </span>
        </td>
        <td className="px-4 py-3 text-right tabular-nums">{num(metrics.pecas)}</td>
        <td className="px-4 py-3 text-right tabular-nums">{brl(metrics.valorTotal)}</td>
        <td className="px-4 py-3 text-right font-semibold tabular-nums">{brl(metrics.valorCusto)}</td>
        <td className="px-4 py-3 text-right tabular-nums">{num(metrics.shipments)}</td>
      </tr>
      {open &&
        pairs.map((p) => (
          <tr key={`${p.from}->${p.to}`} className="bg-slate-50/60 text-xs text-slate-600">
            <td className="py-1.5 pl-12 pr-4">
              {p.from} {p.fromName} <span className="text-slate-400">→</span> {p.to} {p.toName}
            </td>
            <td className="px-4 py-1.5 text-right tabular-nums">{num(p.pecas)}</td>
            <td className="px-4 py-1.5 text-right tabular-nums">{brl(p.valorTotal)}</td>
            <td className="px-4 py-1.5 text-right tabular-nums">{brl(p.valorCusto)}</td>
            <td className="px-4 py-1.5" />
          </tr>
        ))}
    </>
  );
}
