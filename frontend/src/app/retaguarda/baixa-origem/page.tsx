'use client';

/**
 * /retaguarda/baixa-origem
 *
 * Rotina DIRETA: ver tudo que saiu de uma loja origem (essa semana, mês, etc)
 * e baixar estoque Giga na origem com um clique.
 *
 * Não depende de filtros de status complexos nem de marcador stockDecreasedAt
 * — lista TUDO e deixa o admin decidir. Mostra marcador "já baixada" pra evitar
 * duplicação, mas permite forçar.
 *
 * Fluxo:
 *  1. Carrega lojas (/stores)
 *  2. Admin escolhe Loja Origem (obrigatório) + Destino (opcional) + dias atrás
 *  3. Lista as remessas via GET /realignment/shipments/admin/by-route
 *  4. Por linha: botão "Baixar estoque [LOJA]" — chama reprocess-stock (force=true)
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, Loader2, AlertCircle, CheckCircle2, ArrowDown, Truck } from 'lucide-react';
import { api } from '@/lib/api';

type Store = { id: string; code: string; name: string; city?: string | null; state?: string | null; active?: boolean };

type ShipmentRow = {
  id: string;
  code: string;
  fromStoreCode: string;
  fromStoreName: string;
  toStoreCode: string;
  toStoreName: string;
  status: string;
  openedAt: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  totalItems: number;
  totalQty: number;
  totalItemsLive: number;
  stockDecreasedAt: string | null;
  alreadyDecreased: boolean;
};

type ProcessResult = {
  ok: boolean;
  code?: string;
  itemsTotal?: number;
  stockItemsAttempted?: number;
  stockItemsApplied?: number;
  unresolved?: number;
  message?: string;
  error?: string;
};

const fmtDT = (iso: string | null) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); }
  catch { return iso; }
};

export default function BaixaOrigemPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [fromCode, setFromCode] = useState<string>('');
  const [toCode, setToCode] = useState<string>('');
  const [daysAgo, setDaysAgo] = useState<number>(7);
  const [rows, setRows] = useState<ShipmentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, ProcessResult>>({});

  // Carrega lojas no mount
  useEffect(() => {
    api<Store[]>('/stores')
      .then((arr) => setStores(Array.isArray(arr) ? arr.filter((s) => s.active !== false) : []))
      .catch((e) => setErr(`Falha carregar lojas: ${e?.message || e}`));
  }, []);

  const fromName = useMemo(() => stores.find((s) => s.code === fromCode)?.name || fromCode, [stores, fromCode]);

  async function load() {
    if (!fromCode) {
      setErr('Selecione a loja ORIGEM primeiro.');
      return;
    }
    setLoading(true);
    setErr(null);
    setResults({});
    try {
      const qs = new URLSearchParams({ from: fromCode, daysAgo: String(daysAgo) });
      if (toCode) qs.set('to', toCode);
      const r = await api<ShipmentRow[]>(`/realignment/shipments/admin/by-route?${qs}`);
      setRows(Array.isArray(r) ? r : []);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao carregar');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function baixar(row: ShipmentRow) {
    const msg = row.alreadyDecreased
      ? `⚠ A remessa ${row.code} JÁ teve baixa Giga em ${fmtDT(row.stockDecreasedAt)}.\n\nFORÇAR uma nova baixa vai DUPLICAR o desconto de estoque em ${row.fromStoreCode}.\n\nTem CERTEZA que quer baixar de novo?`
      : `Baixar estoque Giga em ${row.fromStoreCode} pra remessa ${row.code} (${row.totalItemsLive} itens, ${row.totalQty} peças)?\n\nVai chamar decreaseStock no Giga.`;
    if (!confirm(msg)) return;

    setProcessing((p) => new Set(p).add(row.id));
    setResults((r) => { const n = { ...r }; delete n[row.id]; return n; });
    try {
      const res = await api<ProcessResult>(`/realignment/shipments/admin/${row.id}/reprocess-stock`, {
        method: 'POST',
        body: JSON.stringify({ force: row.alreadyDecreased }),
      });
      setResults((r) => ({ ...r, [row.id]: { ...res, ok: true } }));
      // Recarrega depois de 1.2s pra atualizar marcador
      setTimeout(() => load(), 1200);
    } catch (e: any) {
      setResults((r) => ({ ...r, [row.id]: { ok: false, error: e?.message || String(e) } }));
    } finally {
      setProcessing((p) => { const n = new Set(p); n.delete(row.id); return n; });
    }
  }

  const totalPecas = rows.reduce((acc, r) => acc + (r.totalQty || 0), 0);

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-6xl mx-auto p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <Link href="/retaguarda" className="p-2 rounded-lg hover:bg-slate-200 text-slate-700">
              <ArrowLeft size={22} />
            </Link>
            <div>
              <h1 className="text-2xl font-black text-slate-900">Baixa Origem · Remessas</h1>
              <p className="text-xs text-slate-500">
                Lista TUDO que saiu de uma loja na semana — baixa estoque Giga em 1 clique.
              </p>
            </div>
          </div>
        </div>

        {/* Filtros */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-bold text-slate-600 uppercase">Loja Origem *</label>
            <select
              value={fromCode}
              onChange={(e) => setFromCode(e.target.value)}
              className="px-3 py-2 border border-slate-300 rounded-lg text-sm min-w-[200px]"
            >
              <option value="">— escolher —</option>
              {stores.map((s) => (
                <option key={s.id} value={s.code}>{s.name} ({s.code})</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-bold text-slate-600 uppercase">Loja Destino (opcional)</label>
            <select
              value={toCode}
              onChange={(e) => setToCode(e.target.value)}
              className="px-3 py-2 border border-slate-300 rounded-lg text-sm min-w-[200px]"
            >
              <option value="">— todas —</option>
              {stores.filter((s) => s.code !== fromCode).map((s) => (
                <option key={s.id} value={s.code}>{s.name} ({s.code})</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-bold text-slate-600 uppercase">Período</label>
            <select
              value={daysAgo}
              onChange={(e) => setDaysAgo(Number(e.target.value))}
              className="px-3 py-2 border border-slate-300 rounded-lg text-sm"
            >
              <option value={3}>Últimos 3 dias</option>
              <option value={7}>Última semana</option>
              <option value={15}>Últimos 15 dias</option>
              <option value={30}>Último mês</option>
              <option value={60}>Últimos 2 meses</option>
              <option value={90}>Últimos 3 meses</option>
            </select>
          </div>
          <button
            onClick={load}
            disabled={loading || !fromCode}
            className="px-4 py-2 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white rounded-lg text-sm font-bold flex items-center gap-1.5"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Buscar remessas
          </button>
        </div>

        {err && (
          <div className="bg-rose-50 border border-rose-300 text-rose-800 rounded-lg p-3 text-sm flex items-center gap-2">
            <AlertCircle size={18} /> {err}
          </div>
        )}

        {loading && (
          <div className="text-center p-16">
            <Loader2 size={40} className="mx-auto animate-spin text-rose-600" />
            <div className="text-sm text-slate-500 mt-3">Carregando…</div>
          </div>
        )}

        {!loading && fromCode && rows.length === 0 && !err && (
          <div className="bg-slate-50 border-2 border-slate-200 rounded-xl p-8 text-center">
            <div className="text-lg font-bold text-slate-700">Nenhuma remessa</div>
            <div className="text-sm text-slate-500 mt-1">
              {fromName} não enviou remessas nos últimos {daysAgo} dias{toCode ? ` pra ${toCode}` : ''}.
            </div>
          </div>
        )}

        {!loading && rows.length > 0 && (
          <>
            <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm font-bold text-amber-900 flex items-center justify-between flex-wrap gap-2">
              <div>
                {rows.length} remessa(s) · {totalPecas} peça(s) saíram de <span className="font-black">{fromName}</span> nos últimos {daysAgo} dias
              </div>
            </div>

            <div className="space-y-2">
              {rows.map((r) => {
                const isProc = processing.has(r.id);
                const res = results[r.id];
                return (
                  <div key={r.id} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono font-black text-base text-slate-900">{r.code}</span>
                          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                            r.status === 'in_transit'
                              ? 'bg-amber-100 text-amber-800 border border-amber-300'
                              : 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                          }`}>
                            {r.status === 'in_transit' ? 'Em trânsito' : 'Recebida'}
                          </span>
                          {r.alreadyDecreased ? (
                            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-300">
                              ✓ Já baixada
                            </span>
                          ) : (
                            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-rose-100 text-rose-800 border border-rose-300">
                              ⚠ Não baixada
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-sm text-slate-700">
                          <Truck size={14} className="text-slate-400" />
                          <span className="font-bold">{r.fromStoreName}</span>
                          <span className="text-slate-400">({r.fromStoreCode})</span>
                          <ArrowDown size={14} className="text-slate-400 rotate-[-90deg]" />
                          <span className="font-bold">{r.toStoreName}</span>
                          <span className="text-slate-400">({r.toStoreCode})</span>
                        </div>
                        <div className="text-xs text-slate-500 mt-1">
                          {r.totalItemsLive} item(s) · {r.totalQty} peça(s) · enviada em {fmtDT(r.sentAt || r.openedAt)}
                          {r.alreadyDecreased && (
                            <> · baixada em {fmtDT(r.stockDecreasedAt)}</>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0">
                        <button
                          onClick={() => baixar(r)}
                          disabled={isProc}
                          className={`px-4 py-2.5 disabled:opacity-50 text-white text-sm font-bold rounded-lg flex items-center gap-1.5 ${
                            r.alreadyDecreased
                              ? 'bg-rose-800 hover:bg-rose-900 border-2 border-rose-300'
                              : 'bg-rose-600 hover:bg-rose-700'
                          }`}
                          title={r.alreadyDecreased ? 'Já baixada — clique pra FORÇAR baixa duplicada' : `Baixa estoque Giga em ${r.fromStoreCode}`}
                        >
                          {isProc ? <Loader2 size={14} className="animate-spin" /> : <ArrowDown size={14} />}
                          {r.alreadyDecreased ? `FORÇAR baixar ${r.fromStoreCode}` : `Baixar em ${r.fromStoreCode}`}
                        </button>
                      </div>
                    </div>

                    {res && (
                      <div className={`mt-3 p-2 rounded text-xs ${res.ok ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-rose-50 border border-rose-200 text-rose-800'}`}>
                        {res.ok ? (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <CheckCircle2 size={14} />
                            <span className="font-bold">{res.message || 'OK'}</span>
                            {typeof res.stockItemsApplied === 'number' && (
                              <span>· {res.stockItemsApplied}/{res.stockItemsAttempted} SKUs aplicados</span>
                            )}
                            {(res.unresolved ?? 0) > 0 && (
                              <span className="text-amber-700">· {res.unresolved} unresolved</span>
                            )}
                          </div>
                        ) : (
                          <div className="flex items-start gap-1.5">
                            <AlertCircle size={14} className="mt-0.5 shrink-0" />
                            <span>{res.error}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
