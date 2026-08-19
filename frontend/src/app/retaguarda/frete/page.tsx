'use client';

/**
 * /retaguarda/frete — Gestão › FRETE
 *
 * Todos os SEDEX/PAC postados no período (pra CLIENTE e ENTRE LOJAS) com o
 * frete COBRADO da cliente × o frete PAGO ao transportador (Correios / Mais
 * Envios). Filtro De/Até + atalhos, tipo, loja de origem, exportação CSV.
 *
 * "Pago" vem do custo capturado na geração da etiqueta (desde 19/08). Envio
 * antigo sem valor: botão "Estimar pendentes" recota o preço de HOJE (marcado
 * como estimado) — ou a matriz digita o valor da fatura clicando na célula.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Truck, RefreshCw, Loader2, Download, Calculator, Pencil, AlertTriangle, Check, X } from 'lucide-react';
import { api } from '@/lib/api';

type Row = {
  kind: 'pick' | 'remessa';
  id: string;
  data: string;
  tipo: 'cliente' | 'loja';
  origemStoreCode: string | null;
  origemStoreName: string | null;
  destino: string;
  destinoUf: string | null;
  referencia: string;
  canal: string;
  servico: 'SEDEX' | 'PAC' | null;
  transportador: 'Correios' | 'Mais Envios' | null;
  carrier: string | null;
  trackingCode: string | null;
  pecas: number;
  cobradoCents: number | null;
  cobradoDuplicado: boolean;
  pagoCents: number | null;
  pagoOrigem: string | null;
  pagoEm: string | null;
};
type Block = { envios: number; pecas: number; cobradoCents: number; pagoCents: number; semPago: number; semCobrado: number; estimados: number };
type Report = {
  from: string; to: string; tipo: string; storeCode: string | null;
  totais: { geral: Block; cliente: Block; loja: Block };
  porLoja: Array<Block & { storeCode: string; storeName: string }>;
  porServico: Array<Block & { label: string }>;
  rows: Row[];
};

const brl = (cents: number | null | undefined) =>
  cents == null ? '—' : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const toInputDate = (d: Date) => {
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};
const fmtData = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const CANAL_LABEL: Record<string, string> = {
  site: 'Site (WC)', ecommerce: 'Site', loja: 'Site', live: 'Live', pdv_online: 'PDV online',
  transferencia: 'Transferência', realinhamento: 'Realinhamento',
};

function Kpi({ label, value, sub, tone = 'slate' }: { label: string; value: string; sub?: string; tone?: 'slate' | 'green' | 'rose' | 'amber' | 'sky' }) {
  const tones: Record<string, string> = {
    slate: 'border-slate-200 bg-white', green: 'border-emerald-200 bg-emerald-50', rose: 'border-rose-200 bg-rose-50',
    amber: 'border-amber-200 bg-amber-50', sky: 'border-sky-200 bg-sky-50',
  };
  return (
    <div className={`rounded-xl border px-4 py-3 ${tones[tone]}`}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-xl font-semibold text-slate-800">{value}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function FretePage() {
  const router = useRouter();
  const now = new Date();
  const [from, setFrom] = useState(toInputDate(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(toInputDate(now));
  const [tipo, setTipo] = useState<'all' | 'cliente' | 'loja'>('all');
  const [storeCode, setStoreCode] = useState('');
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [recotando, setRecotando] = useState(false);
  const [recotaMsg, setRecotaMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key: string; valor: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErro(null);
    try {
      const qs = new URLSearchParams({
        from: new Date(`${from}T00:00:00`).toISOString(),
        to: new Date(`${to}T23:59:59`).toISOString(),
        tipo,
        ...(storeCode ? { storeCode } : {}),
      });
      setData(await api<Report>(`/frete/report?${qs.toString()}`));
    } catch (e: any) {
      if (e?.status === 401) { router.push('/login'); return; }
      setErro(e?.message || 'Falha ao carregar');
    } finally { setLoading(false); }
  }, [from, to, tipo, storeCode, router]);

  useEffect(() => { load(); }, [load]);

  const atalho = (k: 'hoje' | 'ontem' | '7d' | 'mes' | 'mesAnt') => {
    const d = new Date();
    if (k === 'hoje') { setFrom(toInputDate(d)); setTo(toInputDate(d)); }
    if (k === 'ontem') { const y = new Date(d); y.setDate(d.getDate() - 1); setFrom(toInputDate(y)); setTo(toInputDate(y)); }
    if (k === '7d') { const y = new Date(d); y.setDate(d.getDate() - 6); setFrom(toInputDate(y)); setTo(toInputDate(d)); }
    if (k === 'mes') { setFrom(toInputDate(new Date(d.getFullYear(), d.getMonth(), 1))); setTo(toInputDate(d)); }
    if (k === 'mesAnt') { setFrom(toInputDate(new Date(d.getFullYear(), d.getMonth() - 1, 1))); setTo(toInputDate(new Date(d.getFullYear(), d.getMonth(), 0))); }
  };

  const recotar = async () => {
    setRecotando(true); setRecotaMsg(null);
    try {
      const r = await api<{ feitos: number; falhas: number; pendentes: number }>('/frete/recotar', {
        method: 'POST',
        body: JSON.stringify({ from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T23:59:59`).toISOString(), limit: 25 }),
      });
      setRecotaMsg(`${r.feitos} estimados · ${r.falhas} sem cotação · ${r.pendentes} ainda pendentes${r.pendentes > 0 ? ' (clique de novo pra continuar)' : ''}`);
      await load();
    } catch (e: any) { setRecotaMsg(e?.message || 'Falha ao recotar'); }
    finally { setRecotando(false); }
  };

  const salvarPago = async (row: Row, valor: string) => {
    const n = valor.trim() === '' ? null : Number(valor.replace(/\./g, '').replace(',', '.'));
    if (n != null && !Number.isFinite(n)) { alert('Valor inválido'); return; }
    try {
      await api(`/frete/${row.kind}/${row.id}/pago`, { method: 'PATCH', body: JSON.stringify({ valorReais: n }) });
      setEditing(null);
      await load();
    } catch (e: any) { alert(e?.message || 'Falha ao salvar'); }
  };

  const lojas = useMemo(() => {
    const m = new Map<string, string>();
    (data?.porLoja || []).forEach((l) => m.set(l.storeCode, l.storeName));
    return [...m.entries()];
  }, [data]);

  const exportCSV = () => {
    if (!data) return;
    const head = ['Data', 'Tipo', 'Origem', 'Destino', 'UF', 'Referência', 'Canal', 'Transportador', 'Serviço', 'Rastreio', 'Peças', 'Cobrado (R$)', 'Pago (R$)', 'Origem do pago', 'Diferença (R$)'];
    const num = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
    const lines = data.rows.map((r) => [
      fmtData(r.data), r.tipo === 'cliente' ? 'Cliente' : 'Entre lojas', r.origemStoreName || r.origemStoreCode || '', r.destino, r.destinoUf || '',
      r.referencia, CANAL_LABEL[r.canal] || r.canal, r.transportador || '', r.servico || '', r.trackingCode || '', String(r.pecas),
      r.cobradoDuplicado ? '' : num(r.cobradoCents), num(r.pagoCents), r.pagoOrigem || '',
      r.cobradoCents != null && r.pagoCents != null && !r.cobradoDuplicado ? num(r.cobradoCents - r.pagoCents) : '',
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';'));
    const csv = '﻿' + [head.join(';'), ...lines].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `frete_${from}_${to}.csv`;
    a.click();
  };

  const g = data?.totais.geral;
  const diff = g ? g.cobradoCents - g.pagoCents : 0;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex items-center gap-3 mb-5">
          <Link href="/retaguarda" className="p-2 rounded-lg hover:bg-slate-200 transition-colors"><ArrowLeft size={20} /></Link>
          <Truck size={22} className="text-sky-600" />
          <div className="flex-1">
            <h1 className="text-xl font-semibold">Frete</h1>
            <p className="text-xs text-slate-500">SEDEX/PAC postados pra clientes e entre lojas — o que a cliente pagou × o que a loja paga ao transportador</p>
          </div>
          <button onClick={exportCSV} disabled={!data?.rows.length} className="text-xs px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 flex items-center gap-1 disabled:opacity-40">
            <Download size={14} /> CSV
          </button>
        </div>

        {/* Filtros */}
        <section className="bg-white rounded-xl border border-slate-200 p-4 mb-4 flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-500">De
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="block mt-1 border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
          </label>
          <label className="text-xs text-slate-500">Até
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="block mt-1 border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
          </label>
          <div className="flex gap-1">
            {([['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7d', '7 dias'], ['mes', 'Mês'], ['mesAnt', 'Mês anterior']] as const).map(([k, l]) => (
              <button key={k} onClick={() => atalho(k)} className="text-xs px-2 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100">{l}</button>
            ))}
          </div>
          <label className="text-xs text-slate-500">Tipo
            <select value={tipo} onChange={(e) => setTipo(e.target.value as any)} className="block mt-1 border border-slate-300 rounded-lg px-2 py-1.5 text-sm bg-white">
              <option value="all">Todos</option>
              <option value="cliente">Pra cliente</option>
              <option value="loja">Entre lojas</option>
            </select>
          </label>
          <label className="text-xs text-slate-500">Loja de origem
            <select value={storeCode} onChange={(e) => setStoreCode(e.target.value)} className="block mt-1 border border-slate-300 rounded-lg px-2 py-1.5 text-sm bg-white min-w-[160px]">
              <option value="">Todas</option>
              {lojas.map(([c, n]) => <option key={c} value={c}>{n} ({c})</option>)}
            </select>
          </label>
          <button onClick={load} className="text-xs px-3 py-2 rounded-lg bg-sky-600 text-white hover:bg-sky-700 flex items-center gap-1">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Atualizar
          </button>
        </section>

        {erro && <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{erro}</div>}

        {/* KPIs */}
        {g && (
          <section className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            <Kpi label="Envios" value={String(g.envios)} sub={`${data!.totais.cliente.envios} cliente · ${data!.totais.loja.envios} entre lojas · ${g.pecas} peças`} />
            <Kpi label="Cobrado das clientes" value={brl(g.cobradoCents)} sub={g.semCobrado ? `${g.semCobrado} sem valor (pedido antigo)` : 'todos com valor'} tone="green" />
            <Kpi label="Pago ao transportador" value={brl(g.pagoCents)} sub={g.semPago ? `${g.semPago} sem custo ainda` : g.estimados ? `${g.estimados} estimados` : 'todos capturados'} tone={g.semPago ? 'amber' : 'sky'} />
            <Kpi label="Cobrado − pago" value={brl(diff)} sub={g.semPago ? 'parcial: faltam custos' : 'só envios pra cliente têm cobrado'} tone={diff < 0 ? 'rose' : 'slate'} />
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 flex flex-col justify-between">
              <div className="text-[11px] uppercase tracking-wide text-slate-500">Custos pendentes</div>
              <button onClick={recotar} disabled={recotando || !g.semPago} className="mt-1 text-xs px-2 py-1.5 rounded-lg border border-amber-300 bg-amber-50 hover:bg-amber-100 flex items-center gap-1 disabled:opacity-40">
                {recotando ? <Loader2 size={13} className="animate-spin" /> : <Calculator size={13} />} Estimar pendentes ({g.semPago})
              </button>
              {recotaMsg && <div className="text-[10px] text-slate-500 mt-1">{recotaMsg}</div>}
            </div>
          </section>
        )}

        {/* Resumos */}
        {data && data.rows.length > 0 && (
          <section className="grid md:grid-cols-2 gap-3 mb-4">
            <div className="bg-white rounded-xl border border-slate-200 p-3">
              <h2 className="text-sm font-medium mb-2">Por loja de origem</h2>
              <table className="w-full text-xs">
                <thead><tr className="text-slate-500 text-left"><th className="py-1">Loja</th><th className="text-right">Envios</th><th className="text-right">Cobrado</th><th className="text-right">Pago</th><th className="text-right">Dif.</th></tr></thead>
                <tbody>
                  {data.porLoja.map((l) => (
                    <tr key={l.storeCode} className="border-t border-slate-100">
                      <td className="py-1">{l.storeName} <span className="text-slate-400">({l.storeCode})</span></td>
                      <td className="text-right">{l.envios}</td>
                      <td className="text-right text-emerald-700">{brl(l.cobradoCents)}</td>
                      <td className="text-right">{brl(l.pagoCents)}{l.semPago ? <span className="text-amber-600"> ({l.semPago}?)</span> : null}</td>
                      <td className={`text-right ${l.cobradoCents - l.pagoCents < 0 ? 'text-rose-600' : ''}`}>{brl(l.cobradoCents - l.pagoCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-3">
              <h2 className="text-sm font-medium mb-2">Por transportador × serviço</h2>
              <table className="w-full text-xs">
                <thead><tr className="text-slate-500 text-left"><th className="py-1">Serviço</th><th className="text-right">Envios</th><th className="text-right">Cobrado</th><th className="text-right">Pago</th><th className="text-right">Dif.</th></tr></thead>
                <tbody>
                  {data.porServico.map((l) => (
                    <tr key={l.label} className="border-t border-slate-100">
                      <td className="py-1">{l.label}</td>
                      <td className="text-right">{l.envios}</td>
                      <td className="text-right text-emerald-700">{brl(l.cobradoCents)}</td>
                      <td className="text-right">{brl(l.pagoCents)}{l.semPago ? <span className="text-amber-600"> ({l.semPago}?)</span> : null}</td>
                      <td className={`text-right ${l.cobradoCents - l.pagoCents < 0 ? 'text-rose-600' : ''}`}>{brl(l.cobradoCents - l.pagoCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Lista */}
        <section className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-xs min-w-[1000px]">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-3 py-2">Data</th>
                <th className="px-3 py-2">Tipo</th>
                <th className="px-3 py-2">Origem</th>
                <th className="px-3 py-2">Destino</th>
                <th className="px-3 py-2">Ref.</th>
                <th className="px-3 py-2">Canal</th>
                <th className="px-3 py-2">Serviço</th>
                <th className="px-3 py-2">Rastreio</th>
                <th className="px-3 py-2 text-right">Peças</th>
                <th className="px-3 py-2 text-right">Cobrado</th>
                <th className="px-3 py-2 text-right">Pago</th>
                <th className="px-3 py-2 text-right">Dif.</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data && <tr><td colSpan={12} className="px-3 py-6 text-center text-slate-400"><Loader2 size={16} className="animate-spin inline" /> Carregando…</td></tr>}
              {data && data.rows.length === 0 && <tr><td colSpan={12} className="px-3 py-6 text-center text-slate-400">Nenhum envio com etiqueta no período.</td></tr>}
              {data?.rows.map((r) => {
                const key = `${r.kind}:${r.id}`;
                const isEd = editing?.key === key;
                const dif = r.cobradoCents != null && r.pagoCents != null && !r.cobradoDuplicado ? r.cobradoCents - r.pagoCents : null;
                return (
                  <tr key={key} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-1.5 whitespace-nowrap">{fmtData(r.data)}</td>
                    <td className="px-3 py-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${r.tipo === 'cliente' ? 'bg-emerald-50 text-emerald-700' : 'bg-sky-50 text-sky-700'}`}>
                        {r.tipo === 'cliente' ? 'Cliente' : 'Entre lojas'}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">{r.origemStoreName || r.origemStoreCode || '—'}</td>
                    <td className="px-3 py-1.5">{r.destino}{r.destinoUf ? <span className="text-slate-400"> · {r.destinoUf}</span> : null}</td>
                    <td className="px-3 py-1.5 font-mono">{r.referencia}</td>
                    <td className="px-3 py-1.5">{CANAL_LABEL[r.canal] || r.canal}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{r.transportador || '?'} <b>{r.servico || '?'}</b></td>
                    <td className="px-3 py-1.5 font-mono text-[11px]">{r.trackingCode || '—'}</td>
                    <td className="px-3 py-1.5 text-right">{r.pecas}</td>
                    <td className="px-3 py-1.5 text-right text-emerald-700">
                      {r.tipo === 'loja' ? <span className="text-slate-300">—</span>
                        : r.cobradoCents == null ? <span className="text-slate-400" title="Pedido antigo do WooCommerce não guarda o valor do frete">?</span>
                        : r.cobradoDuplicado ? <span className="text-slate-400" title="Pedido dividido: frete já contado na outra caixa">({brl(r.cobradoCents)})</span>
                        : brl(r.cobradoCents)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {isEd ? (
                        <span className="inline-flex items-center gap-1">
                          <input autoFocus value={editing!.valor} onChange={(e) => setEditing({ key, valor: e.target.value })}
                            onKeyDown={(e) => { if (e.key === 'Enter') salvarPago(r, editing!.valor); if (e.key === 'Escape') setEditing(null); }}
                            className="w-20 border border-slate-300 rounded px-1 py-0.5 text-right" placeholder="0,00" />
                          <button onClick={() => salvarPago(r, editing!.valor)} className="text-emerald-600"><Check size={14} /></button>
                          <button onClick={() => setEditing(null)} className="text-slate-400"><X size={14} /></button>
                        </span>
                      ) : (
                        <button onClick={() => setEditing({ key, valor: r.pagoCents != null ? (r.pagoCents / 100).toFixed(2).replace('.', ',') : '' })}
                          className="inline-flex items-center gap-1 hover:underline" title={r.pagoOrigem === 'recotacao' ? 'Estimado (preço de hoje) — clique pra digitar o valor da fatura' : r.pagoOrigem === 'manual' ? 'Digitado da fatura' : r.pagoOrigem === 'cotacao' ? 'Cotado na geração da etiqueta' : 'Sem custo — clique pra digitar'}>
                          {r.pagoCents == null ? <span className="text-amber-600 inline-flex items-center gap-0.5"><AlertTriangle size={11} /> —</span> : brl(r.pagoCents)}
                          {r.pagoOrigem === 'recotacao' && <span className="text-[9px] text-amber-600">est.</span>}
                          {r.pagoOrigem === 'manual' && <span className="text-[9px] text-slate-400">fat.</span>}
                          <Pencil size={10} className="text-slate-300" />
                        </button>
                      )}
                    </td>
                    <td className={`px-3 py-1.5 text-right ${dif != null && dif < 0 ? 'text-rose-600 font-medium' : ''}`}>{dif == null ? '—' : brl(dif)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
        <p className="text-[11px] text-slate-400 mt-3">
          Cobrado = frete pago pela cliente no checkout (site novo / live). Pedidos antigos do WooCommerce não guardam esse valor (mostram “?”).
          Pago = custo do transportador capturado na geração da etiqueta; “est.” = recotado hoje; “fat.” = digitado da fatura.
        </p>
      </div>
    </div>
  );
}
