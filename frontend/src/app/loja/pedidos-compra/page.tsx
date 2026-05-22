'use client';

/**
 * /loja/pedidos-compra — Lista de pedidos de compra de fornecedor.
 *
 * Cada pedido tem header (fornecedor, NF, status, totais) + N items
 * (REF + COR + grade tamanhos). Quando mercadoria chega, vendedora confere
 * e o sistema auto-cadastra os SKUs no Wincred com EAN-13 gerado.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Plus, Search, Loader2, AlertCircle, Package,
  Truck, CheckCircle2, Clock, FileText, Calendar, Trash2,
} from 'lucide-react';
import { api } from '@/lib/api';

type Order = {
  id: string;
  numero: number;
  fornecedorNome: string;
  fornecedorCnpj: string | null;
  marca: string | null;
  dataPedido: string;
  dataPrevista: string | null;
  nfNumero: string | null;
  status: string;
  totalPecas: number;
  totalCusto: number;
  totalVenda: number;
  recebidoAt: string | null;
  _count?: { items: number };
};

const STATUS_INFO: Record<string, { label: string; color: string; icon: any }> = {
  rascunho: { label: 'Rascunho', color: 'bg-slate-100 text-slate-700 border-slate-300', icon: FileText },
  enviado: { label: 'Enviado', color: 'bg-sky-100 text-sky-800 border-sky-300', icon: Truck },
  aguardando: { label: 'Aguardando', color: 'bg-amber-100 text-amber-800 border-amber-300', icon: Clock },
  recebido: { label: 'Recebido', color: 'bg-emerald-100 text-emerald-800 border-emerald-300', icon: CheckCircle2 },
  recebido_com_erro: { label: 'Recebido c/ erro', color: 'bg-rose-100 text-rose-800 border-rose-300', icon: AlertCircle },
  cancelado: { label: 'Cancelado', color: 'bg-slate-100 text-slate-500 border-slate-300', icon: AlertCircle },
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function PedidosComprapage() {
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [searchDebounce, setSearchDebounce] = useState('');

  // Auth
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) router.push('/login?redirect=/loja/pedidos-compra');
  }, [router]);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounce(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (searchDebounce.trim()) params.set('search', searchDebounce.trim());
      const list = await api<Order[]>(`/purchase-orders?${params}`);
      setOrders(list);
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar pedidos');
    } finally {
      setLoading(false);
    }
  }, [status, searchDebounce]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/loja" className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center">
            <Package className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-black text-slate-800">Pedidos de Compra</h1>
            <p className="text-xs text-slate-500">Fornecedor · conferência · auto-cadastro</p>
          </div>
          <Link
            href="/loja/pedidos-compra/novo"
            className="flex items-center gap-2 px-4 py-2.5 bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm rounded-lg shadow-md"
          >
            <Plus className="w-4 h-4" />
            Novo pedido
          </Link>
        </div>

        {/* Filtros */}
        <div className="max-w-[1400px] mx-auto px-4 pb-3 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar fornecedor, NF, marca..."
              className="w-full pl-8 pr-3 py-2 border rounded-lg text-sm"
            />
          </div>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="px-3 py-2 border rounded-lg text-sm bg-white"
          >
            <option value="">Todos status</option>
            {Object.entries(STATUS_INFO).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto p-4">
        {loading ? (
          <div className="p-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin text-violet-600 mx-auto" />
          </div>
        ) : error ? (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg p-4">
            <AlertCircle className="w-5 h-5 inline mr-2" />
            {error}
          </div>
        ) : orders.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-16 text-center">
            <Package className="w-12 h-12 text-slate-300 mx-auto" />
            <div className="text-base font-bold text-slate-700 mt-3">Nenhum pedido cadastrado</div>
            <div className="text-xs text-slate-500 mt-1">Comece criando seu primeiro pedido de compra</div>
            <Link
              href="/loja/pedidos-compra/novo"
              className="inline-flex items-center gap-2 mt-4 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-sm rounded-lg font-bold"
            >
              <Plus className="w-4 h-4" />
              Criar primeiro pedido
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {orders.map((o) => {
              const st = STATUS_INFO[o.status] || STATUS_INFO.rascunho;
              const Icon = st.icon;
              return (
                <div
                  key={o.id}
                  className="group relative bg-white border border-slate-200 rounded-xl hover:border-violet-300 hover:shadow-md transition"
                >
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!confirm(`Excluir pedido #${o.numero} (${o.fornecedorNome})? Esta acao nao pode ser desfeita.`)) return;
                      try {
                        await api(`/purchase-orders/${o.id}`, { method: 'DELETE' });
                        setOrders((prev) => prev.filter((p) => p.id !== o.id));
                      } catch (err: any) {
                        alert('Erro ao excluir: ' + (err?.message || 'desconhecido'));
                      }
                    }}
                    title="Excluir pedido"
                    className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition p-1.5 rounded hover:bg-rose-50 text-rose-500 z-10"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <Link
                    href={`/loja/pedidos-compra/${o.id}`}
                    className="block p-4"
                  >
                    <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-violet-100 flex items-center justify-center shrink-0">
                      <span className="text-violet-700 font-black text-sm">#{o.numero}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <div className="font-bold text-slate-800 truncate">{o.fornecedorNome}</div>
                        {o.marca && o.marca !== o.fornecedorNome && (
                          <span className="text-[10px] font-bold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                            {o.marca}
                          </span>
                        )}
                        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border flex items-center gap-1 ${st.color}`}>
                          <Icon className="w-3 h-3" />
                          {st.label}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 flex items-center gap-3">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {new Date(o.dataPedido).toLocaleDateString('pt-BR')}
                        </span>
                        {o.nfNumero && <span>NF {o.nfNumero}</span>}
                        <span>{o._count?.items || 0} REFs</span>
                        <span><b>{o.totalPecas}</b> peças</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wider">Total custo</div>
                      <div className="text-lg font-black text-slate-800 tabular-nums">{brl(o.totalCusto)}</div>
                      <div className="text-[10px] text-emerald-600 tabular-nums">Venda {brl(o.totalVenda)}</div>
                    </div>
                    </div>
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
