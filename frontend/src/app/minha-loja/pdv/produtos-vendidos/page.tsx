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
  Store as StoreIcon, AlertCircle, ShoppingCart, TrendingDown, Wallet,
} from 'lucide-react';
import { api } from '@/lib/api';

interface Linha {
  tipo: 'venda' | 'devolucao';
  saleNumber: string | null;
  saleId: string;
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
  customerName: string | null;
  customerCpf: string | null;
  paymentMethod: string | null;
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
                {!loading && data && data.linhas.map((l, idx) => {
                  const isReturn = l.tipo === 'devolucao';
                  const rowClass = isReturn
                    ? 'border-b bg-red-50/40 hover:bg-red-100/60 text-red-700'
                    : 'border-b hover:bg-emerald-50/40';
                  return (
                    <tr key={`${l.saleId}-${l.sku}-${idx}`} className={rowClass}>
                      <td className="px-2 py-1.5 font-mono text-xs whitespace-nowrap">{l.saleNumber ?? '—'}</td>
                      <td className="px-2 py-1.5 text-center text-xs whitespace-nowrap">{fmtDate(l.data)}</td>
                      <td className="px-2 py-1.5 text-center text-xs whitespace-nowrap">{l.hora}</td>
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
                      <td className="px-2 py-1.5 text-xs truncate max-w-[180px]" title={l.customerName ?? ''}>
                        {l.customerName || '—'}
                      </td>
                      <td className="px-2 py-1.5 text-xs whitespace-nowrap">{l.sellerName ?? '—'}</td>
                      <td className="px-2 py-1.5 text-center whitespace-nowrap">
                        <span className="font-mono text-[10px] bg-slate-100 px-1.5 py-0.5 rounded">{l.storeCode}</span>
                      </td>
                    </tr>
                  );
                })}
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
    </div>
  );
}
