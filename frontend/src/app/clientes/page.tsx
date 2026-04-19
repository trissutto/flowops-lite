'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Search, RefreshCw, Download, ArrowUpDown, ArrowUp, ArrowDown, Users, DollarSign, TrendingUp, DownloadCloud, AlertCircle, CheckCircle2 } from 'lucide-react';

/**
 * Tela /clientes — base agregada de todos os clientes que já compraram.
 *
 * Dados agrupados por email (case-insensitive) a partir da tabela Order:
 * nome, email, telefone, qtd de pedidos, valor total gasto, ticket médio,
 * data do último pedido.
 *
 * Pedidos cancelados/falhados não entram na contagem.
 */

interface Customer {
  email: string;
  name: string | null;
  phone: string | null;
  orderCount: number;
  totalSpent: number;
  avgTicket: number;
  firstOrder: string;
  lastOrder: string;
}

interface CustomersResponse {
  data: Customer[];
  total: number;
  page: number;
  limit: number;
  stats: {
    totalCustomers: number;
    totalRevenue: number;
    overallAvgTicket: number;
  };
}

interface SyncState {
  running: boolean;
  page: number;
  totalPages: number;
  imported: number;
  errors: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

type SortField = 'totalSpent' | 'orderCount' | 'avgTicket' | 'lastOrder' | 'name';

export default function ClientesPage() {
  const [data, setData] = useState<Customer[]>([]);
  const [stats, setStats] = useState({ totalCustomers: 0, totalRevenue: 0, overallAvgTicket: 0 });
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [orderBy, setOrderBy] = useState<SortField>('totalSpent');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => { load(); /* eslint-disable-line */ }, [page, search, orderBy, order]);

