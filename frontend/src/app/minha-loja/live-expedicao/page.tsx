'use client';

/**
 * /minha-loja/live-expedicao — Painel da LOJA DE ORIGEM para vendas da Live.
 *
 * A loja recebe (em tempo real) as ordens de separação de itens vendidos na
 * live cuja origem foi atribuída a ela. Fluxo: separar → embalar/despachar
 * (gera transferência interna + conciliação) → entregue.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Check,
  Loader2,
  PackageCheck,
  Truck,
  User,
} from 'lucide-react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';

interface QueueItem {
  id: string;
  refCode: string;
  descricao: string | null;
  cor: string | null;
  tamanho: string | null;
  qty: number;
  status: string;
  separatedAt: string | null;
  trackingCode: string | null;
}
interface QueueGroup {
  cartId: string;
  customerName: string;
  customerPhone: string;
  customerInstagram: string | null;
  paidAt: string | null;
  items: QueueItem[];
}

export default function LiveExpedicaoPage() {
  const [groups, setGroups] = useState<QueueGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<QueueGroup[]>('/live-pdv/store-queue');
      setGroups(data || []);
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const socket = getSocket();
    const onNew = () => load();
    socket.on('live-pdv:separation-new', onNew);
    return () => {
      socket.off('live-pdv:separation-new', onNew);
    };
  }, [load]);

  async function markSeparated(itemId: string) {
    setBusy(itemId);
    try {
      await api(`/live-pdv/items/${itemId}/separated`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function markShipped(itemId: string) {
    const trackingCode = prompt('Código de rastreio (opcional):') || undefined;
    setBusy(itemId);
    try {
      await api(`/live-pdv/items/${itemId}/shipped`, {
        method: 'POST',
        body: JSON.stringify({ trackingCode }),
      });
      await load();
    } catch (e: any) {
      alert(e?.message || 'Erro ao despachar');
    } finally {
      setBusy(null);
    }
  }

  async function markDelivered(itemId: string) {
    setBusy(itemId);
    try {
      await api(`/live-pdv/items/${itemId}/delivered`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Carregando…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 p-4">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-1 flex items-center gap-2 text-2xl font-bold text-slate-800">
          <Box className="h-6 w-6 text-rose-500" /> Expedição — Live Commerce
        </h1>
        <p className="mb-4 text-sm text-slate-500">
          Pedidos da live para sua loja separar e despachar. Atualiza em tempo real.
        </p>

        {groups.length === 0 && (
          <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-400">
            <PackageCheck className="mx-auto mb-2 h-10 w-10 text-slate-300" />
            Nenhum pedido pendente. 🎉
          </div>
        )}

        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.cartId} className="rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center gap-2 border-b border-slate-100 p-3">
                <User className="h-4 w-4 text-slate-400" />
                <div>
                  <div className="font-semibold text-slate-800">{g.customerName}</div>
                  <div className="text-xs text-slate-500">
                    {g.customerPhone}
                    {g.customerInstagram && ` · @${g.customerInstagram}`}
                  </div>
                </div>
                <span className="ml-auto text-xs text-slate-400">{g.items.length} item(s)</span>
              </div>
              <div className="divide-y divide-slate-50">
                {g.items.map((it) => (
                  <div key={it.id} className="flex items-center gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-slate-800">
                        {it.refCode} · {it.cor} {it.tamanho}{' '}
                        <span className="text-slate-400">×{it.qty}</span>
                      </div>
                      <div className="truncate text-xs text-slate-500">{it.descricao}</div>
                      {it.trackingCode && (
                        <div className="text-xs text-emerald-600">Rastreio: {it.trackingCode}</div>
                      )}
                    </div>
                    {it.status === 'separating' && (
                      <>
                        {!it.separatedAt && (
                          <button
                            onClick={() => markSeparated(it.id)}
                            disabled={busy === it.id}
                            className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                          >
                            {busy === it.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                            Separei
                          </button>
                        )}
                        <button
                          onClick={() => markShipped(it.id)}
                          disabled={busy === it.id}
                          className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                        >
                          {busy === it.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}
                          Despachar
                        </button>
                      </>
                    )}
                    {it.status === 'shipped' && (
                      <button
                        onClick={() => markDelivered(it.id)}
                        disabled={busy === it.id}
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {busy === it.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
                        Entregue
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
