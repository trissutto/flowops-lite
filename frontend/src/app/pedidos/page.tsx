'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import Link from 'next/link';
import { RefreshCw, Search, ExternalLink } from 'lucide-react';

const WC_ADMIN_URL = 'https://www.lurds.com.br/wp-admin/admin.php?page=wc-orders&action=edit&id=';

/**
 * Tela /pedidos — espelho do admin do WooCommerce.
 * - Filtros, nomes e contadores batem com WP (lurds.com.br/wp-admin?page=wc-orders).
 * - Lista vem direto do WC REST API (puxa em tempo real).
 */

// Status do WC: slug → label em pt-BR (mesmos nomes que aparecem no admin WP)
// + custom status "em-separacao" (Separação) usado no workflow da loja
const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  'pending':       { label: 'Pagamento pendente', color: 'bg-amber-100 text-amber-800' },
  'separacao':     { label: 'Separação',          color: 'bg-blue-100 text-blue-800' },
  'processing':    { label: 'Processando',        color: 'bg-emerald-100 text-emerald-800 font-bold' },
  'completed':     { label: 'Concluído',          color: 'bg-slate-200 text-slate-700' },
  'on-hold':       { label: 'Aguardando',         color: 'bg-yellow-100 text-yellow-800' },
  'cancelled':     { label: 'Cancelado',          color: 'bg-slate-100 text-slate-500' },
  'refunded':      { label: 'Reembolsado',        color: 'bg-purple-100 text-purple-700' },
  'failed':        { label: 'Malsucedido',        color: 'bg-red-100 text-red-700' },
  'checkout-draft':{ label: 'Rascunho',           color: 'bg-slate-100 text-slate-500' },
};

// Ordem dos filtros na tela — igual WP admin
const FILTROS: Array<{ slug: string; label: string }> = [
  { slug: '',              label: 'Todas' },
  { slug: 'pending',       label: 'Pagamento pendente' },
  { slug: 'separacao',     label: 'Separação' },
  { slug: 'processing',    label: 'Processando' },
  { slug: 'completed',     label: 'Concluído' },
  { slug: 'on-hold',       label: 'Aguardando' },
  { slug: 'cancelled',     label: 'Cancelado' },
  { slug: 'refunded',      label: 'Reembolsado' },
  { slug: 'failed',        label: 'Malsucedido' },
];

interface WcOrder {
  id: number;
  number: string;
  status: string;
  dateCreatedGmt: string;
  total: string;
  currency: string;
  customerName: string;
  origem: string;
  source: string;
  // NOVO: loja responsável pela separação (vem do banco interno via pick-orders)
  pickOrders?: Array<{ storeCode: string | null; storeName: string | null; status: string }>;
}

interface StoreInfo {
  code: string;
  name: string;
  city: string | null;
  state: string | null;
  openOrders: number;
}

export default function PedidosPage() {
  return (
    <Suspense fallback={<div className="p-6">Carregando…</div>}>
      <PedidosPageInner />
    </Suspense>
  );
}

