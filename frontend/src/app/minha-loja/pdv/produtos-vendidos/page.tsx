'use client';

/**
 * /minha-loja/pdv/produtos-vendidos
 *
 * Tela pra VENDEDORA conferir as vendas do turno (auto-filtra pela loja dela).
 * Vendas + trocas/devoluções (vermelho/negativo) pra conciliacao no fechamento.
 *
 * Existe versao gemea em /retaguarda/produtos-vendidos pra a matriz.
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Search, Loader2, Filter, Download, Calendar,
  Store as StoreIcon, AlertCircle, CheckCircle2, ShoppingCart, TrendingDown, Wallet,
} from 'lucide-react';
import { api } from '@/lib/api';

interface PaymentBreakdown {
  method: string;
  valor: number;
  bandeira?: string | null;
}

interface Linha {
  tipo: 'venda' | 'devolucao';
  saleNumber: string | null;
  saleId: string;
  itemId: string | null;
  data: string;
  hora: string;
  sku: string;
  ref: string | null;
  cor: string | null;
  tamanho: string | null;
  descricao: string;
  qty: number;
  precoUnit: number;
  total: number;
  storeCode: string;
  storeName: string;
  sellerName: string | null;
  sellerOverride?: boolean;
  customerName: string | null;
  customerCpf: string | null;
  paymentMethod: string | null;
  paymentsBreakdown?: PaymentBreakdown[];
  saleTotal?: number;
}

interface ReportResponse {
  linhas: Linha[];
  totais: {
    vendasQtd: number;
    vendasValor: number;
    devolucoesQtd: number;
    devolucoesValor: number;
    liquidoQtd: number;
    liquidoValor: number;
  };
  conciliacao?: {
    totalVendidoLiquido: number;
    totalRecebido: number;
    diferenca: number;
    ok: boolean;
    porModalidade: {
      dinheiro: number;
      pix: number;
      credito: number;
      debito: number;
      crediario: number;
      vale_troca: number;
      outros: number;
    };
    outrosDetalhe?: Array<{ method: string; valor: number; saleId: string }>;
    vendasComDivergencia?: Array<{
      saleId: string;
      saleNumber: string;
      total: number;
      somaPagamentos: number;
      diferenca: number;
    }>;
    // legacy
    totalProdutosVendidos?: number;
  };
  filtros: any;
}

interface StoreOption { id: string; code: string; name: string; }
interface Me { role: string; storeCode?: string | null; storeName?: string | null; }

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function ymd(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fmtDate(iso: string) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('pt-BR'); } catch { return iso; }
}

export default function ProdutosVendidosPage() {
  const hoje = new Date();
  const [me, setMe] = useState<Me | null>(null);
  const [stores, setStores] = useState<StoreOption[]>([]);

  // Filtros
  const [from, setFrom] = useState(ymd(hoje));
  const [to, setTo] = useState(ymd(hoje));
  const [storeCode, setStoreCode] = useState('');
  const [sellerName, setSellerName] = useState('');
  const [sku, setSku] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [includeReturns, setIncludeReturns] = useState(true);

  const [data, setData] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editSeller, setEditSeller] = useState<{ itemId: string; saleId: string; currentName: string; produtoHint: string } | null>(null);

  const isMatrix = me?.role === 'admin' || me?.role === 'operator' || me?.role === 'supervisor';

  useEffect(() => {
    api<Me>('/auth/me').then(setMe).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isMatrix) return;
    api<StoreOption[]>('/stores').then(s => setStores(Array.isArray(s) ? s : [])).catch(() => {});
  }, [isMatrix]);

  const buscar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      if (storeCode) q.set('storeCode', storeCode);
      if (sellerName) q.set('sellerName', sellerName);
      if (sku) q.set('sku', sku);
      if (customerName) q.set('customerName', customerName);
      q.set('includeReturns', includeReturns ? 'true' : 'false');
      const r = await api<ReportResponse>(`/pdv/produtos-vendidos?${q.toString()}`);
      setData(r);
    } catch (e: any) {
      setError(e?.message || String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [from, to, storeCode, sellerName, sku, customerName, includeReturns]);

  useEffect(() => { buscar(); /* eslint-disable-next-line */ }, []);

  function exportarCsv() {
    if (!data || data.linhas.length === 0) return;
    const headers = ['Tipo', 'Venda', 'Data', 'Hora', 'Loja', 'SKU', 'REF', 'Cor', 'Tam', 'Descrição', 'Qtd', 'Preço Unit', 'Total', 'Cliente', 'CPF', 'Vendedora', 'Pgto'];
    const rows = data.linhas.map(l => [
      l.tipo === 'venda' ? 'VENDA' : 'TROCA',
      l.saleNumber ?? '',
      fmtDate(l.data),
      l.hora,
      `${l.storeCode} ${l.storeName}`,
      l.sku,
      l.ref ?? '',
      l.cor ?? '',
      l.tamanho ?? '',
      (l.descricao ?? '').replace(/[\r\n;]/g, ' '),
      l.qty,
      l.precoUnit.toFixed(2).replace('.', ','),
      l.total.toFixed(2).replace('.', ','),
      l.customerName ?? '',
      l.customerCpf ?? '',
      l.sellerName ?? '',
      l.paymentMethod ?? '',
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${c}"`).join(';')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `produtos-vendidos_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b sticky top-0 z-30">
        <div className="max-w-[1600px] mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/minha-loja/pdv" className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-emerald-600 flex items-center justify-center">
            <ShoppingCart className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-black text-slate-800">Produtos Vendidos</h1>
            <p className="text-xs text-slate-500">Vendas + trocas/devoluções (vermelho = negativo)</p>
          </div>
          <button
            onClick={exportarCsv}
            disabled={!data || data.linhas.length === 0}
            className="flex items-center gap-2 px-3 py-2 border border-slate-300 hover:bg-slate-100 text-sm rounded-lg disabled:opacity-40"
          >
            <Download className="w-4 h-4" /> Exportar CSV
          </button>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto p-4 space-y-4">
        {/* Filtros */}
        <section className="bg-white border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-bold text-slate-700">Filtros</h2>
            <label className="ml-auto flex items-center gap-2 text-xs cursor-pointer">
              <input type="checkbox" checked={includeReturns} onChange={e => setIncludeReturns(e.target.checked)} />
              <span>Incluir trocas/devoluções</span>
            </label>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <div>
              <label className="text-xs font-bold uppercase text-slate-600 block mb-1">
                <Calendar className="w-3 h-3 inline mr-1" /> De
              </label>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="w-full border rounded px-2 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-bold uppercase text-slate-600 block mb-1">Até</label>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} className="w-full border rounded px-2 py-2 text-sm" />
            </div>

            {isMatrix && (
              <div className="col-span-2">
                <label className="text-xs font-bold uppercase text-slate-600 block mb-1">
                  <StoreIcon className="w-3 h-3 inline mr-1" /> Loja
                </label>
                <select value={storeCode} onChange={e => setStoreCode(e.target.value)} className="w-full border rounded px-2 py-2 text-sm">
                  <option value="">Todas as lojas</option>
                  {stores.map(s => <option key={s.id} value={s.code}>{s.code} — {s.name}</option>)}
                </select>
              </div>
            )}

            <div>
              <label className="text-xs font-bold uppercase text-slate-600 block mb-1">Vendedora</label>
              <input value={sellerName} onChange={e => setSellerName(e.target.value)} placeholder="ex: MARIA" className="w-full border rounded px-2 py-2 text-sm" />
            </div>

            <div>
              <label className="text-xs font-bold uppercase text-slate-600 block mb-1">SKU/REF/EAN</label>
              <input value={sku} onChange={e => setSku(e.target.value)} placeholder="ex: 5390342" className="w-full border rounded px-2 py-2 text-sm" />
            </div>

            <div className="col-span-2">
              <label className="text-xs font-bold uppercase text-slate-600 block mb-1">Cliente (nome)</label>
              <input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="ex: ROSA MARIA" className="w-full border rounded px-2 py-2 text-sm" />
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <button onClick={buscar} disabled={loading} className="bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2 rounded-lg font-bold text-sm flex items-center gap-2 disabled:opacity-50">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Consultar
            </button>
            {data && <span className="text-xs text-slate-500">{data.linhas.length} linha(s) carregada(s)</span>}
          </div>
        </section>

        {/* Stats */}
        {data && (
          <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
              <div className="text-xs font-bold uppercase text-emerald-700 mb-1 flex items-center gap-1">
                <ShoppingCart className="w-3 h-3" /> Vendas
              </div>
              <div className="text-2xl font-black tabular-nums text-emerald-700">{brl(data.totais.vendasValor)}</div>
              <div className="text-xs text-emerald-600 mt-0.5">{data.totais.vendasQtd} peças</div>
            </div>
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <div className="text-xs font-bold uppercase text-red-700 mb-1 flex items-center gap-1">
                <TrendingDown className="w-3 h-3" /> Devoluções / Trocas
              </div>
              <div className="text-2xl font-black tabular-nums text-red-700">-{brl(data.totais.devolucoesValor)}</div>
              <div className="text-xs text-red-600 mt-0.5">{data.totais.devolucoesQtd} peças</div>
            </div>
            <div className="bg-slate-100 border border-slate-300 rounded-xl p-4">
              <div className="text-xs font-bold uppercase text-slate-700 mb-1 flex items-center gap-1">
                <Wallet className="w-3 h-3" /> Líquido
              </div>
              <div className="text-2xl font-black tabular-nums text-slate-900">{brl(data.totais.liquidoValor)}</div>
              <div className="text-xs text-slate-600 mt-0.5">{data.totais.liquidoQtd} peças</div>
            </div>
          </section>
        )}

        {/* Conciliação: produtos vendidos x modalidades de pagamento */}
        {data && data.conciliacao && (
          <section className={`rounded-xl border-2 p-4 ${data.conciliacao.ok ? 'bg-emerald-50 border-emerald-300' : 'bg-amber-50 border-amber-400'}`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-700 flex items-center gap-2">
                {data.conciliacao.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <AlertCircle className="w-4 h-4 text-amber-600" />}
                Conciliação: vendas × pagamentos
              </h3>
              <span className={`text-xs font-bold px-2 py-1 rounded ${data.conciliacao.ok ? 'bg-emerald-200 text-emerald-800' : 'bg-amber-200 text-amber-900'}`}>
                {data.conciliacao.ok ? '✓ BATE' : '⚠ DIVERGÊNCIA'}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
              <div className="bg-white border rounded p-2.5">
                <div className="text-[10px] text-slate-500 uppercase font-bold">Vendido (líquido)</div>
                <div className="font-mono font-black text-base">{brl(data.conciliacao.totalVendidoLiquido)}</div>
                <div className="text-[9px] text-slate-400 mt-0.5">vendas − devoluções</div>
              </div>
              <div className="bg-white border rounded p-2.5">
                <div className="text-[10px] text-slate-500 uppercase font-bold">Total recebido</div>
                <div className="font-mono font-black text-base text-emerald-700">{brl(data.conciliacao.totalRecebido)}</div>
                <div className="text-[9px] text-slate-400 mt-0.5">dinheiro+pix+cartões+crediário</div>
              </div>
              <div className={`bg-white border rounded p-2.5 ${Math.abs(data.conciliacao.diferenca) > 0.01 ? 'border-amber-400' : ''}`}>
                <div className="text-[10px] text-slate-500 uppercase font-bold">Diferença</div>
                <div className={`font-mono font-black text-base ${data.conciliacao.ok ? 'text-emerald-700' : 'text-amber-700'}`}>
                  {brl(data.conciliacao.diferenca)}
                </div>
                <div className="text-[9px] text-slate-400 mt-0.5">líquido − recebido</div>
              </div>
            </div>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-xs">
              <ModBox label="Dinheiro" valor={data.conciliacao.porModalidade.dinheiro} cor="emerald" />
              <ModBox label="PIX" valor={data.conciliacao.porModalidade.pix} cor="cyan" />
              <ModBox label="Crédito" valor={data.conciliacao.porModalidade.credito} cor="blue" />
              <ModBox label="Débito" valor={data.conciliacao.porModalidade.debito} cor="indigo" />
              <ModBox label="Crediário" valor={data.conciliacao.porModalidade.crediario} cor="rose" />
              <ModBox label="Vale-troca" valor={data.conciliacao.porModalidade.vale_troca || 0} cor="slate" />
            </div>

            {/* ALERTA: methods desconhecidos */}
            {data.conciliacao.porModalidade.outros > 0 && data.conciliacao.outrosDetalhe && data.conciliacao.outrosDetalhe.length > 0 && (
              <div className="mt-3 bg-rose-50 border-2 border-rose-400 rounded-lg p-3">
                <div className="text-xs font-bold text-rose-900 mb-1 flex items-center gap-1">
                  <AlertCircle className="w-4 h-4" /> PAGAMENTOS COM MÉTODO DESCONHECIDO: {brl(data.conciliacao.porModalidade.outros)}
                </div>
                <div className="max-h-32 overflow-y-auto bg-white rounded p-2 text-[11px] font-mono space-y-0.5">
                  {data.conciliacao.outrosDetalhe.map((o, i) => (
                    <div key={i} className="flex justify-between gap-2 border-b border-rose-100 last:border-0 py-0.5">
                      <span className="text-rose-700 font-bold">method: "{o.method}"</span>
                      <span>{brl(o.valor)}</span>
                      <span className="text-slate-400">venda {String(o.saleId).slice(0, 8)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ALERTA: vendas divergentes */}
            {data.conciliacao.vendasComDivergencia && data.conciliacao.vendasComDivergencia.length > 0 && (
              <div className="mt-3 bg-amber-50 border-2 border-amber-400 rounded-lg p-3">
                <div className="text-xs font-bold text-amber-900 mb-1 flex items-center gap-1">
                  <AlertCircle className="w-4 h-4" /> {data.conciliacao.vendasComDivergencia.length} VENDA(S) COM Σ(ITENS) ≠ Σ(PAGAMENTOS)
                </div>
                <div className="max-h-40 overflow-y-auto bg-white rounded p-2 text-[11px] font-mono space-y-0.5">
                  {data.conciliacao.vendasComDivergencia.map((v) => (
                    <div key={v.saleId} className="flex justify-between gap-2 border-b border-amber-100 last:border-0 py-0.5">
                      <span className="font-bold">{v.saleNumber}</span>
                      <span>itens {brl(v.total)}</span>
                      <span>pgto {brl(v.somaPagamentos)}</span>
                      <span className={v.diferenca > 0 ? 'text-rose-700 font-bold' : 'text-emerald-700 font-bold'}>
                        {v.diferenca > 0 ? '+' : ''}{brl(v.diferenca)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 p-3 rounded-lg flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}

        {/* Tabela */}
        <section className="bg-white border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 border-b">
                <tr>
                  <th className="text-left px-2 py-2 font-bold text-slate-700 whitespace-nowrap">Venda</th>
                  <th className="text-center px-2 py-2 font-bold text-slate-700 whitespace-nowrap">Data</th>
                  <th className="text-center px-2 py-2 font-bold text-slate-700 whitespace-nowrap">Hora</th>
                  <th className="text-left px-2 py-2 font-bold text-slate-700 whitespace-nowrap">Código</th>
                  <th className="text-left px-2 py-2 font-bold text-slate-700">Produto</th>
                  <th className="text-center px-2 py-2 font-bold text-slate-700 whitespace-nowrap">Qtd</th>
                  <th className="text-right px-2 py-2 font-bold text-slate-700 whitespace-nowrap">Total</th>
                  <th className="text-left px-2 py-2 font-bold text-slate-700 whitespace-nowrap">Cliente</th>
                  <th className="text-left px-2 py-2 font-bold text-slate-700 whitespace-nowrap">Vendedora</th>
                  <th className="text-center px-2 py-2 font-bold text-slate-700 whitespace-nowrap">Loja</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={10} className="py-12 text-center text-slate-400">
                    <Loader2 className="w-6 h-6 animate-spin inline mr-2" /> Carregando...
                  </td></tr>
                )}
                {!loading && data && data.linhas.length === 0 && (
                  <tr><td colSpan={10} className="py-12 text-center text-slate-400">
                    Nenhuma venda encontrada no período.
                  </td></tr>
                )}
                {!loading && data && (() => {
                  const rows: React.ReactNode[] = [];
                  let lastSaleId: string | null = null;
                  data.linhas.forEach((l, idx) => {
                    const isReturn = l.tipo === 'devolucao';
                    if (l.saleId !== lastSaleId) {
                      lastSaleId = l.saleId;
                      const pmts = l.paymentsBreakdown || [];
                      const itensDessaVenda = data.linhas.filter((x) => x.saleId === l.saleId && x.tipo === l.tipo);
                      const qtdItens = itensDessaVenda.length;
                      const totalItens = itensDessaVenda.reduce((s, x) => s + x.total, 0);
                      rows.push(
                        <tr key={`group-${l.saleId}-${idx}`} className={`border-t-2 ${isReturn ? 'bg-rose-100' : 'bg-slate-100'}`}>
                          <td colSpan={10} className="px-3 py-2">
                            <div className="flex items-center justify-between gap-3 flex-wrap text-xs">
                              <div className="flex items-center gap-2">
                                <span className={`font-mono font-black text-sm ${isReturn ? 'text-rose-800' : 'text-slate-800'}`}>
                                  {isReturn ? '↩ DEVOLUÇÃO' : '🧾 VENDA'} #{l.saleNumber || String(l.saleId).slice(0, 8)}
                                </span>
                                <span className="text-slate-500">·</span>
                                <span className="text-slate-700">{fmtDate(l.data)} {l.hora}</span>
                                {l.customerName && (<><span className="text-slate-500">·</span><span className="font-bold text-slate-700">{l.customerName}</span></>)}
                                {l.sellerName && (<><span className="text-slate-500">·</span><span className="text-slate-600">vend. <b>{l.sellerName}</b></span></>)}
                                <span className="text-slate-500">·</span>
                                <span className="text-slate-600">{qtdItens} {qtdItens === 1 ? 'item' : 'itens'} · <b>{brl(totalItens)}</b></span>
                              </div>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                {!isReturn && pmts.length > 0 ? (
                                  pmts.map((p, i) => {
                                    const colors: Record<string, string> = {
                                      dinheiro: 'bg-emerald-100 text-emerald-800 border-emerald-300',
                                      pix: 'bg-cyan-100 text-cyan-800 border-cyan-300',
                                      credito: 'bg-blue-100 text-blue-800 border-blue-300',
                                      debito: 'bg-indigo-100 text-indigo-800 border-indigo-300',
                                      crediario: 'bg-rose-100 text-rose-800 border-rose-300',
                                      vale_troca: 'bg-slate-200 text-slate-800 border-slate-300',
                                    };
                                    const cls = colors[p.method] || 'bg-amber-100 text-amber-800 border-amber-300';
                                    return (
                                      <span key={i} className={`text-[10px] font-bold px-2 py-0.5 rounded border ${cls}`}>
                                        {p.method.toUpperCase().replace('_', ' ')}
                                        {p.bandeira && <span className="ml-1 opacity-80">{p.bandeira}</span>}
                                        <span className="ml-1 font-mono">{brl(p.valor)}</span>
                                      </span>
                                    );
                                  })
                                ) : isReturn ? (
                                  <span className="text-[10px] font-bold text-rose-700">SAÍDA DO ESTOQUE</span>
                                ) : (
                                  <span className="text-[10px] text-amber-700 font-bold">⚠ SEM PAGAMENTO REGISTRADO</span>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    }
                    const rowClass = isReturn
                      ? 'border-b border-rose-100 bg-red-50/40 hover:bg-red-100/60 text-red-700'
                      : 'border-b border-slate-100 hover:bg-emerald-50/40';
                    rows.push(
                      <tr key={`${l.saleId}-${l.sku}-${idx}`} className={rowClass}>
                        <td className="px-2 py-1.5 font-mono text-xs whitespace-nowrap pl-6 text-slate-400">↳</td>
                        <td className="px-2 py-1.5 text-center text-xs whitespace-nowrap"></td>
                        <td className="px-2 py-1.5 text-center text-xs whitespace-nowrap"></td>
                        <td className="px-2 py-1.5 font-mono text-xs whitespace-nowrap">{l.sku}</td>
                        <td className="px-2 py-1.5 text-xs">
                          <div className="font-bold truncate max-w-[280px]" title={l.descricao}>{l.descricao}</div>
                          {(l.ref || l.cor || l.tamanho) && (
                            <div className="text-[10px] text-slate-500">
                              {l.ref && <span>{l.ref}</span>}
                              {l.cor && <span> · {l.cor}</span>}
                              {l.tamanho && <span> · {l.tamanho}</span>}
                            </div>
                          )}
                        </td>
                        <td className={`px-2 py-1.5 text-center font-bold tabular-nums whitespace-nowrap ${isReturn ? 'text-red-700' : ''}`}>
                          {l.qty}
                        </td>
                        <td className={`px-2 py-1.5 text-right font-bold tabular-nums whitespace-nowrap ${isReturn ? 'text-red-700' : 'text-emerald-700'}`}>
                          {brl(l.total)}
                        </td>
                        <td className="px-2 py-1.5 text-xs truncate max-w-[180px]"><span className="text-slate-400">—</span></td>
                        <td className="px-2 py-1.5 text-xs whitespace-nowrap">
                          <span className={l.sellerOverride ? 'font-bold text-violet-700' : ''}>
                            {l.sellerOverride ? l.sellerName : '—'}
                          </span>
                          {!isReturn && l.itemId && isMatrix && (
                            <button
                              onClick={() => setEditSeller({
                                itemId: l.itemId!,
                                saleId: l.saleId,
                                currentName: l.sellerName || '',
                                produtoHint: `${l.ref || l.sku} ${l.cor || ''} ${l.tamanho || ''}`.trim(),
                              })}
                              className="ml-1 text-[10px] text-violet-600 hover:text-violet-900 underline font-bold"
                              title="Editar vendedora (master)"
                            >
                              ✎
                            </button>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-center whitespace-nowrap">
                          <span className="font-mono text-[10px] bg-slate-100 px-1.5 py-0.5 rounded">{l.storeCode}</span>
                        </td>
                      </tr>
                    );
                  });
                  return rows;
                })()}
              </tbody>
              {!loading && data && data.linhas.length > 0 && (
                <tfoot className="bg-slate-100 border-t-2">
                  <tr>
                    <td colSpan={5} className="px-2 py-2.5 text-right font-bold text-slate-700">TOTAL LÍQUIDO</td>
                    <td className="px-2 py-2.5 text-center font-bold tabular-nums">{data.totais.liquidoQtd}</td>
                    <td className="px-2 py-2.5 text-right font-bold tabular-nums">{brl(data.totais.liquidoValor)}</td>
                    <td colSpan={3}></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </section>
      </main>

      {editSeller && (
        <EditSellerModal
          itemId={editSeller.itemId}
          saleId={editSeller.saleId}
          currentName={editSeller.currentName}
          produtoHint={editSeller.produtoHint}
          onClose={() => setEditSeller(null)}
          onSaved={() => { setEditSeller(null); buscar(); }}
        />
      )}
    </div>
  );
}

function EditSellerModal({
  itemId, saleId, currentName, produtoHint, onClose, onSaved,
}: {
  itemId: string;
  saleId: string;
  currentName: string;
  produtoHint: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [scope, setScope] = useState<'item' | 'sale'>('item');
  const [novoNome, setNovoNome] = useState(currentName);
  const [motivo, setMotivo] = useState('');
  const [password, setPassword] = useState<string>(() => {
    try { return sessionStorage.getItem('flowops.masterPwd') || ''; } catch { return ''; }
  });
  const [savePwd, setSavePwd] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function save() {
    setErrMsg(null);
    const nome = novoNome.trim().toUpperCase();
    if (!nome || nome.length < 2) { setErrMsg('Nome invalido'); return; }
    if (!motivo || motivo.trim().length < 3) { setErrMsg('Motivo obrigatorio'); return; }
    if (!password) { setErrMsg('Senha obrigatoria'); return; }
    setSaving(true);
    try {
      const url = scope === 'item'
        ? `/pdv/caixa/master/sale-item/${itemId}/seller`
        : `/pdv/caixa/master/sale/${saleId}/seller`;
      await api(url, {
        method: 'PATCH',
        body: JSON.stringify({
          sellerName: nome,
          motivo: motivo.trim(),
          password,
        }),
      });
      if (savePwd) {
        try { sessionStorage.setItem('flowops.masterPwd', password); } catch {}
      }
      onSaved();
    } catch (e: any) {
      setErrMsg(e?.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[9998] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-lg font-black text-slate-900">👤 Editar Vendedora</h3>
            <p className="text-xs text-slate-500 truncate max-w-[280px]">{produtoHint}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        {/* Escopo */}
        <div className="flex gap-1 mb-4 bg-slate-100 rounded-lg p-1">
          <button
            onClick={() => setScope('item')}
            className={`flex-1 py-2 text-xs font-bold rounded transition ${scope === 'item' ? 'bg-white text-violet-700 shadow' : 'text-slate-600'}`}
          >
            ✂️ Só esta peça
          </button>
          <button
            onClick={() => setScope('sale')}
            className={`flex-1 py-2 text-xs font-bold rounded transition ${scope === 'sale' ? 'bg-white text-violet-700 shadow' : 'text-slate-600'}`}
          >
            🧾 Venda inteira
          </button>
        </div>

        <label className="block text-xs font-bold text-slate-700 mb-1">Nova vendedora *</label>
        <input
          type="text"
          value={novoNome}
          onChange={(e) => setNovoNome(e.target.value.toUpperCase())}
          placeholder="ex: MARIA SILVA"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-3 font-medium uppercase focus:outline-none focus:ring-2 focus:ring-violet-500"
        />

        <label className="block text-xs font-bold text-slate-700 mb-1">Motivo *</label>
        <input
          type="text"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="ex: dividir comissao entre duas vendedoras"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-violet-500"
        />

        <label className="block text-xs font-bold text-slate-700 mb-1">Senha (GERENTE ou superior)</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="senha"
          autoComplete="current-password"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-2 font-mono focus:outline-none focus:ring-2 focus:ring-violet-500"
        />
        <label className="flex items-center gap-2 text-[11px] text-slate-600 mb-3 cursor-pointer">
          <input type="checkbox" checked={savePwd} onChange={(e) => setSavePwd(e.target.checked)} />
          Lembrar senha nesta sessao
        </label>

        {errMsg && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded p-2 mb-3">{errMsg}</div>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={saving}
            className="px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 rounded-lg disabled:opacity-40">
            Cancelar
          </button>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 text-sm font-bold text-white bg-violet-600 hover:bg-violet-700 rounded-lg disabled:opacity-40">
            {saving ? 'Salvando...' : 'Confirmar'}
          </button>
        </div>

        <p className="mt-3 text-[10px] text-slate-400 leading-tight">
          {scope === 'item'
            ? '⚠️ Override apenas nesta peça. Outras peças da mesma venda permanecem com a vendedora original.'
            : '⚠️ Atualiza a vendedora da venda inteira e limpa overrides individuais.'}
        </p>
      </div>
    </div>
  );
}

function ModBox({ label, valor, cor }: { label: string; valor: number; cor: 'emerald' | 'cyan' | 'blue' | 'indigo' | 'rose' | 'slate' }) {
  const tones: Record<string, string> = {
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    cyan: 'bg-cyan-50 border-cyan-200 text-cyan-700',
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-700',
    rose: 'bg-rose-50 border-rose-200 text-rose-700',
    slate: 'bg-slate-50 border-slate-200 text-slate-700',
  };
  return (
    <div className={`border rounded p-2 ${tones[cor]}`}>
      <div className="text-[9px] font-bold uppercase opacity-80">{label}</div>
      <div className="font-mono font-black text-xs">R$ {valor.toFixed(2).replace('.', ',')}</div>
    </div>
  );
}
