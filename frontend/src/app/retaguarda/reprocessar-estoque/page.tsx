'use client';

/**
 * /retaguarda/reprocessar-estoque
 *
 * Tela admin pra consertar remessas que fecharam mas o estoque Giga
 * não baixou (decreaseStock silenciado por mismatch de storeCode).
 *
 * Fluxo:
 *  1. Carrega lista via GET /api/realignment/shipments/admin/needs-stock-reprocess
 *  2. Cada remessa tem botão "Reprocessar baixa origem" (idempotente — só baixa
 *     se stockDecreasedAt = null)
 *  3. Click → POST /api/realignment/shipments/admin/:id/reprocess-stock
 *  4. Mostra resultado (quantos SKUs aplicados ou erro)
 *  5. Recarrega lista — remessas conciliadas somem
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, Loader2, AlertCircle, CheckCircle2, ArrowDown, Truck } from 'lucide-react';
import { api } from '@/lib/api';

type ShipmentRow = {
  id: string;
  code: string;
  fromStoreCode: string;
  fromStoreName: string;
  toStoreCode: string;
  toStoreName: string;
  status: string;
  sentAt: string | null;
  totalQty: number;
  totalItemsLive: number;
  stockDecreasedAt: string | null;
  stockIncreasedAt: string | null;
  needsDecrease: boolean;
  needsIncrease: boolean;
};

type ProcessResult = {
  ok: boolean;
  code: string;
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

export default function ReprocessarEstoquePage() {
  const [rows, setRows] = useState<ShipmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [daysAgo, setDaysAgo] = useState<number>(30);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, ProcessResult>>({});

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await api<ShipmentRow[]>(`/realignment/shipments/admin/needs-stock-reprocess?daysAgo=${daysAgo}`);
      setRows(Array.isArray(r) ? r : []);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [daysAgo]);

  async function reprocessar(id: string, code: string, force = false) {
    if (!confirm(`Reprocessar baixa de estoque da remessa ${code}?\n\nIsso vai chamar decreaseStock no Giga pra cada item da remessa. Idempotente — só baixa se ainda não tinha baixado.`)) return;
    setProcessing((p) => new Set(p).add(id));
    setResults((r) => { const n = { ...r }; delete n[id]; return n; });
    try {
      const res = await api<ProcessResult>(`/realignment/shipments/admin/${id}/reprocess-stock`, {
        method: 'POST',
        body: JSON.stringify({ force }),
      });
      setResults((r) => ({ ...r, [id]: { ...res, ok: true } }));
      // Recarrega lista após 1.5s pra remessa sumir da lista (já reprocessada)
      setTimeout(() => load(), 1500);
    } catch (e: any) {
      setResults((r) => ({ ...r, [id]: { ok: false, code, error: e?.message || String(e) } }));
    } finally {
      setProcessing((p) => { const n = new Set(p); n.delete(id); return n; });
    }
  }

  async function reprocessarAumento(id: string, code: string) {
    if (!confirm(`Reprocessar AUMENTO de estoque no destino da remessa ${code}?\n\nUse APENAS se a remessa já foi recebida e os itens bipados, mas o increaseStock não rodou.`)) return;
    setProcessing((p) => new Set(p).add(id));
    setResults((r) => { const n = { ...r }; delete n[id]; return n; });
    try {
      const res = await api<ProcessResult>(`/realignment/shipments/admin/${id}/reprocess-stock-increase`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setResults((r) => ({ ...r, [id]: { ...res, ok: true } }));
      setTimeout(() => load(), 1500);
    } catch (e: any) {
      setResults((r) => ({ ...r, [id]: { ok: false, code, error: e?.message || String(e) } }));
    } finally {
      setProcessing((p) => { const n = new Set(p); n.delete(id); return n; });
    }
  }

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
              <h1 className="text-2xl font-black text-slate-900">Reprocessar Estoque · Remessas</h1>
              <p className="text-xs text-slate-500">
                Remessas fechadas/recebidas que não tiveram baixa Giga aplicada (mismatch de storeCode, etc).
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500">Últimos</label>
            <select
              value={daysAgo}
              onChange={(e) => setDaysAgo(Number(e.target.value))}
              className="px-2 py-1.5 border border-slate-300 rounded-lg text-sm"
            >
              <option value={7}>7 dias</option>
              <option value={15}>15 dias</option>
              <option value={30}>30 dias</option>
              <option value={60}>60 dias</option>
              <option value={90}>90 dias</option>
            </select>
            <button
              onClick={load}
              disabled={loading}
              className="px-3 py-2 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white rounded-lg text-sm font-bold flex items-center gap-1"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Atualizar
            </button>
          </div>
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

        {!loading && rows.length === 0 && (
          <div className="bg-emerald-50 border-2 border-emerald-200 rounded-xl p-8 text-center">
            <CheckCircle2 size={48} className="mx-auto text-emerald-600 mb-3" />
            <div className="text-lg font-bold text-emerald-800">Tudo conciliado!</div>
            <div className="text-sm text-emerald-700 mt-1">
              Nenhuma remessa nos últimos {daysAgo} dias precisa de reprocessamento.
            </div>
          </div>
        )}

        {!loading && rows.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-bold text-slate-700 mb-2">
              {rows.length} remessa(s) com problema de estoque Giga
            </div>
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
                        {r.totalItemsLive} item(s) · {r.totalQty} peça(s) · enviada em {fmtDT(r.sentAt)}
                      </div>
                      <div className="flex gap-3 mt-2 text-[11px] flex-wrap">
                        {r.needsDecrease && (
                          <span className="bg-rose-100 text-rose-800 border border-rose-300 px-2 py-0.5 rounded font-bold">
                            ⚠ Estoque ORIGEM não baixou
                          </span>
                        )}
                        {r.needsIncrease && (
                          <span className="bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5 rounded font-bold">
                            ⚠ Estoque DESTINO não aumentou
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5 shrink-0">
                      {r.needsDecrease && (
                        <button
                          onClick={() => reprocessar(r.id, r.code)}
                          disabled={isProc}
                          className="px-3 py-2 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-xs font-bold rounded-lg flex items-center gap-1.5"
                          title={`Baixa estoque Giga em ${r.fromStoreCode}`}
                        >
                          {isProc ? <Loader2 size={14} className="animate-spin" /> : <ArrowDown size={14} />}
                          Baixar estoque {r.fromStoreCode}
                        </button>
                      )}
                      {r.needsIncrease && (
                        <button
                          onClick={() => reprocessarAumento(r.id, r.code)}
                          disabled={isProc}
                          className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold rounded-lg flex items-center gap-1.5"
                          title={`Aumenta estoque Giga em ${r.toStoreCode}`}
                        >
                          {isProc ? <Loader2 size={14} className="animate-spin" /> : <ArrowDown size={14} className="rotate-180" />}
                          Aumentar estoque {r.toStoreCode}
                        </button>
                      )}
                    </div>
                  </div>

                  {res && (
                    <div className={`mt-3 p-2 rounded text-xs ${res.ok ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-rose-50 border border-rose-200 text-rose-800'}`}>
                      {res.ok ? (
                        <div className="flex items-center gap-1.5">
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
        )}
      </div>
    </div>
  );
}