function PedidosPageInner() {
  const searchParams = useSearchParams();
  // Status inicial vem do query param ?status=processing (usado pelo botão
  // "Voltar pra lista" do detalhe pra preservar o filtro).
  const initialStatus = searchParams?.get('status') ?? '';
  // Hoje em YYYY-MM-DD (timezone local) — default do filtro de data.
  const todayStr = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const [data, setData] = useState<WcOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [counts, setCounts] = useState<Record<string, { name: string; total: number }>>({});
  const [grand, setGrand] = useState(0);
  const [status, setStatus] = useState<string>(initialStatus);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  // Filtros de data INICIAM VAZIOS — mostra todos os pedidos.
  // Antes vinha preenchido com hoje (todayStr), o que escondia pedidos
  // mais antigos e atrapalhava a operação. Vendedora/admin escolhe data
  // manualmente quando quiser filtrar.
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [storeCode, setStoreCode] = useState<string>('');
  const [stores, setStores] = useState<StoreInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { load(); /* eslint-disable-line */ }, [status, page, search, dateFrom, dateTo, storeCode]);
  useEffect(() => {
    loadCounts();
    loadStores();
    const t = setInterval(loadCounts, 30_000);
    return () => clearInterval(t);
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (status) q.set('status', status);
      q.set('page', String(page));
      // Quando filtra loja, busca o máximo permitido pelo WC (100) pra compensar fallback
      q.set('per_page', storeCode ? '100' : '50');
      // Nota: WC REST aceita no MÁXIMO 100, valores maiores retornam HTTP 500
      if (search) q.set('search', search);
      if (storeCode) q.set('storeCode', storeCode);
      // Datas: WooCommerce REST aceita ISO 8601. Início do dia local → 00:00,
      // fim do dia → 23:59:59 (inclusivo).
      if (dateFrom) q.set('after', `${dateFrom}T00:00:00`);
      if (dateTo) q.set('before', `${dateTo}T23:59:59`);
      const res = await api<{ data: WcOrder[]; total: number; totalPages: number }>(`/orders/wc?${q}`);
      // FALLBACK LOCAL com match flexível (acentos/case + code OU name)
      const normalize = (s: any) =>
        String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
      const target = normalize(storeCode);
      const filtered = storeCode
        ? (res.data || []).filter((o: any) =>
            (o.pickOrders || []).some((p: any) =>
              normalize(p?.storeCode) === target || normalize(p?.storeName) === target,
            ),
          )
        : res.data;
      setData(filtered);
      setTotal(storeCode ? filtered.length : res.total);
      setTotalPages(storeCode ? 1 : res.totalPages);
    } catch (e: any) {
      setError(`Falha ao consultar WooCommerce: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadCounts() {
    try {
      const res = await api<{ byStatus: Record<string, { name: string; total: number }>; grand: number }>('/orders/wc/counts');
      setCounts(res.byStatus);
      setGrand(res.grand);
    } catch {
      // silencioso — o polling de 30s vai retentar
    }
  }

  async function loadStores() {
    try {
      const res = await api<{ stores: StoreInfo[] }>('/orders/wc/stores-load');
      setStores(res.stores);
    } catch {
      // silencioso — sem lojas, dropdown fica vazio
    }
  }

  function fmtDate(iso: string) {
    if (!iso) return '—';
    const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
    const diff = Date.now() - d.getTime();
    const min = Math.floor(diff / 60000);
    const h = Math.floor(min / 60);
    const dias = Math.floor(h / 24);
    if (min < 1) return 'agora mesmo';
    if (min < 60) return `${min} minuto${min === 1 ? '' : 's'} atrás`;
    if (h < 24) return `${h} hora${h === 1 ? '' : 's'} atrás`;
    if (dias < 7) return `${dias} dia${dias === 1 ? '' : 's'} atrás`;
    return d.toLocaleDateString('pt-BR');
  }

  function fmtMoney(v: string | number | undefined) {
    const n = Number(v ?? 0);
    if (!n) return '—';
    return `R$ ${n.toFixed(2).replace('.', ',')}`;
  }

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  function changeFilter(slug: string) {
    setStatus(slug);
    setPage(1);
  }

  return (
    <div className="max-w-7xl mx-auto p-3 sm:p-6">
      <div className="flex justify-between items-start sm:items-center mb-3 sm:mb-4 gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl sm:text-2xl font-bold">Pedidos</h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-0.5 sm:mt-1">
            <span className="hidden sm:inline">Dados ao vivo do WooCommerce — </span>
            {grand.toLocaleString('pt-BR')} pedidos
          </p>
        </div>
        <button
          onClick={() => { load(); loadCounts(); }}
          className="p-2 rounded hover:bg-slate-100"
          title="Atualizar"
        >
          <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && <div className="bg-red-50 text-red-700 p-3 rounded mb-4 text-sm">{error}</div>}

      {/* Filtros por status — scroll horizontal no mobile, wrap no desktop */}
      <div className="mb-3 sm:mb-4 -mx-3 sm:mx-0 px-3 sm:px-0 overflow-x-auto sm:overflow-visible">
        <div className="flex sm:flex-wrap gap-2 min-w-max sm:min-w-0">
          {FILTROS.map((f) => {
            const n = f.slug === '' ? grand : (counts[f.slug]?.total ?? 0);
            const isActive = status === f.slug;
            return (
              <button
                key={f.slug || 'all'}
                onClick={() => changeFilter(f.slug)}
                className={`px-2.5 sm:px-3 py-1.5 rounded text-xs sm:text-sm border transition whitespace-nowrap shrink-0 ${
                  isActive ? 'bg-brand text-white border-brand' : 'bg-white hover:bg-slate-50'
                } ${n === 0 && !isActive ? 'opacity-40' : ''}`}
              >
                {f.label}
                <span className={`ml-1.5 sm:ml-2 px-1.5 py-0.5 rounded text-[10px] sm:text-xs font-bold ${
                  isActive ? 'bg-white text-brand' : 'bg-slate-100 text-slate-600'
                }`}>
                  {n.toLocaleString('pt-BR')}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Filtro de data + atalhos rápidos */}
      <div className="mb-3 bg-slate-50 border border-slate-200 rounded p-2.5 space-y-2 sm:space-y-0 sm:flex sm:flex-wrap sm:items-center sm:gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-slate-700 uppercase tracking-wide">Período:</span>
          <input
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
            className="px-2 py-1.5 border rounded text-sm font-mono flex-1 sm:flex-initial min-w-0"
          />
          <span className="text-slate-400 text-sm">até</span>
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
            className="px-2 py-1.5 border rounded text-sm font-mono flex-1 sm:flex-initial min-w-0"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
        {/* Atalhos rápidos */}
        <button
          type="button"
          onClick={() => {
            const t = new Date();
            const s = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
            setDateFrom(s); setDateTo(s); setPage(1);
          }}
          className="px-2 py-1 text-xs font-semibold border rounded hover:bg-white"
        >
          Hoje
        </button>
        <button
          type="button"
          onClick={() => {
            const t = new Date();
            t.setDate(t.getDate() - 1);
            const s = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
            setDateFrom(s); setDateTo(s); setPage(1);
          }}
          className="px-2 py-1 text-xs font-semibold border rounded hover:bg-white"
        >
          Ontem
        </button>
        <button
          type="button"
          onClick={() => {
            const hoje = new Date();
            const ini = new Date();
            ini.setDate(hoje.getDate() - 6);
            const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            setDateFrom(fmt(ini)); setDateTo(fmt(hoje)); setPage(1);
          }}
          className="px-2 py-1 text-xs font-semibold border rounded hover:bg-white"
        >
          7 dias
        </button>
        <button
          type="button"
          onClick={() => {
            const t = new Date();
            const ini = new Date(t.getFullYear(), t.getMonth(), 1);
            const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            setDateFrom(fmt(ini)); setDateTo(fmt(t)); setPage(1);
          }}
          className="px-2 py-1 text-xs font-semibold border rounded hover:bg-white"
        >
          Mês
        </button>
        <button
          type="button"
          onClick={() => { setDateFrom(''); setDateTo(''); setPage(1); }}
          className="px-2 py-1 text-xs text-slate-500 hover:text-rose-700"
          title="Remove filtro de data (mostra tudo)"
        >
          ✕ Limpar
        </button>
        </div>
      </div>

      {/* Busca + filtro de loja — stack no mobile, inline no desktop */}
      <div className="mb-4 flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:items-center">
        <form onSubmit={onSearchSubmit} className="flex gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-72 sm:flex-initial">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Pedido, nome ou email..."
              className="w-full pl-9 pr-3 py-2 border rounded text-sm"
            />
          </div>
          <button type="submit" className="px-3 sm:px-4 py-2 border rounded hover:bg-slate-50 text-sm font-semibold shrink-0">
            Buscar
          </button>
          {search && (
            <button
              type="button"
              onClick={() => { setSearchInput(''); setSearch(''); }}
              className="px-2 sm:px-3 py-2 text-sm text-slate-500 hover:text-slate-800 shrink-0"
            >
              ✕
            </button>
          )}
        </form>

        {/* Filtro de LOJA RESPONSÁVEL */}
        <div className="flex items-center gap-2 sm:ml-auto w-full sm:w-auto">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-600 shrink-0">
            Loja:
          </span>
          <select
            value={storeCode}
            onChange={(e) => { setStoreCode(e.target.value); setPage(1); }}
            className="px-3 py-2 border rounded text-sm bg-white flex-1 sm:flex-initial sm:min-w-[200px]"
          >
            <option value="">Todas as lojas</option>
            {stores.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}{s.openOrders > 0 ? ` (${s.openOrders})` : ''}
              </option>
            ))}
          </select>
          {storeCode && (
            <button
              type="button"
              onClick={() => { setStoreCode(''); setPage(1); }}
              className="px-2 py-1 text-xs text-slate-500 hover:text-rose-700 shrink-0"
              title="Limpar filtro de loja"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Indicador de filtro ativo */}
      {storeCode && (
        <div className="mb-3 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-900 flex items-center gap-2">
          <span>📦 Mostrando apenas pedidos da loja</span>
          <strong>{stores.find((s) => s.code === storeCode)?.name || storeCode}</strong>
          <span className="text-blue-700/70 ml-auto text-xs">
            {data.length} pedido{data.length === 1 ? '' : 's'} encontrado{data.length === 1 ? '' : 's'}
          </span>
        </div>
      )}

      {/* ─── MOBILE: CARDS (sm:hidden) ─── */}
      <div className="sm:hidden space-y-2">
        {loading && (
          <div className="p-6 text-center text-slate-400 bg-white rounded shadow">Carregando…</div>
        )}
        {!loading && data.length === 0 && (
          <div className="p-8 text-center text-slate-400 bg-white rounded shadow">
            Nenhum pedido nesse filtro.
          </div>
        )}
        {!loading && data.map((o) => {
          const s = STATUS_LABELS[o.status] ?? { label: o.status, color: 'bg-slate-100' };
          return (
            <Link
              key={o.id}
              href={`/pedidos/wc/${o.id}`}
              className="block bg-white rounded-lg shadow border border-slate-200 active:bg-slate-50 p-3"
            >
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="font-mono font-bold text-brand text-base">#{o.number}</div>
                <div className="text-[10px] text-slate-500 text-right shrink-0">{fmtDate(o.dateCreatedGmt)}</div>
              </div>
              {o.customerName && (
                <div className="text-sm font-medium text-slate-800 truncate mb-1.5">{o.customerName}</div>
              )}
              <div className="flex items-center gap-1.5 flex-wrap mb-2">
                <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${s.color}`}>
                  {s.label}
                </span>
                {o.pickOrders && o.pickOrders.length > 0 && o.pickOrders.map((p, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-50 text-emerald-800 border border-emerald-200"
                  >
                    🏪 {p.storeName || p.storeCode}
                  </span>
                ))}
              </div>
              <div className="flex items-end justify-between">
                <span className="text-xs text-slate-400">Total</span>
                <span className="font-mono font-bold text-lg text-slate-900">{fmtMoney(o.total)}</span>
              </div>
            </Link>
          );
        })}
      </div>

      {/* ─── DESKTOP: TABELA (hidden sm:block) ─── */}
      <div className="hidden sm:block bg-white rounded shadow overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-3 text-left">Pedido</th>
              <th className="p-3 text-left">Data</th>
              <th className="p-3 text-left">Status</th>
              <th className="p-3 text-left">Loja responsável</th>
              <th className="p-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} className="p-6 text-center text-slate-400">Carregando...</td></tr>
            )}
            {!loading && data.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-slate-400">
                  Nenhum pedido nesse filtro.
                </td>
              </tr>
            )}
            {!loading && data.map((o) => {
              const s = STATUS_LABELS[o.status] ?? { label: o.status, color: 'bg-slate-100' };
              return (
                <tr key={o.id} className="border-t hover:bg-slate-50">
                  <td className="p-3 font-mono">
                    <Link
                      href={`/pedidos/wc/${o.id}`}
                      className="text-brand font-semibold hover:underline"
                      title="Abrir pedido"
                    >
                      #{o.number}
                    </Link>
                    <a
                      href={`${WC_ADMIN_URL}${o.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-2 text-slate-400 hover:text-brand inline-flex"
                      title="Abrir no WordPress"
                    >
                      <ExternalLink className="w-3 h-3" />
                    </a>
                    {o.customerName && <div className="text-xs text-slate-500 mt-0.5">{o.customerName}</div>}
                  </td>
                  <td className="p-3 text-slate-600">{fmtDate(o.dateCreatedGmt)}</td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${s.color}`}>
                      {s.label}
                    </span>
                  </td>
                  <td className="p-3">
                    {o.pickOrders && o.pickOrders.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {o.pickOrders.map((p, idx) => (
                          <button
                            key={idx}
                            onClick={() => { setStoreCode(p.storeCode || ''); setPage(1); }}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100"
                            title={`Filtrar por ${p.storeName}`}
                          >
                            🏪 {p.storeName || p.storeCode}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400 italic">Não roteado</span>
                    )}
                  </td>
                  <td className="p-3 text-right font-mono">{fmtMoney(o.total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {/* Paginação */}
      {totalPages > 1 && (
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center mt-4 gap-2 text-xs sm:text-sm text-slate-600">
          <div className="text-center sm:text-left">
            {total.toLocaleString('pt-BR')} itens · pg {page} de {totalPages}
          </div>
          <div className="flex gap-1 justify-center sm:justify-end">
            <button
              disabled={page === 1}
              onClick={() => setPage(1)}
              className="px-3 py-1.5 sm:py-1 border rounded disabled:opacity-30 hover:bg-slate-50 min-w-[40px]"
            >«</button>
            <button
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
              className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50"
            >‹</button>
            <span className="px-3 py-1">{page}</span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
              className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50"
            >›</button>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(totalPages)}
              className="px-3 py-1.5 sm:py-1 border rounded disabled:opacity-30 hover:bg-slate-50 min-w-[40px]"
            >»</button>
          </div>
        </div>
      )}
    </div>
  );
}
