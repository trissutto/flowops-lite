'use client';

/**
 * /retaguarda/venda-certa
 *
 * Dashboard MATRIZ — monitora todas as VENDAS CERTAS da rede.
 *
 * Porquê: algumas lojas usam o artifício "venda certa" pra puxar peça de
 * outra loja sem de fato ter venda garantida. Aqui a matriz vê quem está
 * acumulando pendências, quem está no prazo e quem está atrasado.
 *
 * Filtros: status (pending/confirmed/cancelled/all), loja solicitante,
 * busca. KPIs de rede + tabela de ranking por loja (pior ofensor no topo).
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, RefreshCw, Search, AlertTriangle, CheckCircle2,
  XCircle, Clock, ShoppingBag, TrendingDown, Store as StoreIcon,
} from 'lucide-react';
import { api } from '@/lib/api';

type TransferOrder = {
  id: string;
  tipo: 'REPOSICAO' | 'VENDA_CERTA';
  refCode: string;
  cor: string | null;
  tamanho: string | null;
  qtyOrigem: number;
  lojaOrigemCode: string;
  lojaOrigemName: string;
  lojaDestinoCode: string;
  lojaDestinoName: string;
  solicitanteNome: string;
  clienteNome: string | null;
  createdAt: string;
  saleStatus: 'pending' | 'confirmed' | 'cancelled' | null;
  saleDeadline: string | null;
  saleConfirmedAt: string | null;
  saleCancelReason: string | null;
  saleNote: string | null;
};

type StatusFiltro = 'all' | 'pending' | 'confirmed' | 'cancelled';

export default function VendaCertaMatrizPage() {
  const router = useRouter();
  const [items, setItems] = useState<TransferOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFiltro, setStatusFiltro] = useState<StatusFiltro>('pending');
  const [lojaFiltro, setLojaFiltro] = useState<string>('all');
  const [busca, setBusca] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      // scope=all exige admin/operator no backend
      const data = await api<{ items: TransferOrder[] }>(
        '/products/transfer-orders?scope=all&limit=500',
      );
      // Só VENDA_CERTA
      const vc = (data.items || []).filter((i) => i.tipo === 'VENDA_CERTA');
      setItems(vc);
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.includes('401')) {
        router.push('/login');
        return;
      }
      if (msg.includes('403')) {
        setError('Acesso negado. Essa tela é só pra matriz (admin/operator).');
        return;
      }
      setError('Não foi possível carregar o monitoramento.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lista de lojas solicitantes pro filtro
  const lojasSolicitantes = useMemo(() => {
    const set = new Map<string, string>();
    items.forEach((i) => set.set(i.lojaDestinoCode, `${i.lojaDestinoCode} — ${i.lojaDestinoName}`));
    return Array.from(set.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [items]);

  // Ranking por loja (só pendentes + atrasadas)
  const ranking = useMemo(() => {
    const byLoja = new Map<string, {
      code: string; name: string;
      pending: number; overdue: number;
      confirmed: number; cancelled: number;
      total: number;
    }>();
    items.forEach((i) => {
      const k = i.lojaDestinoCode;
      if (!byLoja.has(k)) {
        byLoja.set(k, {
          code: k, name: i.lojaDestinoName,
          pending: 0, overdue: 0, confirmed: 0, cancelled: 0, total: 0,
        });
      }
      const row = byLoja.get(k)!;
      row.total++;
      const status = i.saleStatus || 'pending';
      if (status === 'pending') {
        row.pending++;
        if (i.saleDeadline && new Date(i.saleDeadline).getTime() < Date.now()) {
          row.overdue++;
        }
      } else if (status === 'confirmed') row.confirmed++;
      else if (status === 'cancelled') row.cancelled++;
    });
    // Ordena: mais atrasados primeiro, depois mais pendentes, depois total
    return Array.from(byLoja.values()).sort((a, b) => {
      if (b.overdue !== a.overdue) return b.overdue - a.overdue;
      if (b.pending !== a.pending) return b.pending - a.pending;
      return b.total - a.total;
    });
  }, [items]);

  const filtered = useMemo(() => {
    const needle = busca.trim().toLowerCase();
    return items.filter((it) => {
      const status = it.saleStatus || 'pending';
      if (statusFiltro !== 'all' && status !== statusFiltro) return false;
      if (lojaFiltro !== 'all' && it.lojaDestinoCode !== lojaFiltro) return false;
      if (!needle) return true;
      return (
        it.refCode.toLowerCase().includes(needle) ||
        it.solicitanteNome.toLowerCase().includes(needle) ||
        (it.clienteNome || '').toLowerCase().includes(needle) ||
        it.lojaOrigemName.toLowerCase().includes(needle) ||
        it.lojaDestinoName.toLowerCase().includes(needle)
      );
    });
  }, [items, statusFiltro, lojaFiltro, busca]);

  const kpis = useMemo(() => {
    const pending = items.filter((i) => (i.saleStatus || 'pending') === 'pending');
    const overdue = pending.filter(
      (i) => i.saleDeadline && new Date(i.saleDeadline).getTime() < Date.now(),
    );
    return {
      total: items.length,
      pending: pending.length,
      overdue: overdue.length,
      confirmed: items.filter((i) => i.saleStatus === 'confirmed').length,
      cancelled: items.filter((i) => i.saleStatus === 'cancelled').length,
    };
  }, [items]);

  return (
    <div className="min-h-screen pastel-page">
      <header className="bg-brand text-white shadow">
        <div className="px-4 py-3 flex items-center gap-3 max-w-7xl mx-auto">
          <Link href="/" className="p-2 hover:bg-white/10 rounded" title="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-2 font-bold">
              <ShoppingBag className="w-5 h-5" />
              Monitoramento VENDA CERTA
            </div>
            <div className="text-xs opacity-80">
              Rede toda · controle anti-abuso do recurso
            </div>
          </div>
          <button
            onClick={load}
            className="p-2 hover:bg-white/10 rounded"
            title="Atualizar"
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-3 sm:p-4 space-y-3">
        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <KpiCard
            active={statusFiltro === 'all'}
            onClick={() => setStatusFiltro('all')}
            icon={<ShoppingBag className="w-4 h-4" />}
            label="Total na rede"
            value={kpis.total}
            color="slate"
          />
          <KpiCard
            active={statusFiltro === 'pending'}
            onClick={() => setStatusFiltro('pending')}
            icon={<Clock className="w-4 h-4" />}
            label="Pendentes"
            value={kpis.pending}
            color="amber"
          />
          <KpiCard
            active={statusFiltro === 'pending'}
            onClick={() => setStatusFiltro('pending')}
            icon={<AlertTriangle className="w-4 h-4" />}
            label="Atrasadas"
            value={kpis.overdue}
            color="red"
            highlight={kpis.overdue > 0}
          />
          <KpiCard
            active={statusFiltro === 'confirmed'}
            onClick={() => setStatusFiltro('confirmed')}
            icon={<CheckCircle2 className="w-4 h-4" />}
            label="Confirmadas"
            value={kpis.confirmed}
            color="emerald"
          />
          <KpiCard
            active={statusFiltro === 'cancelled'}
            onClick={() => setStatusFiltro('cancelled')}
            icon={<XCircle className="w-4 h-4" />}
            label="Canceladas"
            value={kpis.cancelled}
            color="slate"
          />
        </div>

        {/* Ranking de lojas */}
        {ranking.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
              <TrendingDown className="w-4 h-4 text-slate-600" />
              <div className="text-sm font-bold text-slate-800">Ranking por loja solicitante</div>
              <div className="text-xs text-slate-500">(atrasadas primeiro — clique pra filtrar)</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600 uppercase">
                  <tr>
                    <th className="text-left px-3 py-2">Loja</th>
                    <th className="text-right px-2 py-2">Atrasadas</th>
                    <th className="text-right px-2 py-2">Pendentes</th>
                    <th className="text-right px-2 py-2">Confirmadas</th>
                    <th className="text-right px-2 py-2">Canceladas</th>
                    <th className="text-right px-3 py-2">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((r) => {
                    const taxaCancel = r.total > 0 ? Math.round((r.cancelled / r.total) * 100) : 0;
                    const isBad = r.overdue > 0 || taxaCancel >= 30;
                    return (
                      <tr
                        key={r.code}
                        onClick={() => setLojaFiltro(r.code)}
                        className={`border-t border-slate-100 hover:bg-slate-50 cursor-pointer ${
                          isBad ? 'bg-red-50/50' : ''
                        }`}
                      >
                        <td className="px-3 py-2 font-semibold text-slate-800 flex items-center gap-2">
                          <StoreIcon className="w-3.5 h-3.5 text-slate-400" />
                          {r.code} — {r.name}
                        </td>
                        <td className={`text-right px-2 py-2 font-mono ${r.overdue > 0 ? 'text-red-700 font-bold' : 'text-slate-400'}`}>
                          {r.overdue || '-'}
                        </td>
                        <td className={`text-right px-2 py-2 font-mono ${r.pending > 0 ? 'text-amber-700' : 'text-slate-400'}`}>
                          {r.pending || '-'}
                        </td>
                        <td className="text-right px-2 py-2 font-mono text-emerald-700">
                          {r.confirmed || '-'}
                        </td>
                        <td className={`text-right px-2 py-2 font-mono ${taxaCancel >= 30 ? 'text-red-700 font-bold' : 'text-slate-500'}`}>
                          {r.cancelled || '-'}
                          {taxaCancel >= 30 && <span className="text-[10px] ml-1">({taxaCancel}%)</span>}
                        </td>
                        <td className="text-right px-3 py-2 font-mono font-bold text-slate-700">
                          {r.total}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Filtros */}
        <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar por REF, loja, solicitante ou cliente…"
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <select
              value={statusFiltro}
              onChange={(e) => setStatusFiltro(e.target.value as StatusFiltro)}
              className="border border-slate-200 rounded-lg text-sm py-2 px-2 bg-white"
            >
              <option value="all">Todos os status</option>
              <option value="pending">Só Pendentes</option>
              <option value="confirmed">Só Confirmadas</option>
              <option value="cancelled">Só Canceladas</option>
            </select>
            <select
              value={lojaFiltro}
              onChange={(e) => setLojaFiltro(e.target.value)}
              className="border border-slate-200 rounded-lg text-sm py-2 px-2 bg-white"
            >
              <option value="all">Todas as lojas solicitantes</option>
              {lojasSolicitantes.map(([code, label]) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Lista */}
        {error ? (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-4 text-sm">
            {error}
          </div>
        ) : loading && items.length === 0 ? (
          <div className="text-center text-slate-500 py-10 text-sm">Carregando…</div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-slate-500 text-sm">
            Nenhuma venda certa bate com os filtros.
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((it) => <MatrizCard key={it.id} item={it} />)}
          </div>
        )}
      </main>

      <style jsx global>{`
        @keyframes pulse-slow {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.75; }
        }
        .animate-pulse-slow { animation: pulse-slow 2.5s ease-in-out infinite; }
      `}</style>
    </div>
  );
}

function KpiCard({
  active, onClick, icon, label, value, color, highlight,
}: {
  active?: boolean; onClick?: () => void;
  icon: React.ReactNode; label: string; value: number;
  color: 'slate' | 'amber' | 'red' | 'emerald';
  highlight?: boolean;
}) {
  const base: Record<string, string> = {
    slate: 'text-slate-700 bg-slate-50 border-slate-200',
    amber: 'text-amber-700 bg-amber-50 border-amber-200',
    red: 'text-red-800 bg-red-50 border-red-300',
    emerald: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  };
  return (
    <button
      onClick={onClick}
      className={`text-left rounded-lg border p-3 transition ${base[color]} ${
        active ? 'ring-2 ring-offset-1 ring-brand' : ''
      } ${highlight ? 'animate-pulse-slow' : ''}`}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </button>
  );
}

function MatrizCard({ item }: { item: TransferOrder }) {
  const status = item.saleStatus || 'pending';
  const isPending = status === 'pending';
  const isConfirmed = status === 'confirmed';
  const isCancelled = status === 'cancelled';
  const isOverdue =
    isPending && item.saleDeadline && new Date(item.saleDeadline).getTime() < Date.now();

  const remaining = item.saleDeadline
    ? Math.ceil((new Date(item.saleDeadline).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : null;

  const cardClass = isOverdue
    ? 'bg-red-50 border-2 border-red-500 shadow shadow-red-200 animate-pulse-slow'
    : isPending
      ? 'bg-red-50 border border-red-200'
      : isConfirmed
        ? 'bg-emerald-50 border border-emerald-200'
        : 'bg-slate-100 border border-slate-300';

  return (
    <div className={`rounded-xl p-3 ${cardClass}`}>
      <div className="flex flex-wrap items-center gap-2">
        {isOverdue ? (
          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-red-600 text-white border border-red-700 inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> ATRASADA
          </span>
        ) : isPending ? (
          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-red-100 text-red-800 border border-red-300 inline-flex items-center gap-1">
            <Clock className="w-3 h-3" /> Pendente {remaining !== null && remaining >= 0 ? `${remaining}d` : ''}
          </span>
        ) : isConfirmed ? (
          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300 inline-flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Vendida
          </span>
        ) : (
          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 border border-slate-300 inline-flex items-center gap-1">
            <XCircle className="w-3 h-3" /> Não vendeu
          </span>
        )}
        <span className="font-bold text-slate-900">{item.refCode}</span>
        {item.cor && <span className="text-sm text-slate-700">{item.cor}</span>}
        {item.tamanho && <span className="text-sm text-slate-700">tam {item.tamanho}</span>}
        <div className="ml-auto text-[11px] text-slate-500 font-mono">{formatDate(item.createdAt)}</div>
      </div>

      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div>
          <span className="text-slate-400">Solicitante (destino):</span>{' '}
          <span className="font-bold text-slate-800">{item.lojaDestinoCode} — {item.lojaDestinoName}</span>
          <span className="text-slate-500"> · {item.solicitanteNome}</span>
        </div>
        <div>
          <span className="text-slate-400">Origem (vai mandar):</span>{' '}
          <span className="font-semibold text-slate-800">{item.lojaOrigemCode} — {item.lojaOrigemName}</span>
        </div>
        {item.clienteNome && (
          <div className="sm:col-span-2">
            <span className="text-slate-400">Cliente:</span>{' '}
            <span className="font-semibold text-amber-800">{item.clienteNome}</span>
          </div>
        )}
      </div>

      {isConfirmed && item.saleConfirmedAt && (
        <div className="mt-2 text-xs bg-emerald-100 text-emerald-800 rounded px-2 py-1 flex items-center gap-1.5">
          <CheckCircle2 className="w-3 h-3" />
          Confirmada em {formatDate(item.saleConfirmedAt)}
          {item.saleNote && <span>· {item.saleNote}</span>}
        </div>
      )}
      {isCancelled && item.saleCancelReason && (
        <div className="mt-2 text-xs bg-slate-200 text-slate-700 rounded px-2 py-1 flex items-center gap-1.5">
          <XCircle className="w-3 h-3" />
          {item.saleCancelReason}
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'agora';
    if (diffMin < 60) return `${diffMin} min atrás`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h atrás`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `${diffD}d atrás`;
    return d.toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
