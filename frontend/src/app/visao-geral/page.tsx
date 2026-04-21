'use client';

/**
 * /visao-geral — Visão geral dos pedidos (antigo Dashboard /).
 *
 * Extraído de /app/page.tsx pra virar aba do hub /operacao (que fica em /).
 * Mantém o próprio fetch + auto-refresh, mas NÃO instala mais o listener de
 * socket (isso subiu pro hub pra funcionar em qualquer aba ativa).
 *
 * Ainda dá acesso direto via /visao-geral pra quem quiser link específico.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { Bell, Clock, RefreshCw, ExternalLink } from 'lucide-react';

const WC_ADMIN_URL = 'https://www.lurds.com.br/wp-admin/admin.php?page=wc-orders&action=edit&id=';

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

export default function VisaoGeralPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<WcOrder[]>([]);
  const [counts, setCounts] = useState<Record<string, { name: string; total: number }>>({});
  const [grand, setGrand] = useState(0);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    // Se for user de loja, manda direto pra /minha-loja (UI dedicada)
    api<{ role: string }>('/auth/me')
      .then((me) => { if (me.role === 'store') router.push('/minha-loja'); })
      .catch(() => {});
    load();

    // Socket: só recarrega a lista quando chegar evento (o alerta sonoro +
    // notification desktop agora vive no hub /).
    const socket = getSocket();
    const onNew = () => load();
    const onChange = () => load();
    socket.on('order:new', onNew);
    socket.on('order:status-changed', onChange);

    const t = setInterval(load, 30_000);

    return () => {
      socket.off('order:new', onNew);
      socket.off('order:status-changed', onChange);
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    try {
      const [list, cnt] = await Promise.all([
        api<{ data: WcOrder[]; total: number }>('/orders/wc?per_page=20'),
        api<{ byStatus: Record<string, { name: string; total: number }>; grand: number }>('/orders/wc/counts'),
      ]);
      setOrders(list.data);
      setCounts(cnt.byStatus);
      setGrand(cnt.grand);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  const statusCards: Array<{ slug: string; label: string }> = [
    { slug: 'pending',    label: 'Pagamento pendente' },
    { slug: 'separacao',  label: 'Separação' },
    { slug: 'processing', label: 'Processando' },
    { slug: 'on-hold',    label: 'Aguardando' },
    { slug: 'completed',  label: 'Concluído' },
  ];

  async function pollNow() {
    try {
      await api('/orders/poll-now', { method: 'POST' });
      setFlash('Buscando novos pedidos no WooCommerce...');
      setTimeout(() => { load(); setFlash(null); }, 3000);
    } catch (e: any) {
      setFlash(`Erro: ${e.message}`);
      setTimeout(() => setFlash(null), 4000);
    }
  }

  return (
    <div className="min-h-screen">
      {flash && (
        <div className="bg-green-500 text-white px-6 py-3 flex items-center gap-3 animate-pulse">
          <Bell className="w-5 h-5" />
          <span className="font-medium">{flash}</span>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
          {statusCards.map((c) => (
            <div key={c.slug} className="bg-white rounded-lg shadow p-4">
              <div className="text-sm text-slate-500">{c.label}</div>
              <div className="text-3xl font-bold mt-1">
                {(counts[c.slug]?.total ?? 0).toLocaleString('pt-BR')}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-400 mb-6 -mt-4">
          Total no WooCommerce: {grand.toLocaleString('pt-BR')} pedidos · atualiza a cada 30s
        </p>

        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Clock className="w-5 h-5" /> Últimos pedidos
          </h2>
          <button
            onClick={pollNow}
            className="px-3 py-1.5 text-sm bg-white border rounded hover:bg-slate-50 flex items-center gap-2"
            title="Força busca imediata no WooCommerce (sem esperar o minuto)"
          >
            <RefreshCw className="w-4 h-4" />
            Atualizar agora
          </button>
        </div>

        {loading ? (
          <div className="bg-white rounded-lg shadow p-8 text-center text-slate-400">
            Carregando...
          </div>
        ) : orders.length === 0 ? (
          <div className="bg-white rounded-lg shadow p-8 text-center text-slate-400">
            Nenhum pedido ainda. Assim que chegar via webhook do WooCommerce, ele aparece aqui em tempo real.
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-slate-600">
                <tr>
                  <th className="text-left px-4 py-3">Pedido</th>
                  <th className="text-left px-4 py-3">Data</th>
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-right px-4 py-3">Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const s = STATUS_LABELS[o.status] ?? { label: o.status, color: 'bg-slate-100' };
                  const d = o.dateCreatedGmt ? new Date(o.dateCreatedGmt.endsWith('Z') ? o.dateCreatedGmt : o.dateCreatedGmt + 'Z') : null;
                  const rel = (() => {
                    if (!d) return '—';
                    const min = Math.floor((Date.now() - d.getTime()) / 60000);
                    if (min < 1) return 'agora';
                    if (min < 60) return `${min}min atrás`;
                    const h = Math.floor(min / 60);
                    if (h < 24) return `${h}h atrás`;
                    const dias = Math.floor(h / 24);
                    return `${dias}d atrás`;
                  })();
                  return (
                    <tr key={o.id} className="border-t hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono">
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
                      <td className="px-4 py-3 text-slate-600">{rel}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${s.color}`}>
                          {s.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        R$ {Number(o.total || 0).toFixed(2).replace('.', ',')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
