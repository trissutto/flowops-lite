'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Loader2, CheckCircle2, Clock, Truck, Copy, ExternalLink,
  Package, AlertCircle, Sparkles,
} from 'lucide-react';
import { getOrderById, isLoggedIn, type WcOrderDetail } from '@/lib/api';

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Página de acompanhamento de pedido — /pedido/[id]
 *
 * Cliente cai aqui após criar pedido. Mostra:
 *   - Status (Aguardando pagamento / Pago / Enviado / Entregue)
 *   - Se PIX pendente: QR Code + copia-cola + countdown
 *   - Se pago: confirmação + itens
 *   - Se enviado: código de rastreio com link Correios
 *
 * Re-fetch automático a cada 15s pra cliente ver pagamento confirmar
 * (especialmente importante pra PIX — UX padrão de marketplace).
 */
export default function OrderPage() {
  const { id } = useParams() as { id: string };
  const router = useRouter();
  const [order, setOrder] = useState<WcOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.push(`/login?next=/pedido/${id}`);
      return;
    }
    let cancelled = false;
    const fetchOrder = async () => {
      try {
        const o = await getOrderById(id);
        if (!cancelled) {
          setOrder(o);
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setErr(e?.message || 'Pedido não encontrado');
          setLoading(false);
        }
      }
    };
    fetchOrder();
    // Re-fetch a cada 15s SE status ainda pending (PIX aguardando)
    const interval = setInterval(() => {
      if (order && (order.status === 'pending' || order.status === 'on-hold')) {
        fetchOrder();
      }
    }, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, router]);

  const copyPix = async () => {
    if (!order?.pix?.copyPaste) return;
    try {
      await navigator.clipboard.writeText(order.pix.copyPaste);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback: prompt
      window.prompt('Copie o código PIX:', order.pix.copyPaste);
    }
  };

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-gold" />
      </div>
    );
  }

  if (err || !order) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center px-5">
        <AlertCircle className="w-12 h-12 text-rose-400 mb-3" />
        <h1 className="font-serif text-xl font-bold mb-1">Pedido não encontrado</h1>
        <p className="text-sm text-cream/60 text-center mb-6">{err || 'Tente novamente'}</p>
        <Link href="/pedidos" className="btn-gold">Ver meus pedidos</Link>
      </div>
    );
  }

  const isPending = order.status === 'pending' || order.status === 'on-hold';
  const isPaid = ['processing', 'completed', 'shipped', 'delivered'].includes(order.status);
  const isShipped = ['shipped', 'delivered'].includes(order.status) || !!order.tracking;
  const isCancelled = ['cancelled', 'refunded', 'failed'].includes(order.status);

  // Stepper de progresso visual
  const steps = [
    { key: 'created', label: 'Pedido criado', done: true, icon: CheckCircle2 },
    { key: 'paid', label: 'Pagamento confirmado', done: isPaid, icon: CheckCircle2 },
    { key: 'shipped', label: 'Enviado', done: isShipped, icon: Truck },
    { key: 'delivered', label: 'Entregue', done: order.status === 'delivered', icon: Package },
  ];

  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5 sticky top-0 bg-ink/95 backdrop-blur-md z-10 pb-3 -mx-1 px-6">
        <Link href="/pedidos" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <div>
          <h1 className="font-serif text-lg font-bold leading-none">Pedido #{order.number}</h1>
          <p className="text-[11px] text-cream/50">
            {new Date(order.dateCreated).toLocaleDateString('pt-BR', {
              day: '2-digit', month: 'long', year: 'numeric',
            })}
          </p>
        </div>
      </header>

      {/* ───────── Status banner ───────── */}
      <section className="px-5 mt-4">
        <div
          className={`rounded-2xl p-5 text-center ${
            isCancelled
              ? 'bg-rose-900/30 border border-rose-700/50'
              : isPending
              ? 'bg-amber-900/30 border border-amber-700/50'
              : 'bg-emerald-900/20 border border-emerald-500/30'
          }`}
        >
          <div className="flex items-center justify-center mb-2">
            {isCancelled ? (
              <AlertCircle className="w-8 h-8 text-rose-400" />
            ) : isPending ? (
              <Clock className="w-8 h-8 text-amber-400 animate-pulse" />
            ) : (
              <CheckCircle2 className="w-8 h-8 text-emerald-400" />
            )}
          </div>
          <h2 className="font-bold text-lg">{order.statusLabel}</h2>
          {isPending && (
            <p className="text-xs text-cream/60 mt-1">
              Esta página atualiza automaticamente quando confirmar
            </p>
          )}
          {isPaid && !isShipped && (
            <p className="text-xs text-cream/60 mt-1">
              Já estamos separando seu pedido
            </p>
          )}
        </div>
      </section>

      {/* ───────── PIX QR Code (se aguardando) ───────── */}
      {isPending && order.pix && (
        <section className="mt-6 px-5">
          <div className="card-gold-border bg-ink-800 p-5">
            <h3 className="font-bold text-center mb-3 flex items-center justify-center gap-2">
              💰 Pagar com PIX
            </h3>
            {(order.pix.qrCodeBase64 || order.pix.qrCodeUrl) && (
              <div className="bg-white rounded-xl p-4 flex items-center justify-center mb-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={(order.pix.qrCodeBase64 || order.pix.qrCodeUrl) as string}
                  alt="QR Code PIX"
                  className="w-48 h-48"
                />
              </div>
            )}
            {order.pix.copyPaste && (
              <>
                <p className="text-xs text-cream/60 text-center mb-2">
                  Ou copie e cole no seu banco:
                </p>
                <div className="bg-ink-900 rounded-lg p-3 text-[10px] text-cream/70 break-all mb-3 font-mono">
                  {order.pix.copyPaste}
                </div>
                <button
                  onClick={copyPix}
                  className="btn-gold w-full"
                >
                  <Copy className="w-4 h-4" />
                  {copied ? 'Copiado!' : 'Copiar código PIX'}
                </button>
              </>
            )}
            {!order.pix.qrCodeBase64 && !order.pix.qrCodeUrl && !order.pix.copyPaste && order.paymentUrl && (
              <a
                href={order.paymentUrl}
                className="btn-gold w-full"
                target="_blank"
                rel="noopener noreferrer"
              >
                Abrir pagamento <ExternalLink className="w-4 h-4" />
              </a>
            )}
          </div>
        </section>
      )}

      {/* ───────── Link de pagamento (se não tiver PIX inline) ───────── */}
      {isPending && !order.pix && order.paymentUrl && (
        <section className="mt-6 px-5">
          <a href={order.paymentUrl} className="btn-gold-lg w-full">
            Continuar pagamento <ExternalLink className="w-5 h-5" />
          </a>
        </section>
      )}

      {/* ───────── Tracking (se enviado) ───────── */}
      {order.tracking && (
        <section className="mt-6 px-5">
          <div className="card-gold-border bg-emerald-900/20 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Truck className="w-5 h-5 text-emerald-400" />
              <h3 className="font-bold text-sm">Código de rastreio</h3>
            </div>
            <p className="font-mono text-lg font-bold text-emerald-300 mb-2">
              {order.tracking.code}
            </p>
            <a
              href={order.tracking.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gold underline flex items-center gap-1"
            >
              Acompanhar nos Correios <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </section>
      )}

      {/* ───────── Progresso ───────── */}
      {!isCancelled && (
        <section className="mt-7 px-5">
          <div className="space-y-3">
            {steps.map((s, idx) => (
              <div key={s.key} className="flex items-center gap-3">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                    s.done
                      ? 'bg-emerald-500 text-white'
                      : 'bg-ink-700 text-cream/40'
                  }`}
                >
                  <s.icon className="w-4 h-4" />
                </div>
                <div className="flex-1">
                  <p className={`text-sm font-medium ${s.done ? 'text-white' : 'text-cream/40'}`}>
                    {s.label}
                  </p>
                </div>
                {idx < steps.length - 1 && (
                  <div
                    className={`w-px h-6 ${steps[idx + 1].done ? 'bg-emerald-500' : 'bg-ink-700'}`}
                    style={{ marginLeft: 15, marginTop: 16, position: 'absolute' }}
                  />
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ───────── Itens ───────── */}
      <section className="mt-7 px-5">
        <h3 className="font-bold text-sm uppercase tracking-wider mb-3 text-cream/70">
          Itens do pedido
        </h3>
        <div className="space-y-3">
          {order.items.map((item) => (
            <div key={item.id} className="card-dark flex gap-3">
              <div className="w-16 h-20 bg-ink-700 rounded-lg overflow-hidden shrink-0">
                {item.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.image} alt={item.name} className="w-full h-full object-cover" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium leading-tight">{item.name}</p>
                {item.variation && (
                  <p className="text-[11px] text-cream/50 mt-0.5">{item.variation}</p>
                )}
                <div className="flex items-center justify-between mt-2">
                  <span className="text-xs text-cream/60">Qtd: {item.quantity}</span>
                  <span className="font-bold text-gold tabular-nums text-sm">
                    {brl(item.total)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ───────── Resumo financeiro ───────── */}
      <section className="mt-7 px-5">
        <div className="card-dark space-y-1.5 text-sm">
          {order.discountTotal > 0 && (
            <div className="flex justify-between text-emerald-400">
              <span>Desconto</span>
              <span className="tabular-nums">−{brl(order.discountTotal)}</span>
            </div>
          )}
          {order.cashbackUsed > 0 && (
            <div className="flex justify-between text-emerald-400">
              <span>Cashback aplicado</span>
              <span className="tabular-nums">−{brl(order.cashbackUsed)}</span>
            </div>
          )}
          <div className="flex justify-between text-cream/70">
            <span>Frete ({order.shippingMethod || '—'})</span>
            <span className="tabular-nums">{brl(order.shippingTotal)}</span>
          </div>
          <div className="flex justify-between pt-2 border-t border-ink-600">
            <span className="font-bold">Total</span>
            <span className="font-black text-gold text-lg tabular-nums">
              {brl(order.total)}
            </span>
          </div>
          <div className="pt-1 text-[11px] text-cream/40">
            Pagamento: {order.paymentMethodTitle}
          </div>
        </div>
      </section>

      {/* ───────── Endereço ───────── */}
      {order.shipping.address && (
        <section className="mt-5 px-5">
          <h3 className="font-bold text-xs uppercase tracking-wider mb-2 text-cream/60">
            Entrega
          </h3>
          <div className="card-dark text-xs text-cream/70 leading-relaxed">
            <p className="text-white font-medium mb-0.5">{order.shipping.name}</p>
            <p>
              {order.shipping.address}
              {order.shipping.address2 && ` · ${order.shipping.address2}`}
            </p>
            <p>{order.shipping.city} — {order.shipping.state}</p>
            {order.shipping.postcode && <p>CEP {order.shipping.postcode}</p>}
          </div>
        </section>
      )}

      {/* ───────── Cashback que vai ganhar ───────── */}
      {isPaid && (
        <section className="mt-6 px-5">
          <div className="bg-gradient-to-br from-emerald-900/30 to-emerald-700/10 border border-emerald-500/30 rounded-2xl p-4 flex items-center gap-3">
            <Sparkles className="w-6 h-6 text-emerald-400 shrink-0" />
            <div className="text-xs text-cream/80">
              Você está ganhando{' '}
              <strong className="text-emerald-300">
                {brl(order.items.reduce((a, i) => a + i.total, 0) * 0.1)}
              </strong>{' '}
              de cashback nesse pedido — válido por 30 dias.
            </div>
          </div>
        </section>
      )}

      <div className="mt-8 px-5 text-center">
        <Link href="/pedidos" className="text-sm text-gold underline">
          Ver todos meus pedidos
        </Link>
      </div>
    </div>
  );
}
