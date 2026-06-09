'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShoppingCart, Clock, X, Sparkles } from 'lucide-react';
import { useCart } from '@/contexts/CartContext';

/**
 * Modal mostrado na home quando cliente abre o app com carrinho abandonado
 * (carrinho cheio + última atividade > 60min). Mostra cupom relâmpago de
 * 10% off válido 30min — gatilho de urgência puro.
 *
 * UX rule: aparece UMA VEZ por sessão. Cliente pode dispensar (X).
 * Não aparece se cupom já foi dismissed/expirado/aplicado.
 */
export default function AbandonedCartModal() {
  const router = useRouter();
  const { items, subtotal, isAbandoned, relampagoCoupon, dismissRelampago } = useCart();
  const [show, setShow] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Timer pra atualizar countdown
  useEffect(() => {
    if (!show) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [show]);

  // Decide se mostra
  useEffect(() => {
    if (!isAbandoned || !relampagoCoupon || relampagoCoupon.dismissed) {
      setShow(false);
      return;
    }
    // Não mostrar se cupom já expirou
    if (relampagoCoupon.expiresAt < Date.now()) {
      setShow(false);
      return;
    }
    // Aparece após 1.5s da abertura pra não atropelar UX
    const t = setTimeout(() => setShow(true), 1500);
    return () => clearTimeout(t);
  }, [isAbandoned, relampagoCoupon]);

  if (!show || !relampagoCoupon) return null;

  const remainingMs = Math.max(0, relampagoCoupon.expiresAt - now);
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  const discount = subtotal * relampagoCoupon.percent;
  const total = subtotal - discount;
  const brl = (n: number) =>
    n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const handleGoToCart = () => {
    setShow(false);
    router.push('/carrinho');
  };

  const handleClose = () => {
    dismissRelampago();
    setShow(false);
  };

  return (
    <div
      className="fixed inset-0 z-[300] bg-ink/95 backdrop-blur-md flex items-end sm:items-center justify-center"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-md mx-0 sm:mx-4 bg-gradient-to-br from-gold/20 via-ink-800 to-ink-900 border-2 border-gold/50 rounded-t-3xl sm:rounded-3xl shadow-2xl animate-slide-up overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
      >
        <button
          aria-label="Fechar"
          onClick={handleClose}
          className="absolute top-3 right-3 p-2 rounded-full bg-ink-700/80 z-10"
        >
          <X className="w-4 h-4 text-cream" />
        </button>

        {/* Header com cupom em destaque */}
        <div className="bg-gradient-to-r from-gold via-gold-light to-gold p-5 text-ink">
          <div className="flex items-center justify-center gap-2 mb-1">
            <Sparkles className="w-5 h-5" />
            <span className="text-xs font-black uppercase tracking-widest">
              Só pra você
            </span>
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="text-center">
            <div className="font-serif text-3xl font-black leading-tight">
              CUPOM RELÂMPAGO
            </div>
            <div className="font-mono text-xl font-black mt-1 bg-ink/10 inline-block px-3 py-1 rounded-lg">
              {relampagoCoupon.code}
            </div>
            <div className="text-2xl font-black mt-2">
              10% OFF
            </div>
          </div>
          {/* Countdown */}
          <div className="mt-3 flex items-center justify-center gap-2 bg-ink/20 rounded-full py-1.5 px-3">
            <Clock className="w-4 h-4 animate-pulse" />
            <span className="font-mono text-sm font-black tabular-nums">
              Expira em {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
            </span>
          </div>
        </div>

        {/* Conteúdo */}
        <div className="p-5">
          <h3 className="font-serif text-xl font-bold text-gold text-center">
            Você esqueceu uma sacola cheia 💛
          </h3>

          {/* Mini grid de itens */}
          <div className="mt-3 grid grid-cols-3 gap-2">
            {items.slice(0, 3).map((it, idx) => (
              <div
                key={idx}
                className="aspect-square bg-ink-900 rounded-lg overflow-hidden relative"
              >
                {it.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={it.image} alt={it.name} className="w-full h-full object-cover" />
                )}
                {it.quantity > 1 && (
                  <span className="absolute top-1 right-1 bg-gold text-ink text-[10px] font-black px-1.5 rounded-full">
                    {it.quantity}
                  </span>
                )}
              </div>
            ))}
            {items.length > 3 && (
              <div className="aspect-square bg-ink-900/50 rounded-lg flex items-center justify-center text-cream/60 font-bold text-sm">
                +{items.length - 3}
              </div>
            )}
          </div>

          {/* Valores */}
          <div className="mt-4 space-y-1 text-sm">
            <div className="flex justify-between text-cream/70">
              <span>Subtotal ({items.length} {items.length === 1 ? 'peça' : 'peças'})</span>
              <span className="tabular-nums">{brl(subtotal)}</span>
            </div>
            <div className="flex justify-between text-emerald-400 font-bold">
              <span>Cupom {relampagoCoupon.code}</span>
              <span className="tabular-nums">−{brl(discount)}</span>
            </div>
            <div className="flex justify-between items-baseline pt-2 border-t border-ink-600">
              <span className="text-cream/80 font-bold">Total com cupom</span>
              <span className="font-serif text-2xl font-black text-gold tabular-nums">
                {brl(total)}
              </span>
            </div>
          </div>

          {/* CTAs */}
          <button
            onClick={handleGoToCart}
            className="btn-gold-lg w-full mt-5 animate-pulse"
          >
            <ShoppingCart className="w-5 h-5" />
            Voltar pra sacola
          </button>
          <button
            onClick={handleClose}
            className="w-full mt-2 text-xs text-cream/50 underline"
          >
            Agora não
          </button>
        </div>
      </div>
    </div>
  );
}
