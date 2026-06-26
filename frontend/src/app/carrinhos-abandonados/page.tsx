'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  Search, RefreshCw, ShoppingCart, Package, ExternalLink,
  CheckCircle2, XCircle, Clock, AlertTriangle, MessageCircle,
  Download, Filter, ChevronDown, ChevronRight, X, DollarSign, TrendingUp,
} from 'lucide-react';

/**
 * Tela /carrinhos-abandonados
 * Consome o plugin MU 'flowops-abandoned-carts' instalado no WordPress.
 * Backend FlowOps faz proxy autenticado em /abandoned-carts/*.
 */

type CartStatus = 'abandoned' | 'completed' | 'lost' | 'normal' | string;

interface CartItem {
  productId: number;
  variationId: number | null;
  quantity: number;
  lineTotal: number | null;
  lineSubtotal: number | null;
  sku: string | null;
  name: string | null;
}

// shape real do plugin PHP (snake_case) — mapeamos aqui pra camelCase pro uso interno.
interface ListResponse {
  ok: boolean;
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
  items: Array<{
    id: number;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    order_status: CartStatus;
    cart_total: number | null;
    items_count: number;
    unsubscribed: number;
    checkout_id: number | null;
    order_id: number | null;
    session_id: string | null;
    time: string | null;
  }>;
  error?: string;
}

interface DetailResponse {
  ok: boolean;
  id: number;
  email: string | null;
  order_status: CartStatus;
  cart_total: number | null;
  session_id: string | null;
  checkout_id: number | null;
  order_id: number | null;
  unsubscribed: number;
  time: string | null;
  cart_items: Array<{
    product_id: number;
    variation_id: number | null;
    quantity: number;
    line_total: number | null;
    line_subtotal: number | null;
    sku: string | null;
    name: string | null;
  }>;
  other_fields: Record<string, any>;
  error?: string;
}

interface StatsResponse {
  ok: boolean;
  since: string | null;
  total_all: number;
  total_value: number;
  by_status: Record<string, { qty: number; total: number }>;
  recovery_rate: number;
  error?: string;
}

const STATUS_OPTS: Array<{ slug: ''; label: string } | { slug: CartStatus; label: string }> = [
  { slug: '',          label: 'Todos' },
  { slug: 'abandoned', label: 'Abandonados' },
  { slug: 'completed', label: 'Recuperados' },
  { slug: 'lost',      label: 'Perdidos' },
  { slug: 'normal',    label: 'Normais' },
];

