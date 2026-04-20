'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { Bell, Package, Store, AlertTriangle, Clock, RefreshCw, ExternalLink } from 'lucide-react';

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

// Status do WooCommerce — mesmos labels do admin WP
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

export default function Dashboard() {
  const router = useRouter();
  const [orders, setOrders] = useState<WcOrder[]>([]);
  const [counts, setCounts] = useState<Record<string, { name: string; total: number }>>({});
  const [grand, setGrand] = useState(0);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('flowops_token');
    if (!token) {
      router.push('/login');
      return;
    }
    // Se for user de loja, manda direto pra /minha-loja (UI dedicada)
    api<{ role: string }>('/auth/me')
      .then((me) => { if (me.role === 'store') router.push('/minha-loja'); })
      .catch(() => {});
    load();

    // Pede permissão para notificações do sistema
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    const socket = getSocket();
    socket.on('order:new', (o: any) => {
      setFlash(`Novo pedido: #${o.wcOrderNumber ?? o.number}`);
      playAlert();
      notifyDesktop(o);
      setTimeout(() => setFlash(null), 4000);
      load();
    });
    socket.on('order:status-changed', () => load());

    // Auto-refresh a cada 30s
    const t = setInterval(load, 30_000);

    return () => {
      socket.off('order:new');
      socket.off('order:status-changed');
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

  function playAlert() {
    try {
      // Beep simples via Web Audio (sem precisar de arquivo)
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.start(); osc.stop(ctx.currentTime + 0.5);
    } catch {}
  }

  function notifyDesktop(o: any) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const num = o.wcOrderNumber ?? o.number ?? o.id;
      const total = o.totalAmount ?? o.total ?? 0;
      const n = new Notification('🛍 Novo pedido LURDS', {
        body: `#${num} — ${o.customerName}\nR$ ${Number(total || 0).toFixed(2)}`,
        tag: `order-${o.id}`,
        requireInteraction: true,
      });
      n.onclick = () => {
        window.focus();
        window.location.href = `/pedidos`;
        n.close();
      };
    } catch {}
  }

  // KPIs com os MESMOS status/nomes que aparecem no WP admin
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
