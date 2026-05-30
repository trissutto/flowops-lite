'use client';

/**
 * /retaguarda/vales-troca
 *
 * Auditoria de vales-troca emitidos. Lista com filtros e click abre histórico.
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Loader2, Filter, RefreshCw, AlertCircle, Search,
  CheckCircle2, XCircle, Clock,
} from 'lucide-react';
import { api } from '@/lib/api';

interface ValeItem {
  id: string;
  creditoCode: string;
  modo: string;
  valorTotal: number;
  status: string;
  statusCalculado: 'ativo' | 'usado' | 'vencido';
  creditoValidade: string | null;
  creditoUsadoEm: string | null;
  creditoUsadoAt: string | null;
  storeCode: string;
  storeName: string;
  customerName: string | null;
  customerCpf: string | null;
  userName: string | null;
  motivo: string | null;
  createdAt: string;
  originalSaleNumber: string | null;
  originalSaleId: string | null;
}

interface ValesResponse {
  total: number;
  page: number;
  size: number;
  totalAtivos: number;
  items: ValeItem[];
}

interface StoreOption { id: string; code: string; name: string; }

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDateTime(iso: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('pt-BR');
  } catch { return iso; }
}

export default function ValesTrocaPage() {
  const hoje = new Date();
  const trintaDiasAtras = new Date(); trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);

  const [stores, setStores] = useState<StoreOption[]>([]);
  const [from, setFrom] = useState(ymd(trintaDiasAtras));
  const [to, setTo] = useState(ymd(hoje));
  const [storeCode, setStoreCode] = useState('');
  const [status, setStatus] = useState<'ativo' | 'usado' | 'vencido' | 'todos'>('todos');
  const [code, setCode] = useState('');
  const [customerQ, setCustomerQ] = useState('');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<ValesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<StoreOption[]>('/stores').then(s => setStores(Array.isArray(s) ? s : [])).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      if (storeCode) q.set('storeCode', storeCode);
      if (status && status !== 'todos') q.set('status', status);
      if (code) q.set('code', code);
      if (customerQ) q.set('customerQ', customerQ);
      q.set('page', String(page));
      q.set('size', '50');
      const r = await api<ValesResponse>(`/pdv/devolucao/creditos?${q.toString()}`);
      setData(r);
    } catch (e: any) {
      setError(e?.message || 'Falha');
    } finally {
      setLoading(false);
    }
  }, [from, to, storeCode, status, code, customerQ, page]);

  useEffect(() => { load(); }, [load]);

  const totalPages = data ? Math.ceil(data.total / data.size) : 1;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="p-2 rounded-lg hover:bg-slate-100"><ArrowLeft className="w-5 h-5" /></Link>
          <div className="flex-1">
            <h1 className="text-lg font-black">Vales-troca emitidos</h1>
            <p className="text-xs text-slate-500">Histórico completo de vales gerados em devoluções</p>
          </div>
          <button onClick={load} className="p-2 rounded-lg hover:bg-slate-100" title="Recarregar">
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 py-4 space-y-4">
        {/* Filtros */}
        <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-700">
            <Filter className="w-4 h-4" /> Filtros
          </div>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <div>
              <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">De</label>
              <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }}
                className="w-full border rounded px-2 py-2 text-sm" />
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">Até</label>
              <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }}
                className="w-full border rounded px-2 py-2 text-sm" />
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">Loja</label>
              <select value={storeCode} onChange={(e) => { setStoreCode(e.target.value); setPage(1); }}
                className="w-full border rounded px-2 py-2 text-sm">
                <option value="">Todas</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.code}>{s.code} — {s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">Status</label>
              <select value={status} onChange={(e) => { setStatus(e.target.value as any); setPage(1); }}
                className="w-full border rounded px-2 py-2 text-sm">
                <option value="todos">Todos</option>
                <option value="ativo">✓ Ativo</option>
                <option value="usado">✗ Usado</option>
                <option value="vencido">⏰ Vencido</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">Código</label>
              <input value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setPage(1); }}
                placeholder="TROCA-XXX" className="w-full border rounded px-2 py-2 text-sm font-mono uppercase" />
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">Cliente / CPF</label>
              <input value={customerQ} onChange={(e) => { setCustomerQ(e.target.value); setPage(1); }}
                placeholder="nome ou CPF" className="w-full border rounded px-2 py-2 text-sm" />
            </div>
          </div>
          <div className="flex items-center justify-between text-xs">
            <div className="text-slate-500">
              {data && <>Total: <b>{data.total}</b> vale(s) · Página <b>{data.page}</b> de {totalPages}</>}
            </div>
            <div>
              {data && (
                <span className="bg-emerald-100 text-emerald-800 font-bold px-3 py-1 rounded">
                  Saldo ATIVO total: {brl(data.totalAtivos)}
                </span>
              )}
            </div>
          </div>
        </section>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 p-3 rounded-lg text-sm">{error}</div>
        )}

        {/* Tabela */}
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 border-b">
                <tr>
                  <th className="text-left px-3 py-2 font-bold text-slate-700 whitespace-nowrap">Código</th>
                  <th className="text-left px-3 py-2 font-bold text-slate-700 whitespace-nowrap">Emitido em</th>
                  <th className="text-left px-3 py-2 font-bold text-slate-700 whitespace-nowrap">Loja</th>
                  <th className="text-left px-3 py-2 font-bold text-slate-700">Cliente</th>
                  <th className="text-right px-3 py-2 font-bold text-slate-700 whitespace-nowrap">Valor</th>
                  <th className="text-left px-3 py-2 font-bold text-slate-700 whitespace-nowrap">Validade</th>
                  <th className="text-left px-3 py-2 font-bold text-slate-700 whitespace-nowrap">Status</th>
                  <th className="text-left px-3 py-2 font-bold text-slate-700 whitespace-nowrap">Vendedora</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={8} className="py-12 text-center text-slate-400">
                    <Loader2 className="w-6 h-6 animate-spin inline mr-2" /> Carregando...
                  </td></tr>
                )}
                {!loading && data && data.items.length === 0 && (
                  <tr><td colSpan={8} className="py-12 text-center text-slate-400">
                    Nenhum vale-troca no período / filtros.
                  </td></tr>
                )}
                {!loading && data && data.items.map((it) => {
                  const statusInfo = it.statusCalculado === 'ativo'
                    ? { cls: 'bg-emerald-100 text-emerald-800', icon: <CheckCircle2 className="w-3 h-3" />, label: 'ATIVO' }
                    : it.statusCalculado === 'usado'
                    ? { cls: 'bg-slate-200 text-slate-700', icon: <XCircle className="w-3 h-3" />, label: 'USADO' }
                    : { cls: 'bg-rose-100 text-rose-800', icon: <Clock className="w-3 h-3" />, label: 'VENCIDO' };
                  return (
                    <tr key={it.id} className="border-b hover:bg-slate-50">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Link
                          href={`/minha-loja/pdv/vale-troca/${encodeURIComponent(it.creditoCode)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono font-bold text-violet-700 hover:underline"
                          title="Abrir vale com histórico"
                        >
                          {it.creditoCode}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">{fmtDateTime(it.createdAt)}</td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        <span className="font-medium">{it.storeName}</span>
                        <div className="font-mono text-[10px] text-slate-500">{it.storeCode}</div>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {it.customerName ? (
                          <>
                            <span className="font-medium">{it.customerName}</span>
                            {it.customerCpf && <div className="text-[10px] text-slate-500 font-mono">CPF {it.customerCpf}</div>}
                          </>
                        ) : (
                          <span className="text-slate-400 italic">Sem identificação</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-bold tabular-nums whitespace-nowrap">
                        {brl(it.valorTotal)}
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">{fmtDate(it.creditoValidade)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded inline-flex items-center gap-1 ${statusInfo.cls}`}>
                          {statusInfo.icon} {statusInfo.label}
                        </span>
                        {it.statusCalculado === 'usado' && it.creditoUsadoAt && (
                          <div className="text-[9px] text-slate-500 mt-0.5">{fmtDateTime(it.creditoUsadoAt)}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap text-slate-700 truncate max-w-[160px]" title={it.userName || ''}>
                        {it.userName || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Paginação */}
          {data && totalPages > 1 && (
            <div className="flex justify-between items-center border-t px-4 py-2 bg-slate-50">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page <= 1}
                className="px-3 py-1.5 text-xs font-bold rounded bg-white border hover:bg-slate-100 disabled:opacity-40"
              >
                ← Anterior
              </button>
              <span className="text-xs text-slate-600">Página {page} de {totalPages}</span>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages}
                className="px-3 py-1.5 text-xs font-bold rounded bg-white border hover:bg-slate-100 disabled:opacity-40"
              >
                Próxima →
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
