'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, ShoppingBag, Minus, Plus, Trash2, Sparkles,
  ChevronRight, Tag, Gift,
} from 'lucide-react';
import { useCart } from '@/contexts/CartContext';
import BottomNav from '@/components/BottomNav';

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function CarrinhoPage() {
  const router = useRouter();
  const { items, itemCount, subtotal, updateQuantity, removeItem } = useCart();
  const [coupon, setCoupon] = useState('');
  const [couponApplied, setCouponApplied] = useState<{ code: string; discount: number } | null>(null);

  const cashbackAGanhar = subtotal * 0.10;
  const discount = couponApplied?.discount || 0;
  const total = Math.max(0, subtotal - discount);

  const applyCoupon = () => {
    const code = coupon.trim().toUpperCase();
    if (!code) return;
    // Cupons simulados — implementação real vai no checkout via WC
    if (code === 'APP10') {
      setCouponApplied({ code, discount: subtotal * 0.10 });
    } else {
      alert('Cupom inválido. Tente APP10');
    }
  };

  if (items.length === 0) {
    return (
      <div className="pb-24">
        <header className="flex items-center gap-3 px-5 pt-5">
          <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
            <ArrowLeft className="w-5 h-5 text-gold" />
          </Link>
          <h1 className="font-serif text-xl font-bold">Carrinho</h1>
        </header>
        <div className="mt-16 text-center px-8">
          <ShoppingBag className="w-20 h-20 mx-auto text-gold/30" />
          <h2 className="font-serif text-xl font-bold mt-4">Carrinho vazio</h2>
          <p className="text-sm text-cream/60 mt-2">
            Adicione produtos pra começar.
          </p>
          <Link href="/catalogo" className="btn-gold mt-6">
            Ver catálogo
          </Link>
        </div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="pb-40">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold flex-1">
          Carrinho <span className="text-cream/50 text-base">({itemCount})</span>
        </h1>
      </header>

      {/* Items */}
      <section className="mt-4 px-5 space-y-3">
        {items.map((item) => (
          <div
            key={`${item.productId}-${item.variationId ?? 'simple'}`}
            className="card-dark flex gap-3"
          >
            <Link
              href={`/produto/${item.slug}`}
              className="shrink-0 w-20 h-24 bg-ink rounded-lg overflow-hidden"
            >
              {item.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.image} alt={item.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-cream/30 text-xs">
                  —
                </div>
              )}
            </Link>
            <div className="flex-1 min-w-0">
              <Link href={`/produto/${item.slug}`}>
                <h3 className="font-bold text-sm line-clamp-2 leading-tight">{item.name}</h3>
              </Link>
              {Object.keys(item.attributes).length > 0 && (
                <div className="mt-1 text-[11px] text-cream/60">
                  {Object.entries(item.attributes).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                </div>
              )}
              <div className="mt-2 flex items-center justify-between gap-2">
                <div className="inline-flex items-center bg-ink-700 rounded-full">
                  <button
                    onClick={() => updateQuantity(item.productId, item.variationId, item.quantity - 1)}
                    className="p-1.5 text-gold"
                  >
                    <Minus className="w-3 h-3" />
                  </button>
                  <span className="px-2 text-xs font-bold tabular-nums min-w-[24px] text-center">
                    {item.quantity}
                  </span>
                  <button
                    onClick={() => updateQuantity(item.productId, item.variationId, item.quantity + 1)}
                    className="p-1.5 text-gold"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
                <div className="text-sm font-black text-gold tabular-nums">
                  {brl(item.price * item.quantity)}
                </div>
              </div>
            </div>
            <button
              onClick={() => removeItem(item.productId, item.variationId)}
              className="self-start p-2 text-cream/40 hover:text-rose-400 transition"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </section>

      {/* Cupom */}
      <section className="mt-6 px-5">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-cream/40 mb-2 px-1">
          Cupom de desconto
        </h3>
        {couponApplied ? (
          <div className="card-gold-border bg-gold/10 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Tag className="w-4 h-4 text-gold" />
              <div>
                <div className="font-bold text-sm">{couponApplied.code}</div>
                <div className="text-[11px] text-emerald-400">
                  −{brl(couponApplied.discount)} aplicado
                </div>
              </div>
            </div>
            <button
              onClick={() => setCouponApplied(null)}
              className="text-xs text-rose-300 font-bold"
            >
              Remover
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              type="text"
              value={coupon}
              onChange={(e) => setCoupon(e.target.value.toUpperCase())}
              placeholder="Ex: APP10"
              className="input-dark uppercase"
            />
            <button onClick={applyCoupon} className="btn-outline-gold shrink-0 px-5">
              Aplicar
            </button>
          </div>
        )}
      </section>

      {/* Cashback que vai ganhar */}
      <section className="mt-6 px-5">
        <div className="card-gold-border bg-gradient-to-br from-emerald-900/30 to-transparent flex items-center gap-3">
          <Sparkles className="w-5 h-5 text-emerald-400 shrink-0" />
          <div className="flex-1 text-sm">
            <strong className="text-emerald-300">{brl(cashbackAGanhar)}</strong> de cashback nessa compra
          </div>
        </div>
      </section>

      {/* Totais + Botão */}
      <div
        className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-app bg-ink/95 backdrop-blur-md border-t border-ink-600 px-5 pt-3"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
      >
        <div className="space-y-1 text-sm">
          <div className="flex justify-between text-cream/70">
            <span>Subtotal</span>
            <span className="tabular-nums">{brl(subtotal)}</span>
          </div>
          {couponApplied && (
            <div className="flex justify-between text-emerald-400">
              <span>Cupom {couponApplied.code}</span>
              <span className="tabular-nums">−{brl(couponApplied.discount)}</span>
            </div>
          )}
          <div className="flex justify-between text-cream/50 text-xs">
            <span>Frete</span>
            <span>calculado no próximo passo</span>
          </div>
          <div className="flex justify-between items-baseline pt-2 border-t border-ink-600">
            <span className="text-cream/80 font-bold">Total</span>
            <span className="font-serif text-2xl font-black text-gold tabular-nums">
              {brl(total)}
            </span>
          </div>
        </div>
        <button
          onClick={() => router.push('/checkout')}
          className="btn-gold-lg w-full mt-3"
        >
          Finalizar compra
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
