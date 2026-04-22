'use client';

/**
 * /retaguarda/enviados-hoje
 *
 * Matriz vê, em tempo real, o que cada loja ENVIOU de pedidos do site (WC) no dia.
 *
 * Por que isso importa:
 *   - Acompanhar produtividade de envio por loja
 *   - Cobrar filial que não tá dando vazão
 *   - Auditar rastreios / totais / forma de envio
 *
 * Fonte: pick-orders com status=shipped no intervalo (default HOJE).
 *        Agrupado por loja, com lista detalhada expandível por grupo.
 *
 * Filtro: preset HOJE / ONTEM / 7d / intervalo manual.
 * Refresh automático: 60s (pra acompanhar sem F5).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Package, Truck, Store as StoreIcon, RefreshCw, Clock, ChevronDown, ChevronRight,
  ExternalLink, Repeat, MapPin, Phone, DollarSign, AlertCircle, Loader2, Calendar,
} from 'lucide-react';
import { api } from '@/lib/api';

// ===========================================================================
// Types
// ===========================================================================

interface ShippedRow {
  pickOrderId: string;
  wcOrderId: number | null;
  wcOrderNumber: string | null;
  customerName: string | null;
  customerPhone: string | null;
  totalAmount: number | null;
  shippingMethod: string | null;
  trackingCode: string | null;
  carrier: string | null;
  shippedAt: string;
  itemsCount: number;
  isPickup: boolean;
  isTransfer: boolean;
  transferToStoreCode: string | null;
}

interface StoreGroup {
  storeCode: string;
  storeName: string;
  count: number;
  totalItems: number;
  totalRevenue: number;
  transferCount: number;
  pickupCount: number;
  rows: ShippedRow[];
}

interface Resp {
  period: { from: string; to: string };
  grand: {
    count: number;
    totalItems: number;
    totalRevenue: number;
    storesCount: number;
    transferCount: number;
    pickupCount: number;
  };
  byStore: StoreGroup[];
}

type Preset = 'today' | 'yesterday' | '7d' | 'custom';

// ===========================================================================
// Helpers
// ===========================================================================

function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function presetToRange(preset: Preset): { from: string; to: string } {
  const today = new Date();
  if (preset === 'today') {
    return { from: toDateInput(today), to: toDateInput(today) };
  }
  if (preset === 'yesterday') {
    const y = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    return { from: toDateInput(y), to: toDateInput(y) };
  }
  if (preset === '7d') {
    const from = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
    return { from: toDateInput(from), to: toDateInput(today) };
  }
  return { from: toDateInput(today), to: toDateInput(today) };
}

function formatMoney(n: number): string {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function methodBadge(m: string | null): { label: string; color: string } {
  if (!m) return { label: '—', color: 'bg-slate-100 text-slate-600' };
  const up = m.toUpperCase();
  if (up.includes('SEDEX')) return { label: 'SEDEX', color: 'bg-red-100 text-red-800 border-red-300' };
  if (up.includes('PAC')) return { label: 'PAC', color: 'bg-blue-100 text-blue-800 border-blue-300' };
  if (up.includes('RETIRADA') || up.includes('PICKUP')) return { label: 'RETIRADA', color: 'bg-emerald-100 text-emerald-800 border-emerald-300' };
  if (up.includes('MOTOBOY') || up.includes('MOTO')) return { label: 'MOTOBOY', color: 'bg-amber-100 text-amber-800 border-amber-300' };
  return { label: m, color: 'bg-slate-100 text-slate-700 border-slate-300' };
}

// ===========================================================================
// Page
// ===========================================================================

export default function EnviadosHojePage() {
  const [preset, setPreset] = useState<Preset>('today');
  const [from, setFrom] = useState(() => presetToRange('today').from);
  const [to, setTo] = useState(() => presetToRange('today').to);
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set('from', from);
      qs.set('to', to);
      const resp = await api<Resp>(`/pick-orders/shipped-by-store?${qs.toString()}`);
      setData(resp);
      // Expande automaticamente se tiver só 1-3 lojas (vê tudo de uma vez)
      if (resp.byStore.length > 0 && resp.byStore.length <= 3) {
        setExpanded(new Set(resp.byStore.map((s) => s.storeCode)));
      }
    } catch (e: any) {
      setError(String(e?.message ?? 'Erro ao carregar'));
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh 60s quando preset = today
  useEffect(() => {
    if (!autoRefresh || preset !== 'today') return;
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [autoRefresh, preset, load]);

  const changePreset = (p: Preset) => {
    setPreset(p);
    if (p !== 'custom') {
      const r = presetToRange(p);
      setFrom(r.from);
      setTo(r.to);
    }
  };

  const toggleExpand = (code: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };

  const expandAll = () => {
    if (!data) return;
    setExpanded(new Set(data.byStore.map((s) => s.storeCode)));
  };
  const collapseAll = () => setExpanded(new Set());

  const rankColor = (idx: number) => {
    if (idx === 0) return 'border-amber-400 bg-amber-50/30';
    if (idx === 1) return 'border-slate-300 bg-slate-50/30';
    if (idx === 2) return 'border-orange-300 bg-orange-50/30';
    return 'border-slate-200 bg-white';
  };

  const rankBadge = (idx: number) => {
    if (idx === 0) return { emoji: '🥇', label: '1º' };
    if (idx === 1) return { emoji: '🥈', label: '2º' };
    if (idx === 2) return { emoji: '🥉', label: '3º' };
    return { emoji: '', label: `${idx + 1}º` };
  };

  const storesMax = useMemo(() => Math.max(...(data?.byStore.map((s) => s.count) ?? [1]), 1), [data]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Truck className="w-7 h-7 text-emerald-600" />
            Enviados por Loja
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Pedidos do site (WooCommerce) que cada filial já despachou no período.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto 60s
          </label>
          <button
            onClick={load}
            className="px-3 py-2 text-sm font-semibold rounded bg-gray-900 text-white hover:bg-gray-700 flex items-center gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>
      </div>

      {/* Filtros de período */}
      <div className="bg-white rounded-lg shadow p-3 mb-4 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 text-xs text-gray-500">
          <Calendar className="w-3 h-3" /> Período:
        </div>
        {(['today', 'yesterday', '7d', 'custom'] as Preset[]).map((p) => (
          <button
            key={p}
            onClick={() => changePreset(p)}
            className={`px-3 py-1.5 rounded text-sm font-semibold border ${
              preset === p
                ? 'bg-emerald-600 text-white border-emerald-600'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
            }`}
          >
            {p === 'today' && 'Hoje'}
            {p === 'yesterday' && 'Ontem'}
            {p === '7d' && 'Últimos 7d'}
            {p === 'custom' && 'Período'}
          </button>
        ))}
        {preset === 'custom' && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="text-sm border rounded px-2 py-1.5"
            />
            <span className="text-xs text-gray-500">até</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="text-sm border rounded px-2 py-1.5"
            />
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* KPIs */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <div className="bg-white rounded-lg shadow p-4 border-l-4 border-emerald-500">
            <div className="text-xs text-emerald-700 uppercase font-semibold mb-1 flex items-center gap-1">
              <Package className="w-3 h-3" /> Pedidos
            </div>
            <div className="text-2xl font-bold">{data.grand.count}</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4 border-l-4 border-blue-500">
            <div className="text-xs text-blue-700 uppercase font-semibold mb-1">Lojas ativas</div>
            <div className="text-2xl font-bold">{data.grand.storesCount}</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="text-xs text-gray-500 uppercase font-semibold mb-1">Peças</div>
            <div className="text-2xl font-bold">{data.grand.totalItems}</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4 border-l-4 border-green-500">
            <div className="text-xs text-green-700 uppercase font-semibold mb-1">Faturamento</div>
            <div className="text-xl font-bold">{formatMoney(data.grand.totalRevenue)}</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4 border-l-4 border-amber-500">
            <div className="text-xs text-amber-700 uppercase font-semibold mb-1">Transferências</div>
            <div className="text-2xl font-bold">{data.grand.transferCount}</div>
            <div className="text-[10px] text-gray-500 mt-0.5">{data.grand.pickupCount} retirada(s)</div>
          </div>
        </div>
      )}

      {/* Ações bulk */}
      {data && data.byStore.length > 0 && (
        <div className="flex items-center gap-2 mb-2 text-xs text-gray-600">
          <button onClick={expandAll} className="underline hover:text-gray-900">Expandir tudo</button>
          <span>·</span>
          <button onClick={collapseAll} className="underline hover:text-gray-900">Fechar tudo</button>
        </div>
      )}

      {/* Loading inicial */}
      {loading && !data ? (
        <div className="bg-white rounded-lg shadow p-12 text-center text-gray-500">
          <Loader2 className="w-6 h-6 animate-spin inline-block" />
          <div className="mt-2 text-sm">Carregando…</div>
        </div>
      ) : !data || data.byStore.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-12 text-center text-gray-500">
          Nenhuma loja enviou pedidos no período selecionado.
        </div>
      ) : (
        <div className="space-y-3">
          {data.byStore.map((s, idx) => {
            const isOpen = expanded.has(s.storeCode);
            const rank = rankBadge(idx);
            const bar = Math.round((s.count / storesMax) * 100);
            return (
              <div
                key={s.storeCode}
                className={`bg-white rounded-lg shadow border-l-4 ${rankColor(idx)} overflow-hidden`}
              >
                {/* Header do grupo */}
                <button
                  onClick={() => toggleExpand(s.storeCode)}
                  className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 text-left"
                >
                  <div className="flex-shrink-0">
                    {isOpen ? <ChevronDown className="w-5 h-5 text-gray-400" /> : <ChevronRight className="w-5 h-5 text-gray-400" />}
                  </div>
                  <div className="flex-shrink-0 w-10 text-center">
                    <div className="text-lg">{rank.emoji || rank.label}</div>
                  </div>
                  <div className="flex-shrink-0">
                    <StoreIcon className="w-5 h-5 text-gray-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-gray-900">
                      <span className="font-mono text-emerald-700">{s.storeCode}</span>
                      {' '}
                      <span className="text-gray-700">{s.storeName}</span>
                    </div>
                    {/* Barra proporcional à liderança */}
                    <div className="mt-1 h-1.5 bg-gray-100 rounded overflow-hidden max-w-md">
                      <div
                        className="h-full bg-emerald-500"
                        style={{ width: `${bar}%` }}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-sm flex-shrink-0">
                    <div className="text-right">
                      <div className="text-2xl font-bold text-emerald-700">{s.count}</div>
                      <div className="text-[10px] text-gray-500 uppercase">pedidos</div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold">{s.totalItems}</div>
                      <div className="text-[10px] text-gray-500 uppercase">peças</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-semibold text-green-700">{formatMoney(s.totalRevenue)}</div>
                      {(s.transferCount > 0 || s.pickupCount > 0) && (
                        <div className="text-[10px] text-gray-500 mt-0.5">
                          {s.transferCount > 0 && <span className="text-amber-700">{s.transferCount} transf</span>}
                          {s.transferCount > 0 && s.pickupCount > 0 && ' · '}
                          {s.pickupCount > 0 && <span className="text-emerald-700">{s.pickupCount} retir</span>}
                        </div>
                      )}
                    </div>
                  </div>
                </button>

                {/* Lista expandida */}
                {isOpen && (
                  <div className="border-t">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-xs uppercase text-gray-600 border-b">
                        <tr>
                          <th className="text-left px-3 py-2">Horário</th>
                          <th className="text-left px-3 py-2">Pedido</th>
                          <th className="text-left px-3 py-2">Cliente</th>
                          <th className="text-left px-3 py-2">Envio</th>
                          <th className="text-left px-3 py-2">Rastreio</th>
                          <th className="text-right px-3 py-2">Peças</th>
                          <th className="text-right px-3 py-2">Valor</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {s.rows.map((r) => {
                          const mb = methodBadge(r.shippingMethod);
                          return (
                            <tr key={r.pickOrderId} className="hover:bg-gray-50">
                              <td className="px-3 py-2 whitespace-nowrap text-gray-700">
                                <Clock className="w-3 h-3 inline mr-1 text-gray-400" />
                                {formatTime(r.shippedAt)}
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap">
                                {r.wcOrderId ? (
                                  <Link
                                    href={`/pedidos/wc/${r.wcOrderId}`}
                                    className="text-emerald-700 font-mono font-bold hover:underline inline-flex items-center gap-1"
                                  >
                                    #{r.wcOrderNumber ?? r.wcOrderId}
                                    <ExternalLink className="w-3 h-3 opacity-60" />
                                  </Link>
                                ) : (
                                  <span className="text-gray-400 font-mono">—</span>
                                )}
                                {r.isTransfer && (
                                  <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] font-bold text-amber-800 bg-amber-100 border border-amber-300 px-1 py-0.5 rounded">
                                    <Repeat className="w-2.5 h-2.5" />
                                    TRANSF →{r.transferToStoreCode ?? '?'}
                                  </span>
                                )}
                                {r.isPickup && !r.isTransfer && (
                                  <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] font-bold text-emerald-800 bg-emerald-100 border border-emerald-300 px-1 py-0.5 rounded">
                                    <MapPin className="w-2.5 h-2.5" /> RETIRADA
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2 max-w-xs">
                                <div className="truncate" title={r.customerName ?? ''}>
                                  {r.customerName ?? <span className="text-gray-400">—</span>}
                                </div>
                                {r.customerPhone && (
                                  <div className="text-[10px] text-gray-500 flex items-center gap-1">
                                    <Phone className="w-2.5 h-2.5" />
                                    {r.customerPhone}
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <span className={`inline-block text-[10px] font-bold uppercase border rounded px-2 py-0.5 ${mb.color}`}>
                                  {mb.label}
                                </span>
                              </td>
                              <td className="px-3 py-2">
                                {r.trackingCode ? (
                                  <div>
                                    <div className="font-mono text-xs">{r.trackingCode}</div>
                                    {r.carrier && <div className="text-[10px] text-gray-500">{r.carrier}</div>}
                                  </div>
                                ) : (
                                  <span className="text-gray-400 text-xs italic">sem rastreio</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right font-mono">{r.itemsCount}</td>
                              <td className="px-3 py-2 text-right font-mono font-semibold text-green-700">
                                {r.totalAmount ? formatMoney(r.totalAmount) : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