export default function CarrinhosAbandonadosPage() {
  const [list, setList] = useState<ListResponse | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStats, setLoadingStats] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Se o plugin .php não estiver instalado, a tela faz fallback pra
  // /abandoned-carts/wc-pending/* (WooCommerce REST) — cobertura menor
  // mas funciona sem subir nada no WP.
  const [usingFallback, setUsingFallback] = useState(false);
  const [fallbackWarning, setFallbackWarning] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [perPage] = useState(50);
  const [status, setStatus] = useState<string>('abandoned');
  const [since, setSince] = useState<string>(defaultSince());
  const [until, setUntil] = useState<string>('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  // Detalhe
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => { loadList(); /* eslint-disable-line */ }, [page, status, since, until, search]);
  useEffect(() => { loadStats(); /* eslint-disable-line */ }, [since]);

  function defaultSince() {
    // Default: 30 dias atrás
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  }

  async function loadList() {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      q.set('page', String(page));
      q.set('per_page', String(perPage));
      if (status)  q.set('status', status);
      if (since)   q.set('since', since);
      if (until)   q.set('until', until);
      if (search)  q.set('search', search);

      // 1ª tentativa: plugin .php (dados completos)
      let res = await api<ListResponse & { source?: string; warning?: string }>(
        `/abandoned-carts?${q}`,
      );

      // Fallback automático: se o plugin não respondeu, tenta WC REST
      if (!res.ok) {
        const primaryError = res.error || 'Falha na API';
        try {
          const fb = await api<ListResponse & { source?: string; warning?: string }>(
            `/abandoned-carts/wc-pending/list?${q}`,
          );
          if (!fb.ok) throw new Error(fb.error || primaryError);
          setUsingFallback(true);
          setFallbackWarning(fb.warning ?? null);
          setList(fb);
          return;
        } catch (fbErr: any) {
          // Se o fallback também falhou, mostra o erro original
          throw new Error(primaryError);
        }
      }

      setUsingFallback(false);
      setFallbackWarning(null);
      setList(res);
    } catch (e: any) {
      setError(`Falha ao carregar carrinhos: ${e?.message ?? 'erro desconhecido'}`);
      setList(null);
    } finally {
      setLoading(false);
    }
  }

  async function loadStats() {
    setLoadingStats(true);
    try {
      const q = new URLSearchParams();
      if (since) q.set('since', since);
      if (until) q.set('until', until);

      // 1ª tentativa: plugin .php
      let res = await api<StatsResponse & { source?: string }>(
        `/abandoned-carts/stats?${q}`,
      );

      // Fallback: WC REST
      if (!res.ok) {
        try {
          const fb = await api<StatsResponse & { source?: string }>(
            `/abandoned-carts/wc-pending/stats?${q}`,
          );
          if (fb.ok) { setStats(fb); return; }
        } catch { /* ignora, já tá no fallback da lista */ }
        throw new Error(res.error || 'Falha stats');
      }

      setStats(res);
    } catch {
      setStats(null);
    } finally {
      setLoadingStats(false);
    }
  }

  async function openDetail(id: number) {
    // No modo fallback (WC REST), não temos endpoint de detalhe — abre direto o pedido no WP admin.
    if (usingFallback) {
      const wpAdmin = `https://www.lurds.com.br/wp-admin/post.php?post=${id}&action=edit`;
      window.open(wpAdmin, '_blank');
      return;
    }
    setDetailId(id);
    setDetail(null);
    setLoadingDetail(true);
    try {
      const res = await api<DetailResponse>(`/abandoned-carts/${id}`);
      if (!res.ok) throw new Error(res.error || 'Falha');
      setDetail(res);
    } catch (e: any) {
      alert(`Falha ao carregar detalhe: ${e?.message ?? 'erro desconhecido'}`);
      setDetailId(null);
    } finally {
      setLoadingDetail(false);
    }
  }

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  function fmtMoney(v: number | null | undefined) {
    if (v == null || isNaN(v)) return '—';
    return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function fmtDate(s: string | null | undefined) {
    if (!s) return '—';
    try {
      return new Date(s.replace(' ', 'T') + 'Z').toLocaleString('pt-BR');
    } catch {
      return s;
    }
  }

  /** Número BR -> formato wa.me (só dígitos, com DDI 55 se faltar). */
  function whatsappUrl(phone: string | null | undefined): string | null {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '');
    if (!digits) return null;
    const withDDI = digits.startsWith('55') ? digits : '55' + digits;
    return `https://wa.me/${withDDI}`;
  }

  function statusBadge(s: CartStatus) {
    if (s === 'completed') {
      return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800">recuperado</span>;
    }
    if (s === 'abandoned') {
      return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800">abandonado</span>;
    }
    if (s === 'lost') {
      return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-800">perdido</span>;
    }
    if (s === 'normal') {
      return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-600">normal</span>;
    }
    return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-600">{s}</span>;
  }

  function exportCsv() {
    if (!list || !list.items.length) return;
    const header = ['nome', 'email', 'telefone', 'whatsapp', 'valor', 'itens', 'status', 'cidade', 'uf', 'data'];
    const rows = list.items.map((it) => {
      const nome = [it.first_name, it.last_name].filter(Boolean).join(' ');
      return [
        nome,
        it.email ?? '',
        it.phone ?? '',
        whatsappUrl(it.phone) ?? '',
        (it.cart_total ?? 0).toString().replace('.', ','),
        it.items_count.toString(),
        it.order_status ?? '',
        it.city ?? '',
        it.state ?? '',
        it.time ?? '',
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
    });
    const csv = [header.join(','), ...rows].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `carrinhos-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShoppingCart className="w-6 h-6" />
            Carrinhos abandonados
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {usingFallback
              ? <>Via <b>WooCommerce REST</b> (pedidos não pagos — modo parcial).</>
              : <>Capturado pelo plugin <b>Cart Abandonment Recovery for WooCommerce</b>.</>}
            {list && <> — {list.total.toLocaleString('pt-BR')} registros no filtro atual.</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={exportCsv}
            disabled={!list || list.items.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 transition shadow-sm"
            title="Baixar contatos (CSV) — nome, email, telefone, valor"
          >
            <Download className="w-4 h-4" />
            Exportar contatos (CSV)
          </button>
          <button
            onClick={() => { loadList(); loadStats(); }}
            className="p-2 rounded hover:bg-slate-100"
            title="Atualizar"
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="p-3 rounded border bg-amber-50">
          <div className="text-xs text-amber-700 flex items-center gap-1">
            <ShoppingCart className="w-3 h-3" /> Abandonados
          </div>
          <div className="text-2xl font-bold text-amber-900">
            {stats?.by_status?.abandoned?.qty?.toLocaleString('pt-BR') ?? (loadingStats ? '...' : '—')}
          </div>
          <div className="text-xs text-amber-800">
            {fmtMoney(stats?.by_status?.abandoned?.total ?? null)}
          </div>
        </div>
        <div className="p-3 rounded border bg-emerald-50">
          <div className="text-xs text-emerald-700 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Recuperados
          </div>
          <div className="text-2xl font-bold text-emerald-900">
            {stats?.by_status?.completed?.qty?.toLocaleString('pt-BR') ?? (loadingStats ? '...' : '—')}
          </div>
          <div className="text-xs text-emerald-800">
            {fmtMoney(stats?.by_status?.completed?.total ?? null)}
          </div>
        </div>
        <div className="p-3 rounded border bg-red-50">
          <div className="text-xs text-red-700 flex items-center gap-1">
            <XCircle className="w-3 h-3" /> Perdidos
          </div>
          <div className="text-2xl font-bold text-red-900">
            {stats?.by_status?.lost?.qty?.toLocaleString('pt-BR') ?? (loadingStats ? '...' : '—')}
          </div>
          <div className="text-xs text-red-800">
            {fmtMoney(stats?.by_status?.lost?.total ?? null)}
          </div>
        </div>
        <div className="p-3 rounded border bg-violet-50">
          <div className="text-xs text-violet-700 flex items-center gap-1">
            <TrendingUp className="w-3 h-3" /> Taxa de recuperação
          </div>
          <div className="text-2xl font-bold text-violet-900">
            {stats ? `${stats.recovery_rate.toFixed(1)}%` : '—'}
          </div>
          <div className="text-xs text-violet-800">
            completed / (completed + abandoned + lost)
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 p-3 rounded mb-4 text-sm flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-semibold">Não consegui carregar os carrinhos.</div>
            <div className="text-xs">{error}</div>
            <div className="text-xs mt-1 text-slate-600">
              Nem o plugin <code>flowops-abandoned-carts.php</code> (<code>wp-content/mu-plugins/</code>) nem
              o fallback WooCommerce REST (<code>WC_CONSUMER_KEY</code>/<code>WC_CONSUMER_SECRET</code>) responderam.
            </div>
          </div>
        </div>
      )}

      {usingFallback && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 p-3 rounded mb-4 text-sm flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <div className="font-semibold">Modo fallback: WooCommerce REST (parcial)</div>
            <div className="text-xs mt-0.5">
              O plugin <code>flowops-abandoned-carts.php</code> não está ativo. Estamos listando pedidos
              com status <b>pending</b>, <b>failed</b> e <b>on-hold</b> (iniciaram o checkout e não pagaram).
              Carrinhos que morreram <i>antes</i> de virar pedido não aparecem aqui.
            </div>
            {fallbackWarning && (
              <div className="text-[11px] mt-1 text-amber-700 italic">{fallbackWarning}</div>
            )}
            <div className="text-[11px] mt-1">
              Pra cobertura total, instale o arquivo <code>wp-plugin/flowops-abandoned-carts.php</code> em
              <code> wp-content/mu-plugins/</code> do WordPress.
            </div>
          </div>
        </div>
      )}

      {/* Filtros */}
      <div className="mb-4 p-3 bg-white rounded border flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-1 flex-wrap">
          <Filter className="w-4 h-4 text-slate-400 mr-1" />
          {STATUS_OPTS.map((o) => (
            <button
              key={o.slug || 'all'}
              onClick={() => { setStatus(o.slug); setPage(1); }}
              className={`px-3 py-1.5 rounded text-xs border transition ${
                status === o.slug ? 'bg-brand text-white border-brand' : 'bg-white hover:bg-slate-50'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <label className="block">
          <div className="text-[10px] font-semibold text-slate-500 uppercase">Desde</div>
          <input
            type="date"
            value={since}
            onChange={(e) => { setSince(e.target.value); setPage(1); }}
            className="px-2 py-1.5 border rounded text-sm"
          />
        </label>
        <label className="block">
          <div className="text-[10px] font-semibold text-slate-500 uppercase">Até</div>
          <input
            type="date"
            value={until}
            onChange={(e) => { setUntil(e.target.value); setPage(1); }}
            className="px-2 py-1.5 border rounded text-sm"
          />
        </label>
        <form onSubmit={onSearchSubmit} className="flex gap-1 ml-auto">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Email, nome ou telefone..."
              className="pl-9 pr-3 py-1.5 border rounded text-sm w-64"
            />
          </div>
          <button type="submit" className="px-3 py-1.5 border rounded hover:bg-slate-50 text-sm">
            Buscar
          </button>
          {search && (
            <button
              type="button"
              onClick={() => { setSearchInput(''); setSearch(''); setPage(1); }}
              className="px-2 text-sm text-slate-500 hover:text-slate-800"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </form>
      </div>

      {/* Lista */}
      <div className="bg-white rounded shadow overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-3 text-left">Cliente</th>
              <th className="p-3 text-left">Contato</th>
              <th className="p-3 text-right">Valor</th>
              <th className="p-3 text-center">Itens</th>
              <th className="p-3 text-center">Status</th>
              <th className="p-3 text-left">Data</th>
              <th className="p-3 text-center w-[80px]">Ações</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="p-6 text-center text-slate-400">Carregando...</td></tr>
            )}
            {!loading && (!list || list.items.length === 0) && (
              <tr>
                <td colSpan={7} className="p-8 text-center text-slate-400">
                  Nenhum carrinho encontrado no filtro.
                </td>
              </tr>
            )}
            {!loading && list?.items.map((it) => {
              const nome = [it.first_name, it.last_name].filter(Boolean).join(' ').trim() || '—';
              const wa = whatsappUrl(it.phone);
              return (
                <tr key={it.id} className="border-t hover:bg-slate-50">
                  <td className="p-3">
                    <div className="font-semibold text-slate-800">{nome}</div>
                    {(it.city || it.state) && (
                      <div className="text-xs text-slate-500">
                        {[it.city, it.state].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="p-3">
                    <div className="text-xs font-mono text-slate-700">{it.email ?? '—'}</div>
                    {it.phone && (
                      <div className="text-xs text-slate-500">{it.phone}</div>
                    )}
                  </td>
                  <td className="p-3 text-right font-mono font-semibold text-slate-800">
                    {fmtMoney(it.cart_total)}
                  </td>
                  <td className="p-3 text-center">
                    <span className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded text-xs font-semibold">
                      {it.items_count}
                    </span>
                  </td>
                  <td className="p-3 text-center">{statusBadge(it.order_status)}</td>
                  <td className="p-3 text-xs text-slate-600">{fmtDate(it.time)}</td>
                  <td className="p-3">
                    <div className="flex items-center justify-center gap-1">
                      {wa && (
                        <a
                          href={wa}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-700"
                          title="Abrir WhatsApp"
                        >
                          <MessageCircle className="w-4 h-4" />
                        </a>
                      )}
                      <button
                        onClick={() => openDetail(it.id)}
                        className="p-1.5 rounded bg-violet-50 hover:bg-violet-100 text-violet-700"
                        title="Ver itens"
                      >
                        <Package className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {/* Paginação */}
      {list && list.total_pages > 1 && (
        <div className="flex justify-between items-center mt-4 text-sm text-slate-600">
          <div>
            {list.total.toLocaleString('pt-BR')} carrinhos — página {page} de {list.total_pages}
          </div>
          <div className="flex gap-1">
            <button disabled={page === 1} onClick={() => setPage(1)}
              className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50">«</button>
            <button disabled={page === 1} onClick={() => setPage(page - 1)}
              className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50">‹</button>
            <span className="px-3 py-1">{page}</span>
            <button disabled={page >= list.total_pages} onClick={() => setPage(page + 1)}
              className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50">›</button>
            <button disabled={page >= list.total_pages} onClick={() => setPage(list.total_pages)}
              className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50">»</button>
          </div>
        </div>
      )}

      {/* MODAL DETALHE */}
      {detailId !== null && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b bg-violet-50">
              <h3 className="font-bold text-violet-900 flex items-center gap-2">
                <ShoppingCart className="w-5 h-5" />
                Carrinho #{detailId}
              </h3>
              <button
                onClick={() => { setDetailId(null); setDetail(null); }}
                className="p-1 hover:bg-violet-100 rounded"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 overflow-auto flex-1 text-sm space-y-3">
              {loadingDetail && (
                <div className="flex items-center gap-2 text-slate-500 py-6 justify-center">
                  <RefreshCw className="w-4 h-4 animate-spin" /> Carregando...
                </div>
              )}

              {detail && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-2 rounded border bg-slate-50">
                      <div className="text-[10px] font-semibold text-slate-500 uppercase">Email</div>
                      <div className="text-sm font-mono">{detail.email ?? '—'}</div>
                    </div>
                    <div className="p-2 rounded border bg-slate-50">
                      <div className="text-[10px] font-semibold text-slate-500 uppercase">Telefone</div>
                      <div className="text-sm">
                        {detail.other_fields?.wcf_phone_number ?? '—'}
                        {detail.other_fields?.wcf_phone_number && whatsappUrl(detail.other_fields.wcf_phone_number) && (
                          <a
                            href={whatsappUrl(detail.other_fields.wcf_phone_number) as string}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-2 inline-flex items-center gap-1 text-xs text-emerald-700 hover:underline"
                          >
                            <MessageCircle className="w-3 h-3" /> WhatsApp
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="p-2 rounded border bg-slate-50">
                      <div className="text-[10px] font-semibold text-slate-500 uppercase">Status</div>
                      <div>{statusBadge(detail.order_status)}</div>
                    </div>
                    <div className="p-2 rounded border bg-slate-50">
                      <div className="text-[10px] font-semibold text-slate-500 uppercase">Valor total</div>
                      <div className="text-sm font-mono font-semibold">{fmtMoney(detail.cart_total)}</div>
                    </div>
                    <div className="p-2 rounded border bg-slate-50 col-span-2">
                      <div className="text-[10px] font-semibold text-slate-500 uppercase">Endereço</div>
                      <div className="text-xs text-slate-700">
                        {[
                          detail.other_fields?.wcf_billing_address_1,
                          detail.other_fields?.wcf_billing_address_2,
                          detail.other_fields?.wcf_billing_city,
                          detail.other_fields?.wcf_billing_state,
                          detail.other_fields?.wcf_billing_postcode,
                        ].filter(Boolean).join(', ') || '—'}
                      </div>
                    </div>
                    <div className="p-2 rounded border bg-slate-50 col-span-2">
                      <div className="text-[10px] font-semibold text-slate-500 uppercase">Data</div>
                      <div className="text-xs">{fmtDate(detail.time)}</div>
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-semibold text-slate-600 mb-1">
                      Itens do carrinho ({detail.cart_items.length})
                    </div>
                    <div className="border rounded overflow-hidden">
                      <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-100">
                          <tr>
                            <th className="p-2 text-left">Produto</th>
                            <th className="p-2 text-left">SKU</th>
                            <th className="p-2 text-center">Qtd</th>
                            <th className="p-2 text-right">Subtotal</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.cart_items.map((it, idx) => (
                            <tr key={idx} className="border-t">
                              <td className="p-2">{it.name ?? '—'}</td>
                              <td className="p-2 font-mono">{it.sku ?? '—'}</td>
                              <td className="p-2 text-center font-semibold">{it.quantity}</td>
                              <td className="p-2 text-right font-mono">{fmtMoney(it.line_total ?? it.line_subtotal)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      </div>
                    </div>
                  </div>

                  {detail.order_id && (
                    <div className="p-2 rounded bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
                      <CheckCircle2 className="w-3 h-3 inline mr-1" />
                      Pedido <b>#{detail.order_id}</b> — carrinho foi recuperado.
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="p-3 border-t bg-slate-50 flex justify-end">
              <button
                onClick={() => { setDetailId(null); setDetail(null); }}
                className="px-4 py-2 rounded text-sm font-semibold bg-slate-800 hover:bg-slate-900 text-white"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
