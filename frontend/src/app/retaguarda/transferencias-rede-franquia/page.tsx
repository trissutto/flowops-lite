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
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Building2,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  FileText,
  Loader2,
  Network,
  Package,
  Paperclip,
  Percent,
  Plus,
  Printer,
  RefreshCw,
  SlidersHorizontal,
  Store,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import { api, API_URL, getAuthToken } from '@/lib/api';

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

/** Formata o horário do último sync do espelho do Giga. */
const fmtSync = (iso: string) => {
  const d = new Date(iso);
  const hoje = new Date();
  const mesmoDia = d.toDateString() === hoje.toDateString();
  return mesmoDia
    ? `às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export default function TransferenciasRedeFranquiaPage() {
  // Filtro SÓ por seletor de datas (de/até). Default: últimos 90 dias.
  const [customFrom, setCustomFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return ymd(d);
  });
  const [customTo, setCustomTo] = useState(() => ymd(new Date()));
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<'analise' | 'conta'>('analise');

  useEffect(() => {
    if (!customFrom || !customTo) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    api<Summary>(`/transferencias/rede-franquia?from=${customFrom}&to=${customTo}`)
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
  }, [customFrom, customTo]);

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
    const suffix = data.period ? `${data.period.from}_a_${data.period.to}` : `${customFrom}_a_${customTo}`;
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
          {tab === 'analise' && (
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <div className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1">
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
          )}
        </div>

        {/* Abas: Análise × Conta Corrente */}
        <div className="mb-5 flex gap-1 border-b border-slate-200 print:hidden">
          <button
            onClick={() => setTab('analise')}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold transition ${
              tab === 'analise'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            Análise das transferências
          </button>
          <button
            onClick={() => setTab('conta')}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-semibold transition ${
              tab === 'conta'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Wallet className="h-4 w-4" /> Conta Corrente da Franqueada
          </button>
        </div>

        {tab === 'conta' && <ContaCorrente />}

        {tab === 'analise' && loading && (
          <div className="flex items-center justify-center gap-2 py-24 text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" /> Carregando relatório…
          </div>
        )}

        {tab === 'analise' && error && !loading && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            Falha ao carregar: {error}
          </div>
        )}

        {tab === 'analise' && data && !loading && (
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

function CatCard({
  icon,
  label,
  valor,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  valor: number;
  hint: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-center gap-1.5 text-sm text-slate-500">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-lg font-bold text-slate-800">{brl(valor)}</div>
      <div className="text-[11px] text-slate-400">{hint}</div>
    </div>
  );
}

/* ─── Conta Corrente da Franqueada ─── */
interface DetItem {
  label: string;
  valor: number;
  sinal: string;
  from?: string;
  to?: string;
  fromTipo?: string; // 'REDE' | 'FILIAL'
  toTipo?: string;
  pecas?: number;
  transfers?: Array<{ data: string; controle: string; pecas: number; valor: number }>;
}
interface CCLinha {
  id: string;
  data: string;
  tipo: string; // 'debito_sistema' | 'pagamento' | 'ajuste'
  natureza: 'debito' | 'credito';
  descricao: string;
  valor: number;
  saldo: number;
  documentoUrl: string | null;
  documentoNome: string | null;
  criadoPorNome?: string | null;
  editavel: boolean;
  sistema?: string;
  detalhe?: DetItem[];
}
interface CCExtrato {
  from: string;
  to: string;
  linhas: CCLinha[];
  totalDebitos: number;
  totalCreditos: number;
  saldo: number;
  gigaIndisponivel?: boolean;
  mesesIndisponiveis?: string[];
  gigaSync?: {
    lastOkAt: string | null;
    pendente: boolean;
    erro: string | null;
    syncing?: boolean;
  } | null;
}

/* Monta a árvore REDE/FRANQUIA → cidade que enviou → cidades destino. */
interface DetSender {
  from: string;
  total: number;
  pecas: number;
  dests: DetItem[];
}
interface DetGroup {
  tipo: string; // 'REDE' | 'FILIAL'
  sinal: string;
  total: number;
  pecas: number;
  senders: DetSender[];
}
function buildDetTree(det: DetItem[]): DetGroup[] {
  const round = (n: number) => Math.round(n * 100) / 100;
  const gmap = new Map<string, { tipo: string; sinal: string; total: number; pecas: number; smap: Map<string, DetSender> }>();
  for (const it of det) {
    if (!it.fromTipo) continue;
    let g = gmap.get(it.fromTipo);
    if (!g) {
      g = { tipo: it.fromTipo, sinal: it.sinal, total: 0, pecas: 0, smap: new Map() };
      gmap.set(it.fromTipo, g);
    }
    g.total += it.valor;
    g.pecas += it.pecas || 0;
    const key = it.from || it.label;
    let s = g.smap.get(key);
    if (!s) {
      s = { from: key, total: 0, pecas: 0, dests: [] };
      g.smap.set(key, s);
    }
    s.total += it.valor;
    s.pecas += it.pecas || 0;
    s.dests.push(it);
  }
  const finalize = (g: { tipo: string; sinal: string; total: number; pecas: number; smap: Map<string, DetSender> }): DetGroup => ({
    tipo: g.tipo,
    sinal: g.sinal,
    total: round(g.total),
    pecas: g.pecas,
    senders: Array.from(g.smap.values())
      .map((s) => ({ ...s, total: round(s.total), dests: s.dests.slice().sort((a, b) => b.valor - a.valor) }))
      .sort((a, b) => b.total - a.total),
  });
  const out: DetGroup[] = [];
  for (const t of ['REDE', 'FILIAL']) {
    const g = gmap.get(t);
    if (g) out.push(finalize(g));
  }
  for (const [t, g] of gmap) if (t !== 'REDE' && t !== 'FILIAL') out.push(finalize(g));
  return out;
}

function DetalheTree({ det }: { det: DetItem[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => buildDetTree(det), [det]);
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  // Royalties (e qualquer detalhe sem hierarquia) → lista simples como antes.
  if (!det.some((d) => !!d.fromTipo)) {
    return (
      <>
        {det.map((d, i) => (
          <tr key={i} className="bg-white text-xs text-slate-600">
            <td className="px-4 py-1.5" />
            <td className="py-1.5 pl-10 pr-4">
              {d.sinal === '-' ? '− ' : '+ '}
              {d.label}
            </td>
            <td className="px-4 py-1.5 text-right tabular-nums text-rose-600">{d.sinal === '+' ? brl(d.valor) : ''}</td>
            <td className="px-4 py-1.5 text-right tabular-nums text-emerald-600">{d.sinal === '-' ? brl(d.valor) : ''}</td>
            <td className="px-4 py-1.5" />
            <td className="px-4 py-1.5" />
            <td className="px-4 py-1.5" />
          </tr>
        ))}
      </>
    );
  }

  return (
    <>
      {groups.map((g) => {
        const isDeb = g.sinal === '+';
        const gOpen = !!open[g.tipo];
        const gLabel = g.tipo === 'REDE' ? 'REDE → FRANQUIA' : 'FRANQUIA → REDE';
        return (
          <Fragment key={g.tipo}>
            <tr className="cursor-pointer bg-slate-100/60 text-xs hover:bg-slate-100" onClick={() => toggle(g.tipo)}>
              <td className="px-4 py-1.5" />
              <td className="py-1.5 pl-8 pr-4">
                {gOpen ? <ChevronDown className="inline h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="inline h-3.5 w-3.5 text-slate-400" />}
                <span className="ml-1 font-bold text-slate-700">{gLabel}</span>
                <span className="ml-2 text-slate-400">{num(g.pecas)} pç · {g.senders.length} cidade{g.senders.length > 1 ? 's' : ''}</span>
              </td>
              <td className="px-4 py-1.5 text-right font-semibold tabular-nums text-rose-700">{isDeb ? brl(g.total) : ''}</td>
              <td className="px-4 py-1.5 text-right font-semibold tabular-nums text-emerald-700">{!isDeb ? brl(g.total) : ''}</td>
              <td className="px-4 py-1.5" />
              <td className="px-4 py-1.5" />
              <td className="px-4 py-1.5" />
            </tr>
            {gOpen &&
              g.senders.map((s) => {
                const sk = `${g.tipo}/${s.from}`;
                const sOpen = !!open[sk];
                return (
                  <Fragment key={sk}>
                    <tr className="cursor-pointer bg-white text-xs hover:bg-slate-50" onClick={() => toggle(sk)}>
                      <td className="px-4 py-1.5" />
                      <td className="py-1.5 pl-12 pr-4">
                        {sOpen ? <ChevronDown className="inline h-3.5 w-3.5 text-slate-300" /> : <ChevronRight className="inline h-3.5 w-3.5 text-slate-300" />}
                        <span className="ml-1 font-medium text-slate-700">{s.from}</span>
                        <span className="ml-2 text-slate-400">{num(s.pecas)} pç · {s.dests.length} destino{s.dests.length > 1 ? 's' : ''}</span>
                      </td>
                      <td className="px-4 py-1.5 text-right tabular-nums text-rose-600">{isDeb ? brl(s.total) : ''}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums text-emerald-600">{!isDeb ? brl(s.total) : ''}</td>
                      <td className="px-4 py-1.5" />
                      <td className="px-4 py-1.5" />
                      <td className="px-4 py-1.5" />
                    </tr>
                    {sOpen &&
                      s.dests.map((d, i) => {
                        const dk = `${sk}::${i}`;
                        const hasT = !!(d.transfers && d.transfers.length);
                        const dOpen = !!open[dk];
                        return (
                          <Fragment key={dk}>
                            <tr
                              className={`bg-white text-xs text-slate-600 ${hasT ? 'cursor-pointer hover:bg-slate-50' : ''}`}
                              onClick={hasT ? () => toggle(dk) : undefined}
                            >
                              <td className="px-4 py-1" />
                              <td className="py-1 pl-16 pr-4">
                                {hasT ? (
                                  dOpen ? <ChevronDown className="inline h-3.5 w-3.5 text-slate-300" /> : <ChevronRight className="inline h-3.5 w-3.5 text-slate-300" />
                                ) : (
                                  <span className="text-slate-400">→</span>
                                )}
                                <span className="ml-1">{d.to} · {num(d.pecas || 0)} pç</span>
                                {hasT && <span className="ml-2 text-slate-400">{d.transfers!.length} transf.</span>}
                              </td>
                              <td className="px-4 py-1 text-right tabular-nums text-rose-500">{isDeb ? brl(d.valor) : ''}</td>
                              <td className="px-4 py-1 text-right tabular-nums text-emerald-500">{!isDeb ? brl(d.valor) : ''}</td>
                              <td className="px-4 py-1" />
                              <td className="px-4 py-1" />
                              <td className="px-4 py-1" />
                            </tr>
                            {hasT &&
                              dOpen &&
                              d.transfers!.map((t, j) => (
                                <tr key={`${dk}-t-${j}`} className="bg-slate-50/40 text-[11px] text-slate-500">
                                  <td className="whitespace-nowrap px-4 py-1">{t.data.split('-').reverse().join('/')}</td>
                                  <td className="py-1 pl-20 pr-4">
                                    <span className="text-slate-400">nº</span> {t.controle} · {num(t.pecas)} pç
                                  </td>
                                  <td className="px-4 py-1 text-right tabular-nums text-rose-400">{isDeb ? brl(t.valor) : ''}</td>
                                  <td className="px-4 py-1 text-right tabular-nums text-emerald-400">{!isDeb ? brl(t.valor) : ''}</td>
                                  <td className="px-4 py-1" />
                                  <td className="px-4 py-1" />
                                  <td className="px-4 py-1" />
                                </tr>
                              ))}
                          </Fragment>
                        );
                      })}
                  </Fragment>
                );
              })}
          </Fragment>
        );
      })}
    </>
  );
}

function ContaCorrente() {
  const hoje = new Date();
  const seisMesesAtras = new Date(hoje.getFullYear(), hoje.getMonth() - 5, 1);
  const [from, setFrom] = useState(ymd(seisMesesAtras));
  const [to, setTo] = useState(ymd(hoje));
  const [ext, setExt] = useState<CCExtrato | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [expandido, setExpandido] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState(false);
  const reqIdRef = useRef(0);

  // Resumo do topo: quebra os débitos por categoria (mercadoria = giga+flow,
  // royalties+mkt, ajustes manuais) e calcula quanto do total já foi quitado.
  const resumo = useMemo(() => {
    if (!ext) return null;
    const cats = { mercadoria: 0, royalties: 0, ajustes: 0 };
    for (const l of ext.linhas) {
      const s = l.natureza === 'debito' ? l.valor : -l.valor;
      if (l.tipo === 'debito_sistema') {
        if (l.sistema === 'royalties') cats.royalties += s;
        else cats.mercadoria += s; // giga + flow
      } else if (l.tipo === 'ajuste') {
        cats.ajustes += s;
      }
    }
    const round = (n: number) => Math.round(n * 100) / 100;
    const pct =
      ext.totalDebitos > 0.005
        ? Math.min(100, Math.round((ext.totalCreditos / ext.totalDebitos) * 100))
        : ext.saldo > 0.005
        ? 0
        : 100;
    return {
      cats: { mercadoria: round(cats.mercadoria), royalties: round(cats.royalties), ajustes: round(cats.ajustes) },
      pct,
      saldoPos: ext.saldo > 0.005,
      saldoNeg: ext.saldo < -0.005,
    };
  }, [ext]);

  async function load() {
    // Ignora respostas de loads ANTIGOS (corrida ao trocar datas/atualizar) —
    // só o request mais recente atualiza a tela. Evita ficar preso em
    // "Carregando..." por causa de uma resposta lenta que chegou atrasada.
    const myId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const d = await api<CCExtrato>(`/financeiro/conta-corrente?from=${from}&to=${to}`);
      if (myId === reqIdRef.current) setExt(d);
    } catch (e: any) {
      if (myId === reqIdRef.current) setError(String(e?.message || e));
    } finally {
      if (myId === reqIdRef.current) setLoading(false);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  async function excluir(id: string) {
    if (!confirm('Estornar este lançamento? O documento anexado também será removido.')) return;
    try {
      await api(`/financeiro/conta-corrente/lancamentos/${id}`, { method: 'DELETE' });
      load();
    } catch (e: any) {
      alert('Falha ao estornar: ' + (e?.message || e));
    }
  }

  async function syncGiga() {
    setSyncing(true);
    try {
      await api(`/financeiro/conta-corrente/sync-giga`, { method: 'POST' });
      await load();
    } catch (e: any) {
      alert('Falha ao sincronizar o Giga: ' + (e?.message || e));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1">
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700"
            />
            <span className="text-sm text-slate-500">até</span>
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700"
            />
            <button onClick={load} className="ml-1 rounded p-1 text-slate-500 hover:bg-slate-100" title="Atualizar">
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
          <button
            onClick={syncGiga}
            disabled={syncing}
            title="Puxa os dados do Giga para a base local (espelho). A tela lê do espelho."
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <Database className={`h-4 w-4 ${syncing ? 'animate-pulse' : ''}`} />
            {syncing ? 'Sincronizando…' : 'Sincronizar Giga'}
          </button>
          {ext?.gigaSync?.lastOkAt && !ext.gigaSync.pendente && !syncing && (
            <span className="text-xs text-slate-400">sincronizado {fmtSync(ext.gigaSync.lastOkAt)}</span>
          )}
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-700"
        >
          <Plus className="h-4 w-4" /> Lançar pagamento / ajuste
        </button>
      </div>

      {(ext?.gigaSync?.pendente || ext?.gigaIndisponivel) && !loading && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="flex-1 text-sm text-amber-900">
            {ext?.gigaSync?.pendente ? (
              <>
                <div className="font-bold">Espelho do Giga ainda não sincronizado</div>
                <div className="text-amber-800">
                  A mercadoria e os royalties leem da base local, que ainda não foi populada
                  {ext.gigaSync?.erro ? ' (o último sync falhou)' : ''}. Clique em <b>Sincronizar Giga</b> pra
                  puxar os dados agora.
                </div>
              </>
            ) : (
              <>
                <div className="font-bold">Não foi possível ler o espelho do Giga</div>
                <div className="text-amber-800">
                  Os valores podem estar <b>incompletos</b> — <b>não</b> significa R$ 0 real. Clique em atualizar.
                </div>
              </>
            )}
          </div>
          <button
            onClick={ext?.gigaSync?.pendente ? syncGiga : load}
            disabled={syncing}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-sm font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          >
            {ext?.gigaSync?.pendente ? <Database className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
            {ext?.gigaSync?.pendente ? (syncing ? 'Sincronizando…' : 'Sincronizar Giga') : 'Atualizar'}
          </button>
        </div>
      )}

      {ext && resumo && (
        <div className="mb-5">
          {/* Saldo em destaque + barra de quitação */}
          <div className="mb-3 rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-xs text-slate-500">Saldo a acertar</div>
                <div className={`text-3xl font-black leading-tight ${resumo.saldoPos ? 'text-rose-700' : 'text-emerald-700'}`}>
                  {brl(Math.abs(ext.saldo))}
                </div>
                <div className="flex items-center gap-1 text-xs text-slate-500">
                  {resumo.saldoPos ? (
                    <>
                      <ArrowUpRight className="h-3.5 w-3.5" /> franqueada deve à rede
                    </>
                  ) : resumo.saldoNeg ? (
                    'crédito a favor da franqueada'
                  ) : (
                    'quitado'
                  )}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[11px] uppercase tracking-wide text-slate-400">Débitos</div>
                <div className="text-base font-bold text-slate-800">{brl(ext.totalDebitos)}</div>
                <div className="mt-2 text-[11px] uppercase tracking-wide text-slate-400">Pago / créditos</div>
                <div className="text-base font-bold text-emerald-700">{brl(ext.totalCreditos)}</div>
              </div>
            </div>
            <div className="mt-4">
              <div className="mb-1.5 flex justify-between text-xs text-slate-500">
                <span>{resumo.pct}% quitado</span>
                <span>{resumo.saldoPos ? `faltam ${brl(ext.saldo)}` : 'sem saldo devedor'}</span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${resumo.pct}%` }}
                />
              </div>
            </div>
          </div>

          {/* Débitos por categoria */}
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            <CatCard
              icon={<Building2 className="h-4 w-4 text-blue-600" />}
              label="Mercadoria"
              valor={resumo.cats.mercadoria}
              hint="Giga + Flow · custo ÷2,5"
            />
            <CatCard
              icon={<Percent className="h-4 w-4 text-purple-600" />}
              label="Royalties + Mkt"
              valor={resumo.cats.royalties}
              hint="8% + 4% da venda"
            />
            <CatCard
              icon={<SlidersHorizontal className="h-4 w-4 text-amber-600" />}
              label="Ajustes"
              valor={resumo.cats.ajustes}
              hint="lançamentos manuais"
            />
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" /> Carregando…
        </div>
      )}
      {error && !loading && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">Falha: {error}</div>
      )}

      {ext && !loading && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Data</th>
                <th className="px-4 py-3">Descrição</th>
                <th className="px-4 py-3 text-right">Débito</th>
                <th className="px-4 py-3 text-right">Crédito</th>
                <th className="px-4 py-3 text-right">Saldo</th>
                <th className="px-4 py-3 text-center">Doc</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ext.linhas.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    Nenhum lançamento no período.
                  </td>
                </tr>
              )}
              {ext.linhas.map((l) => {
                const temDet = !!(l.detalhe && l.detalhe.length);
                const aberto = !!expandido[l.id];
                return (
                  <Fragment key={l.id}>
                    <tr
                      className={`${l.tipo === 'debito_sistema' ? 'bg-slate-50/40' : ''} ${temDet ? 'cursor-pointer hover:bg-slate-100/70' : ''}`}
                      onClick={temDet ? () => setExpandido((e) => ({ ...e, [l.id]: !e[l.id] })) : undefined}
                    >
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                        {new Date(l.data).toLocaleDateString('pt-BR')}
                      </td>
                      <td className="px-4 py-2.5">
                        {temDet && (
                          <span className="mr-1 inline-block align-middle text-slate-400">
                            {aberto ? <ChevronDown className="inline h-4 w-4" /> : <ChevronRight className="inline h-4 w-4" />}
                          </span>
                        )}
                        <span className="text-slate-800">{l.descricao}</span>
                        {l.tipo === 'pagamento' && (
                          <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">
                            PAGAMENTO
                          </span>
                        )}
                        {l.tipo === 'ajuste' && (
                          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                            AJUSTE
                          </span>
                        )}
                        {l.criadoPorNome && <span className="ml-2 text-[10px] text-slate-400">por {l.criadoPorNome}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-rose-700">
                        {l.natureza === 'debito' ? brl(l.valor) : ''}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-emerald-700">
                        {l.natureza === 'credito' ? brl(l.valor) : ''}
                      </td>
                      <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{brl(l.saldo)}</td>
                      <td className="px-4 py-2.5 text-center">
                        {l.documentoUrl ? (
                          <a
                            href={l.documentoUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex text-blue-600 hover:text-blue-800"
                            title={l.documentoNome || 'Documento'}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <FileText className="h-4 w-4" />
                          </a>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {l.editavel && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              excluir(l.id);
                            }}
                            className="text-slate-400 hover:text-rose-600"
                            title="Estornar"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                    {temDet && aberto && <DetalheTree det={l.detalhe!} />}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs text-slate-400">
        Linhas em cinza = débitos automáticos do sistema (mercadoria ÷2,5 + royalties 8% + marketing 4% por mês).
        Pagamentos e ajustes são lançados manualmente, com documento anexável. Saldo &gt; 0 = a franqueada deve à rede.
      </p>

      {showForm && (
        <LancamentoForm
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function LancamentoForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [tipo, setTipo] = useState<'pagamento' | 'ajuste'>('pagamento');
  const [natureza, setNatureza] = useState<'credito' | 'debito'>('debito');
  const [data, setData] = useState(ymd(new Date()));
  const [valor, setValor] = useState('');
  const [descricao, setDescricao] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function salvar() {
    setErr(null);
    const v = Number(String(valor).replace(/\./g, '').replace(',', '.'));
    if (!v || v <= 0) {
      setErr('Informe um valor válido.');
      return;
    }
    if (!descricao.trim()) {
      setErr('Informe a descrição.');
      return;
    }
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('tipo', tipo);
      if (tipo === 'ajuste') fd.append('natureza', natureza);
      fd.append('data', data);
      fd.append('valor', String(v));
      fd.append('descricao', descricao.trim());
      if (file) fd.append('file', file);
      const res = await fetch(`${API_URL}/api/financeiro/conta-corrente/lancamentos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAuthToken() || ''}` },
        body: fd,
      });
      if (!res.ok) throw new Error((await res.text()) || 'Falha ao salvar');
      onSaved();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-800">Lançar na conta corrente</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3">
          <div className="flex gap-2">
            <button
              onClick={() => setTipo('pagamento')}
              className={`flex-1 rounded-lg border-2 px-3 py-2 text-sm font-bold ${
                tipo === 'pagamento' ? 'border-emerald-600 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-500'
              }`}
            >
              Pagamento
            </button>
            <button
              onClick={() => setTipo('ajuste')}
              className={`flex-1 rounded-lg border-2 px-3 py-2 text-sm font-bold ${
                tipo === 'ajuste' ? 'border-amber-600 bg-amber-50 text-amber-700' : 'border-slate-200 text-slate-500'
              }`}
            >
              Ajuste
            </button>
          </div>

          {tipo === 'pagamento' ? (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              Pagamento da franqueada — entra como <b>crédito</b> (reduz o saldo devedor).
            </p>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => setNatureza('debito')}
                className={`flex-1 rounded-lg border px-3 py-1.5 text-sm font-semibold ${
                  natureza === 'debito' ? 'border-rose-400 bg-rose-50 text-rose-700' : 'border-slate-200 text-slate-500'
                }`}
              >
                Débito (+ deve)
              </button>
              <button
                onClick={() => setNatureza('credito')}
                className={`flex-1 rounded-lg border px-3 py-1.5 text-sm font-semibold ${
                  natureza === 'credito' ? 'border-emerald-400 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-500'
                }`}
              >
                Crédito (− deve)
              </button>
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-500">Data</label>
            <input
              type="date"
              value={data}
              onChange={(e) => setData(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-500">Valor (R$)</label>
            <input
              type="text"
              inputMode="decimal"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              placeholder="0,00"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-500">Descrição</label>
            <input
              type="text"
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              placeholder="Ex: Pagamento acerto março via PIX"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-500">Documento / comprovante (opcional)</label>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
              <Paperclip className="h-4 w-4" />
              <span className="truncate">{file ? file.name : 'Anexar arquivo (PDF, imagem…)'}</span>
              <input type="file" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </label>
          </div>

          {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}

          <button
            onClick={salvar}
            disabled={saving}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Salvando…' : 'Salvar lançamento'}
          </button>
        </div>
      </div>
    </div>
  );
}
