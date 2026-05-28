'use client';

/**
 * /retaguarda/auditoria-master
 *
 * Log imutavel de todas as alteracoes feitas com senha master:
 *  - Trocas de vendedora (venda inteira / por item)
 *  - Ajustes de fundo de caixa
 *  - Sangrias / suprimentos lancados via master
 *  - Edicao de pagamento (method/valor/bandeira)
 *
 * Filtros: loja, acao, periodo, usuario.
 * Apenas admin/supervisor/operator.
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Filter, ShieldCheck, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';

interface AuditItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  storeCode: string | null;
  storeName: string | null;
  level: string;
  userName: string;
  oldValue: any;
  newValue: any;
  motivo: string;
  createdAt: string;
}

interface AuditResponse {
  total: number;
  page: number;
  size: number;
  items: AuditItem[];
}

interface StoreOption { id: string; code: string; name: string; }

const ACTION_LABELS: Record<string, { label: string; color: string; icon: string }> = {
  fundo:            { label: 'Fundo de caixa', color: 'bg-amber-100 text-amber-800', icon: '💵' },
  movement_create:  { label: 'Sangria/Suprimento', color: 'bg-blue-100 text-blue-800', icon: '⬇️' },
  movement_delete:  { label: 'Estorno mov.', color: 'bg-red-100 text-red-800', icon: '🗑️' },
  payment_edit:     { label: 'Pagamento', color: 'bg-violet-100 text-violet-800', icon: '💳' },
  sale_seller:      { label: 'Vendedora (venda)', color: 'bg-emerald-100 text-emerald-800', icon: '🧾' },
  item_seller:      { label: 'Vendedora (item)', color: 'bg-emerald-100 text-emerald-800', icon: '✂️' },
};

const LEVEL_COLORS: Record<string, string> = {
  SUPREMA: 'bg-purple-200 text-purple-900',
  MASTER: 'bg-rose-200 text-rose-900',
  GERENTE: 'bg-orange-200 text-orange-900',
  SUPERVISOR: 'bg-sky-200 text-sky-900',
  CAIXA: 'bg-slate-200 text-slate-700',
};

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDateTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

function fmtJson(v: any): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v;
  try {
    return Object.entries(v)
      .map(([k, val]) => `${k}: ${val}`)
      .join(' · ');
  } catch { return JSON.stringify(v); }
}

export default function AuditoriaMasterPage() {
  const hoje = new Date();
  const semanaPassada = new Date(); semanaPassada.setDate(semanaPassada.getDate() - 7);

  const [stores, setStores] = useState<StoreOption[]>([]);
  const [storeCode, setStoreCode] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState(ymd(semanaPassada));
  const [to, setTo] = useState(ymd(hoje));
  const [userName, setUserName] = useState('');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<AuditResponse | null>(null);
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
      if (storeCode) q.set('storeCode', storeCode);
      if (action) q.set('action', action);
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      if (userName) q.set('userName', userName);
      q.set('page', String(page));
      q.set('size', '50');
      const r = await api<AuditResponse>(`/pdv/caixa/master/audit?${q.toString()}`);
      setData(r);
    } catch (e: any) {
      setError(e?.message || 'Falha');
    } finally {
      setLoading(false);
    }
  }, [storeCode, action, from, to, userName, page]);

  useEffect(() => { load(); }, [load]);

  const totalPages = data ? Math.ceil(data.total / data.size) : 1;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="p-2 rounded-lg hover:bg-slate-100"><ArrowLeft className="w-5 h-5" /></Link>
          <ShieldCheck className="w-6 h-6 text-violet-600" />
          <div className="flex-1">
            <h1 className="text-lg font-black">Auditoria Master</h1>
            <p className="text-xs text-slate-500">Log de alterações feitas com senha master/gerente</p>
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
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
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
              <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">Ação</label>
              <select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}
                className="w-full border rounded px-2 py-2 text-sm">
                <option value="">Todas</option>
                {Object.entries(ACTION_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v.icon} {v.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">Usuário</label>
              <input value={userName} onChange={(e) => { setUserName(e.target.value); setPage(1); }}
                placeholder="ex: thiago" className="w-full border rounded px-2 py-2 text-sm" />
            </div>
          </div>
          <div className="text-xs text-slate-500">
            {data && <>Total: <b>{data.total}</b> registros · Página <b>{data.page}</b> de {totalPages}</>}
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
                  <th className="text-left px-3 py-2 font-bold text-slate-700 whitespace-nowrap">Data</th>
                  <th className="text-left px-3 py-2 font-bold text-slate-700 whitespace-nowrap">Ação</th>
                  <th className="text-left px-3 py-2 font-bold text-slate-700 whitespace-nowrap">Loja</th>
                  <th className="text-left px-3 py-2 font-bold text-slate-700">Antes → Depois</th>
                  <th className="text-left px-3 py-2 font-bold text-slate-700">Motivo</th>
                  <th className="text-left px-3 py-2 font-bold text-slate-700 whitespace-nowrap">Nível</th>
                  <th className="text-left px-3 py-2 font-bold text-slate-700 whitespace-nowrap">Por</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={7} className="py-12 text-center text-slate-400">
                    <Loader2 className="w-6 h-6 animate-spin inline mr-2" /> Carregando...
                  </td></tr>
                )}
                {!loading && data && data.items.length === 0 && (
                  <tr><td colSpan={7} className="py-12 text-center text-slate-400">
                    Nenhum registro no período/filtros.
                  </td></tr>
                )}
                {!loading && data && data.items.map((it) => {
                  const meta = ACTION_LABELS[it.action] || { label: it.action, color: 'bg-slate-100 text-slate-800', icon: '•' };
                  const levelCls = LEVEL_COLORS[it.level] || 'bg-slate-200 text-slate-700';
                  return (
                    <tr key={it.id} className="border-b hover:bg-slate-50">
                      <td className="px-3 py-2 text-xs whitespace-nowrap font-mono">{fmtDateTime(it.createdAt)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded ${meta.color}`}>
                          {meta.icon} {meta.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        {it.storeName ? <span className="font-medium">{it.storeName}</span> : '—'}
                        {it.storeCode && <div className="font-mono text-[10px] text-slate-500">{it.storeCode}</div>}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <div className="flex flex-col gap-0.5 max-w-[420px]">
                          <span className="text-rose-700 line-through truncate" title={JSON.stringify(it.oldValue)}>
                            {fmtJson(it.oldValue)}
                          </span>
                          <span className="text-emerald-700 font-bold truncate" title={JSON.stringify(it.newValue)}>
                            {fmtJson(it.newValue)}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs max-w-[260px]">
                        <span className="text-slate-700 italic truncate block" title={it.motivo}>{it.motivo}</span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${levelCls}`}>{it.level}</span>
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap text-slate-700">{it.userName}</td>
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
