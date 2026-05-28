'use client';

/**
 * /retaguarda/saidas-site
 *
 * Relatório: peças que cada LOJA cedeu pro SITE (pedidos WooCommerce).
 * Filtros: loja, ref, tamanho, cor, período.
 *
 * Mostra: SKU, REF, cor, tamanho, descrição, qtd, valor, pedidos, datas.
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Search, Loader2, Filter, X, Store as StoreIcon, Download,
  Package, Calendar, AlertCircle, CheckCircle2,
} from 'lucide-react';
import { api } from '@/lib/api';

interface Linha {
  sku: string;
  ref: string | null;
  cor: string | null;
  tamanho: string | null;
  descricao: string | null;
  productName: string | null;
  storeCode: string;
  storeName: string;
  qtd: number;
  valor: number;
  pedidos: number;
  primeiraSaida: string;
  ultimaSaida: string;
}

interface RelatorioResponse {
  linhas: Linha[];
  totalGeralQtd: number;
  totalGeralValor: number;
  totalGeralPedidos: number;
  filtrosAplicados: any;
}

interface StoreOption {
  id: string;
  code: string;
  name: string;
}

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtDate = (iso: string) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('pt-BR');
  } catch {
    return iso;
  }
};

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function SaidasSitePage() {
  // Default: últimos 30 dias
  const hoje = new Date();
  const trinta = new Date();
  trinta.setDate(trinta.getDate() - 30);

  const [stores, setStores] = useState<StoreOption[]>([]);
  const [storeCode, setStoreCode] = useState<string>('');
  const [ref, setRef] = useState('');
  const [tamanho, setTamanho] = useState('');
  const [cor, setCor] = useState('');
  const [from, setFrom] = useState<string>(ymd(trinta));
  const [to, setTo] = useState<string>(ymd(hoje));
  const [status, setStatus] = useState('shipped,delivered');

  const [data, setData] = useState<RelatorioResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Carrega lojas (1x)
  useEffect(() => {
    api<StoreOption[]>('/stores')
      .then((s) => setStores(Array.isArray(s) ? s : []))
      .catch(() => {});
  }, []);

  const buscar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (storeCode) q.set('storeCode', storeCode);
      if (ref) q.set('ref', ref);
      if (tamanho) q.set('tamanho', tamanho);
      if (cor) q.set('cor', cor);
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      if (status) q.set('status', status);

      const r = await api<RelatorioResponse>(`/reports/site-saidas?${q.toString()}`);
      setData(r);
    } catch (e: any) {
      setError(e?.message || String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [storeCode, ref, tamanho, cor, from, to, status]);

  // Carrega ao montar
  useEffect(() => {
    buscar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function limparFiltros() {
    setStoreCode('');
    setRef('');
    setTamanho('');
    setCor('');
    setFrom(ymd(trinta));
    setTo(ymd(hoje));
    setStatus('shipped,delivered');
  }

  function exportarCsv() {
    if (!data || data.linhas.length === 0) return;
    const headers = ['Loja', 'Código', 'SKU', 'REF', 'Cor', 'Tamanho', 'Descrição', 'Qtd', 'Valor', 'Pedidos', 'Primeira saída', 'Última saída'];
    const rows = data.linhas.map((l) => [
      l.storeName,
      l.storeCode,
      l.sku,
      l.ref ?? '',
      l.cor ?? '',
      l.tamanho ?? '',
      (l.descricao ?? l.productName ?? '').replace(/[\r\n;]/g, ' '),
      l.qtd,
      l.valor.toFixed(2).replace('.', ','),
      l.pedidos,
      fmtDate(l.primeiraSaida),
      fmtDate(l.ultimaSaida),
    ]);
    const csv = [headers, ...rows].map((r) => r.map((c) => `"${c}"`).join(';')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `saidas-site_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-[1600px] mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center">
            <Package className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-black text-slate-800">Saídas pro Site</h1>
            <p className="text-xs text-slate-500">Peças que cada loja cedeu pra pedidos do site (WooCommerce)</p>
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
        <section className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-bold text-slate-700">Filtros</h2>
            <button onClick={limparFiltros} className="ml-auto text-xs text-slate-500 hover:text-red-600">
              Limpar filtros
            </button>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            {/* Loja */}
            <div className="col-span-2">
              <label className="text-xs font-bold text-slate-600 uppercase block mb-1">
                <StoreIcon className="w-3 h-3 inline mr-1" /> Loja que cedeu
              </label>
              <select
                value={storeCode}
                onChange={(e) => setStoreCode(e.target.value)}
                className="w-full border rounded px-2 py-2 text-sm"
              >
                <option value="">Todas as lojas</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.code}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </select>
            </div>

            {/* REF */}
            <div className="col-span-2">
              <label className="text-xs font-bold text-slate-600 uppercase block mb-1">REF / Descrição</label>
              <input
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="ex: BRASIL ROYAL"
                className="w-full border rounded px-2 py-2 text-sm"
              />
            </div>

            {/* Tamanho */}
            <div>
              <label className="text-xs font-bold text-slate-600 uppercase block mb-1">Tamanho</label>
              <input
                value={tamanho}
                onChange={(e) => setTamanho(e.target.value)}
                placeholder="ex: 54"
                className="w-full border rounded px-2 py-2 text-sm"
              />
            </div>

            {/* Cor */}
            <div>
              <label className="text-xs font-bold text-slate-600 uppercase block mb-1">Cor</label>
              <input
                value={cor}
                onChange={(e) => setCor(e.target.value)}
                placeholder="ex: AZUL"
                className="w-full border rounded px-2 py-2 text-sm"
              />
            </div>

            {/* From */}
            <div>
              <label className="text-xs font-bold text-slate-600 uppercase block mb-1">
                <Calendar className="w-3 h-3 inline mr-1" /> De
              </label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-full border rounded px-2 py-2 text-sm"
              />
            </div>

            {/* To */}
            <div>
              <label className="text-xs font-bold text-slate-600 uppercase block mb-1">Até</label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-full border rounded px-2 py-2 text-sm"
              />
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={buscar}
              disabled={loading}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-lg font-bold text-sm flex items-center gap-2 disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Buscar
            </button>
            <span className="text-xs text-slate-500">
              Status considerados: <code className="bg-slate-100 px-1 py-0.5 rounded">{status}</code>
            </span>
          </div>
        </section>

        {/* Stats consolidadas */}
        {data && (
          <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <StatCard label="Total de peças cedidas" value={data.totalGeralQtd.toLocaleString('pt-BR')} cor="emerald" />
            <StatCard label="Valor total" value={brl(data.totalGeralValor)} cor="indigo" />
            <StatCard label="Pedidos distintos" value={data.totalGeralPedidos.toLocaleString('pt-BR')} cor="violet" />
          </section>
        )}

        {/* Erro */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 p-3 rounded-lg flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}

        {/* Tabela */}
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 border-b">
                <tr>
                  <th className="text-left px-3 py-2.5 font-bold text-slate-700 whitespace-nowrap">Loja</th>
                  <th className="text-left px-3 py-2.5 font-bold text-slate-700 whitespace-nowrap">SKU</th>
                  <th className="text-left px-3 py-2.5 font-bold text-slate-700 whitespace-nowrap">REF</th>
                  <th className="text-left px-3 py-2.5 font-bold text-slate-700 whitespace-nowrap">Cor</th>
                  <th className="text-center px-3 py-2.5 font-bold text-slate-700 whitespace-nowrap">Tam</th>
                  <th className="text-left px-3 py-2.5 font-bold text-slate-700">Descrição</th>
                  <th className="text-right px-3 py-2.5 font-bold text-slate-700 whitespace-nowrap">Qtd</th>
                  <th className="text-right px-3 py-2.5 font-bold text-slate-700 whitespace-nowrap">Valor</th>
                  <th className="text-center px-3 py-2.5 font-bold text-slate-700 whitespace-nowrap">Pedidos</th>
                  <th className="text-center px-3 py-2.5 font-bold text-slate-700 whitespace-nowrap">Última</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={10} className="py-12 text-center text-slate-400">
                      <Loader2 className="w-6 h-6 animate-spin inline mr-2" /> Carregando...
                    </td>
                  </tr>
                )}
                {!loading && !data && (
                  <tr>
                    <td colSpan={10} className="py-12 text-center text-slate-400">
                      Sem dados. Aplique filtros e clique em Buscar.
                    </td>
                  </tr>
                )}
                {!loading && data && data.linhas.length === 0 && (
                  <tr>
                    <td colSpan={10} className="py-12 text-center text-slate-400">
                      Nenhum item encontrado com esses filtros.
                    </td>
                  </tr>
                )}
                {!loading && data && data.linhas.map((l, idx) => (
                  <tr key={`${l.storeCode}-${l.sku}-${idx}`} className="border-b hover:bg-indigo-50/30">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded mr-1">{l.storeCode}</span>
                      <span className="text-xs">{l.storeName}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{l.sku}</td>
                    <td className="px-3 py-2 text-xs font-bold whitespace-nowrap">{l.ref ?? '—'}</td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">{l.cor ?? '—'}</td>
                    <td className="px-3 py-2 text-center text-xs whitespace-nowrap">{l.tamanho ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-slate-600 truncate max-w-[300px]" title={l.descricao ?? l.productName ?? ''}>
                      {l.descricao ?? l.productName ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums whitespace-nowrap">{l.qtd}</td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">{brl(l.valor)}</td>
                    <td className="px-3 py-2 text-center text-xs text-slate-600">{l.pedidos}</td>
                    <td className="px-3 py-2 text-center text-xs text-slate-600 whitespace-nowrap">{fmtDate(l.ultimaSaida)}</td>
                  </tr>
                ))}
              </tbody>
              {!loading && data && data.linhas.length > 0 && (
                <tfoot className="bg-slate-100 border-t-2">
                  <tr>
                    <td colSpan={6} className="px-3 py-2.5 text-right font-bold text-slate-700">TOTAL GERAL</td>
                    <td className="px-3 py-2.5 text-right font-bold text-emerald-700 tabular-nums">{data.totalGeralQtd}</td>
                    <td className="px-3 py-2.5 text-right font-bold text-indigo-700 font-mono">{brl(data.totalGeralValor)}</td>
                    <td className="px-3 py-2.5 text-center font-bold text-violet-700">{data.totalGeralPedidos}</td>
                    <td></td>
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

function StatCard({ label, value, cor }: { label: string; value: string; cor: 'emerald' | 'indigo' | 'violet' }) {
  const tones = {
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-700',
    violet: 'bg-violet-50 border-violet-200 text-violet-700',
  };
  return (
    <div className={`border rounded-xl p-4 ${tones[cor]}`}>
      <div className="text-xs font-bold uppercase mb-1 opacity-80">{label}</div>
      <div className="text-2xl font-black tabular-nums">{value}</div>
    </div>
  );
}