  // Polling do status da sync enquanto estiver rodando
  useEffect(() => {
    loadSyncStatus();
    if (!syncState?.running) return;

    const t = setInterval(() => {
      loadSyncStatus(true);
    }, 2000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncState?.running]);

  async function loadSyncStatus(reloadOnDone = false) {
    try {
      const res = await api<SyncState>('/customers/sync/status');
      const wasRunning = syncState?.running;
      setSyncState(res);
      // Se acabou de terminar, recarrega a lista automaticamente
      if (reloadOnDone && wasRunning && !res.running) {
        await load();
      }
    } catch {
      // silencioso
    }
  }

  async function startSync() {
    setSyncing(true);
    try {
      await api('/customers/sync', { method: 'POST' });
      await loadSyncStatus();
    } catch (e: any) {
      alert(`Falha ao iniciar sincronização: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      q.set('page', String(page));
      q.set('limit', String(limit));
      q.set('orderBy', orderBy);
      q.set('order', order);
      if (search) q.set('search', search);
      const res = await api<CustomersResponse>(`/customers?${q}`);
      setData(res.data);
      setTotal(res.total);
      setStats(res.stats);
    } catch (e: any) {
      setError(`Falha ao carregar clientes: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  function toggleSort(field: SortField) {
    if (orderBy === field) {
      setOrder(order === 'asc' ? 'desc' : 'asc');
    } else {
      setOrderBy(field);
      setOrder(field === 'name' ? 'asc' : 'desc');
    }
    setPage(1);
  }

  function sortIcon(field: SortField) {
    if (orderBy !== field) return <ArrowUpDown className="w-3 h-3 opacity-40 inline ml-1" />;
    return order === 'desc'
      ? <ArrowDown className="w-3 h-3 inline ml-1" />
      : <ArrowUp className="w-3 h-3 inline ml-1" />;
  }

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  function fmtMoney(v: number) {
    return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function fmtDate(iso: string) {
    if (!iso) return '—';
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const dias = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (dias === 0) return 'hoje';
    if (dias === 1) return 'ontem';
    if (dias < 30) return `${dias} dias atrás`;
    if (dias < 365) return `${Math.floor(dias / 30)} meses atrás`;
    return d.toLocaleDateString('pt-BR');
  }

  async function exportCsv() {
    setExporting(true);
    try {
      // Puxa TODOS (sem paginação) respeitando busca e ordenação atuais
      const q = new URLSearchParams();
      q.set('page', '1');
      q.set('limit', '10000');
      q.set('orderBy', orderBy);
      q.set('order', order);
      if (search) q.set('search', search);
      const res = await api<CustomersResponse>(`/customers?${q}`);

      const header = ['Nome', 'Email', 'Telefone', 'Qtd Pedidos', 'Total Gasto', 'Ticket Médio', 'Primeiro Pedido', 'Último Pedido'];
      const rows = res.data.map((c) => [
        c.name ?? '',
        c.email,
        c.phone ?? '',
        String(c.orderCount),
        c.totalSpent.toFixed(2).replace('.', ','),
        c.avgTicket.toFixed(2).replace('.', ','),
        new Date(c.firstOrder).toLocaleDateString('pt-BR'),
        new Date(c.lastOrder).toLocaleDateString('pt-BR'),
      ]);

      const csv = [header, ...rows]
        .map((r) => r.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(';'))
        .join('\n');

      // UTF-8 BOM pra abrir certo no Excel
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `clientes_${stamp}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`Falha ao exportar: ${e.message}`);
    } finally {
      setExporting(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h1 className="text-2xl font-bold">Clientes</h1>
          <p className="text-sm text-slate-500 mt-1">
            Base agregada de todos os clientes que já compraram — agrupado por email
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={startSync}
            disabled={syncing || syncState?.running}
            className="flex items-center gap-2 px-3 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700 text-sm disabled:opacity-50 font-semibold"
            title="Baixa TODOS os pedidos do WooCommerce para a base local"
          >
            <DownloadCloud className={`w-4 h-4 ${syncState?.running ? 'animate-bounce' : ''}`} />
            {syncState?.running ? 'Sincronizando…' : 'Sincronizar histórico WooCommerce'}
          </button>
          <button
            onClick={exportCsv}
            disabled={exporting || loading || total === 0}
            className="flex items-center gap-2 px-3 py-2 border rounded hover:bg-slate-50 text-sm disabled:opacity-50"
            title="Exportar para CSV"
          >
            <Download className={`w-4 h-4 ${exporting ? 'animate-pulse' : ''}`} />
            Exportar
          </button>
          <button
            onClick={load}
            className="p-2 rounded hover:bg-slate-100"
            title="Atualizar"
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && <div className="bg-red-50 text-red-700 p-3 rounded mb-4 text-sm">{error}</div>}

      {/* Card de progresso da sync (só aparece durante ou logo após) */}
      {syncState && (syncState.running || (syncState.finishedAt && Date.now() - new Date(syncState.finishedAt).getTime() < 30000)) && (
        <div className={`mb-4 rounded-lg p-4 border-2 ${
          syncState.running
            ? 'bg-blue-50 border-blue-300'
            : syncState.errors > 0
              ? 'bg-amber-50 border-amber-300'
              : 'bg-emerald-50 border-emerald-300'
        }`}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 font-semibold text-sm">
              {syncState.running && (
                <>
                  <DownloadCloud className="w-5 h-5 text-blue-600 animate-bounce" />
                  <span className="text-blue-800">
                    Sincronizando histórico — página {syncState.page}
                    {syncState.totalPages > 0 && ` de ${syncState.totalPages}`}
                  </span>
                </>
              )}
              {!syncState.running && syncState.errors === 0 && (
                <>
                  <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  <span className="text-emerald-800">Sincronização concluída com sucesso</span>
                </>
              )}
              {!syncState.running && syncState.errors > 0 && (
                <>
                  <AlertCircle className="w-5 h-5 text-amber-600" />
                  <span className="text-amber-800">Sincronização concluída com avisos</span>
                </>
              )}
            </div>
            <div className="text-sm text-slate-600">
              <span className="font-bold text-emerald-700">{syncState.imported.toLocaleString('pt-BR')}</span> importados
              {syncState.errors > 0 && (
                <> · <span className="font-bold text-amber-700">{syncState.errors}</span> erro(s)</>
              )}
            </div>
          </div>

          {/* Barra de progresso */}
          {syncState.totalPages > 0 && (
            <div className="w-full bg-white rounded-full h-2 overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${syncState.running ? 'bg-blue-500' : 'bg-emerald-500'}`}
                style={{ width: `${Math.min(100, (syncState.page / syncState.totalPages) * 100)}%` }}
              />
            </div>
          )}

          {syncState.lastError && (
            <div className="mt-2 text-xs text-red-700">Último erro: {syncState.lastError}</div>
          )}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4 flex items-center gap-3">
          <div className="p-3 bg-blue-50 rounded-lg">
            <Users className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <div className="text-xs text-slate-500 uppercase">Total de clientes</div>
            <div className="text-2xl font-bold">{stats.totalCustomers.toLocaleString('pt-BR')}</div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4 flex items-center gap-3">
          <div className="p-3 bg-emerald-50 rounded-lg">
            <DollarSign className="w-6 h-6 text-emerald-600" />
          </div>
          <div>
            <div className="text-xs text-slate-500 uppercase">Receita total</div>
            <div className="text-2xl font-bold">{fmtMoney(stats.totalRevenue)}</div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4 flex items-center gap-3">
          <div className="p-3 bg-violet-50 rounded-lg">
            <TrendingUp className="w-6 h-6 text-violet-600" />
          </div>
          <div>
            <div className="text-xs text-slate-500 uppercase">Ticket médio geral</div>
            <div className="text-2xl font-bold">{fmtMoney(stats.overallAvgTicket)}</div>
          </div>
        </div>
      </div>

      {/* Busca */}
      <form onSubmit={onSearchSubmit} className="mb-4 flex gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Buscar por nome, email ou telefone..."
            className="w-full pl-9 pr-3 py-2 border rounded text-sm"
          />
        </div>
        <button type="submit" className="px-4 py-2 border rounded hover:bg-slate-50 text-sm">
          Buscar
        </button>
        {search && (
          <button
            type="button"
            onClick={() => { setSearchInput(''); setSearch(''); setPage(1); }}
            className="px-3 py-2 text-sm text-slate-500 hover:text-slate-800"
          >
            Limpar
          </button>
        )}
      </form>

      {/* Tabela */}
      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th
                className="p-3 text-left cursor-pointer hover:bg-slate-200 select-none"
                onClick={() => toggleSort('name')}
              >
                Cliente {sortIcon('name')}
              </th>
              <th className="p-3 text-left">Contato</th>
              <th
                className="p-3 text-right cursor-pointer hover:bg-slate-200 select-none"
                onClick={() => toggleSort('orderCount')}
              >
                Qtd {sortIcon('orderCount')}
              </th>
              <th
                className="p-3 text-right cursor-pointer hover:bg-slate-200 select-none"
                onClick={() => toggleSort('totalSpent')}
              >
                Total {sortIcon('totalSpent')}
              </th>
              <th
                className="p-3 text-right cursor-pointer hover:bg-slate-200 select-none"
                onClick={() => toggleSort('avgTicket')}
              >
                Ticket Médio {sortIcon('avgTicket')}
              </th>
              <th
                className="p-3 text-left cursor-pointer hover:bg-slate-200 select-none"
                onClick={() => toggleSort('lastOrder')}
              >
                Último pedido {sortIcon('lastOrder')}
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="p-6 text-center text-slate-400">Carregando...</td></tr>
            )}
            {!loading && data.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-slate-400">
                  {search ? 'Nenhum cliente encontrado.' : 'Nenhum cliente cadastrado ainda.'}
                </td>
              </tr>
            )}
            {!loading && data.map((c) => (
              <tr key={c.email} className="border-t hover:bg-slate-50">
                <td className="p-3">
                  <div className="font-semibold">{c.name ?? <span className="text-slate-400 italic">sem nome</span>}</div>
                </td>
                <td className="p-3">
                  <div className="text-xs text-slate-600">{c.email}</div>
                  {c.phone && <div className="text-xs text-slate-500 mt-0.5">{c.phone}</div>}
                </td>
                <td className="p-3 text-right font-mono font-semibold">{c.orderCount}</td>
                <td className="p-3 text-right font-mono font-bold text-emerald-700">{fmtMoney(c.totalSpent)}</td>
                <td className="p-3 text-right font-mono text-slate-700">{fmtMoney(c.avgTicket)}</td>
                <td className="p-3 text-slate-600">{fmtDate(c.lastOrder)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Paginação */}
      {totalPages > 1 && (
        <div className="flex justify-between items-center mt-4 text-sm text-slate-600">
          <div>
            {total.toLocaleString('pt-BR')} cliente(s) — página {page} de {totalPages}
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
