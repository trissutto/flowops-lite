'use client';
import { useEffect, useState } from 'react';
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
}

export default function PedidosPage() {
  const [data, setData] = useState<WcOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [counts, setCounts] = useState<Record<string, { name: string; total: number }>>({});
  const [grand, setGrand] = useState(0);
  const [status, setStatus] = useState<string>('');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { load(); /* eslint-disable-line */ }, [status, page, search]);
  useEffect(() => {
    loadCounts();
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
      q.set('per_page', '50');
      if (search) q.set('search', search);
      const res = await api<{ data: WcOrder[]; total: number; totalPages: number }>(`/orders/wc?${q}`);
      setData(res.data);
      setTotal(res.total);
      setTotalPages(res.totalPages);
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
    <div className="max-w-7xl mx-auto p-6">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h1 className="text-2xl font-bold">Pedidos</h1>
          <p className="text-sm text-slate-500 mt-1">Dados ao vivo do WooCommerce — {grand.toLocaleString('pt-BR')} pedidos no total</p>
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

      {/* Filtros por status — igual admin do WP */}
      <div className="mb-4 flex flex-wrap gap-2">
        {FILTROS.map((f) => {
          const n = f.slug === '' ? grand : (counts[f.slug]?.total ?? 0);
          const isActive = status === f.slug;
          return (
            <button
              key={f.slug || 'all'}
              onClick={() => changeFilter(f.slug)}
              className={`px-3 py-1.5 rounded text-sm border transition ${
                isActive ? 'bg-brand text-white border-brand' : 'bg-white hover:bg-slate-50'
              } ${n === 0 && !isActive ? 'opacity-40' : ''}`}
            >
              {f.label}
              <span className={`ml-2 px-1.5 py-0.5 rounded text-xs font-bold ${
                isActive ? 'bg-white text-brand' : 'bg-slate-100 text-slate-600'
              }`}>
                {n.toLocaleString('pt-BR')}
              </span>
            </button>
          );
        })}
      </div>

      {/* Busca */}
      <form onSubmit={onSearchSubmit} className="mb-4 flex gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Pesquisar pedido (número, nome, email)..."
            className="w-full pl-9 pr-3 py-2 border rounded text-sm"
          />
        </div>
        <button type="submit" className="px-4 py-2 border rounded hover:bg-slate-50 text-sm">
          Pesquisar pedidos
        </button>
        {search && (
          <button
            type="button"
            onClick={() => { setSearchInput(''); setSearch(''); }}
            className="px-3 py-2 text-sm text-slate-500 hover:text-slate-800"
          >
            Limpar
          </button>
        )}
      </form>

      {/* Tabela — mesmas colunas do admin WP */}
      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-3 text-left">Pedido</th>
              <th className="p-3 text-left">Data</th>
              <th className="p-3 text-left">Status</th>
              <th className="p-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={4} className="p-6 text-center text-slate-400">Carregando...</td></tr>
            )}
            {!loading && data.length === 0 && (
              <tr>
                <td colSpan={4} className="p-8 text-center text-slate-400">
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
                  <td className="p-3 text-right font-mono">{fmtMoney(o.total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Paginação */}
      {totalPages > 1 && (
        <div className="flex justify-between items-center mt-4 text-sm text-slate-600">
          <div>
            {total.toLocaleString('pt-BR')} itens — página {page} de {totalPages}
          </div>
          <div className="flex gap-1">
            <button
              disabled={page === 1}
              onClick={() => setPage(1)}
              className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50"
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
              className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50"
            >»</button>
          </div>
        </div>
      )}
    </div>
  );
}
