'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ShoppingBag, Sparkles, Ticket, X } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/feedback/EmptyState';
import { CartLineRow } from '@/components/commerce/CartLineRow';
import { useCartStore } from '@/store/cart';
import { useIsCartOpen, useUiStore } from '@/store/ui';
import { useMounted } from '@/hooks';
import { applyCoupon } from '@/lib/commerce/cupom';
import { findQuote, freeShippingGap } from '@/lib/commerce/frete';
import {
  toTrackedItem,
  trackCouponApplied,
  trackCouponRemoved,
  trackViewCart,
} from '@/lib/tracking';
import { cn, formatPrice } from '@/lib/utils';
import { transition } from '@/lib/motion';
import type { CartLine } from '@/types';

/**
 * MINI-CART — o drawer da sacola. Abre pelo ícone do header e sozinho ao
 * adicionar uma peça (a cliente VÊ a peça entrar, sem sair da página — o
 * porquê está em docs/mini-cart.md).
 *
 * Montado uma vez no layout (public) e controlado 100% pelo uiStore: nenhuma
 * página precisa saber que ele existe. Segue o padrão do repo de overlay
 * sempre montado (prop `open` + inert) — nada de AnimatePresence.
 */

/** CartLine → item de tracking (a sacola não guarda categoria/coleção). */
function itensRastreados(lines: CartLine[]) {
  return lines.map((l) =>
    toTrackedItem(
      { id: l.productId, sku: l.productId, name: l.name, price: l.unitPrice },
      { tamanho: l.size, cor: l.color, quantidade: l.quantity },
    ),
  );
}

export function MiniCart() {
  const open = useIsCartOpen();
  const closeOverlay = useUiStore((s) => s.closeOverlay);
  const router = useRouter();
  const pathname = usePathname();
  const mounted = useMounted();

  const rawLines = useCartStore((s) => s.lines);
  const couponCode = useCartStore((s) => s.couponCode);
  const setCoupon = useCartStore((s) => s.setCoupon);
  const cep = useCartStore((s) => s.cep);
  const shippingQuoteId = useCartStore((s) => s.shippingQuoteId);

  // Antes da hidratação o localStorage ainda não falou — renderiza vazio dos
  // dois lados (server e client) pra não divergir o HTML.
  const lines = mounted ? rawLines : [];
  const count = lines.reduce((sum, l) => sum + l.quantity, 0);
  const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const gap = freeShippingGap(subtotal);

  /* ----------------------------------------------------------------- cupom */
  const [codigoDigitado, setCodigoDigitado] = useState('');
  const [avisoCupom, setAvisoCupom] = useState<{ ok: boolean; texto: string } | null>(null);

  // O cupom persistido é REVALIDADO a cada render: se o subtotal caiu abaixo
  // do mínimo, o desconto some na hora — nunca mostramos um desconto morto.
  const cupomAplicado = useMemo(
    () => (couponCode ? applyCoupon(couponCode, subtotal) : null),
    [couponCode, subtotal],
  );
  const desconto = cupomAplicado?.ok ? cupomAplicado.discount : 0;

  function aplicarCupom() {
    const resultado = applyCoupon(codigoDigitado, subtotal);
    setAvisoCupom({ ok: resultado.ok, texto: resultado.message });
    if (resultado.ok) {
      setCoupon(resultado.code);
      trackCouponApplied(resultado.code, resultado.discount);
      setCodigoDigitado('');
    }
  }

  function removerCupom() {
    if (couponCode) trackCouponRemoved(couponCode);
    setCoupon(null);
    setAvisoCupom(null);
  }

  /* ----------------------------------------------------------------- frete */
  // Estimado: só quando a cliente já cotou (CEP + opção salvos na página ou
  // no checkout). Cupom de frete zera o valor do envio, não o subtotal.
  const freteEstimado = cep && shippingQuoteId ? findQuote(cep, subtotal, shippingQuoteId) : undefined;
  const precoFrete =
    freteEstimado === undefined
      ? undefined
      : cupomAplicado?.ok && cupomAplicado.kind === 'shipping'
        ? 0
        : freteEstimado.price;

  const total = Math.max(0, subtotal - desconto) + (precoFrete ?? 0);

  /* -------------------------------------------------------------- tracking */
  // view_cart no momento em que o drawer ABRE com itens — abrir é "ver a
  // sacola", igual à página. O ref evita disparo duplo por re-render.
  const jaRastreouAbertura = useRef(false);
  useEffect(() => {
    if (!open) {
      jaRastreouAbertura.current = false;
      return;
    }
    if (jaRastreouAbertura.current || lines.length === 0) return;
    jaRastreouAbertura.current = true;
    trackViewCart(itensRastreados(lines));
  }, [open, lines]);

  // Navegou (clicou numa peça, foi pro checkout)? O drawer não pode ficar
  // aberto por cima da página nova.
  const rotaAnterior = useRef(pathname);
  useEffect(() => {
    if (rotaAnterior.current === pathname) return;
    rotaAnterior.current = pathname;
    if (open) closeOverlay();
  }, [pathname, open, closeOverlay]);

  const vazio = lines.length === 0;

  return (
    <Drawer
      open={open}
      onClose={closeOverlay}
      label="Sua sacola"
      side="right"
      size="md"
      header={
        vazio ? undefined : (
          <h2 className="font-display text-h3 text-ink">
            Sua sacola <span className="tabular text-ink-soft">({count})</span>
          </h2>
        )
      }
      footer={
        vazio ? undefined : (
          <div className="flex flex-col gap-2.5">
            <Button block size="lg" href="/checkout" onClick={closeOverlay}>
              Finalizar compra
            </Button>
            <Button block variant="secondary" href="/carrinho" onClick={closeOverlay}>
              Ver sacola completa
            </Button>
            <button
              type="button"
              onClick={closeOverlay}
              className="link-underline mx-auto mt-1 text-small font-light text-ink-soft"
            >
              Continuar comprando
            </button>
          </div>
        )
      }
    >
      {vazio ? (
        <EmptyState
          icon={<ShoppingBag strokeWidth={1.5} />}
          title="Sua sacola está vazia"
          description="As peças que você escolher aparecem aqui. Que tal começar pelo que acabou de chegar?"
          action={{
            label: 'Ver novidades',
            onClick: () => {
              closeOverlay();
              router.push('/novidades');
            },
          }}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {/* Barra do frete grátis — o incentivo mais honesto da sacola. */}
          <div className="rounded-sm border border-border bg-surface-alt/60 px-4 py-3.5">
            {gap.reached ? (
              <motion.p
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={transition.base}
                className="flex items-center gap-2 text-small font-medium text-primary-strong"
              >
                <Sparkles className="size-3.5" strokeWidth={1.75} />
                Você ganhou frete grátis
              </motion.p>
            ) : (
              <p className="text-small font-light text-ink-soft">
                Faltam{' '}
                <span className="tabular font-medium text-ink">{formatPrice(gap.missing)}</span>{' '}
                para o frete grátis
              </p>
            )}
            <div
              role="progressbar"
              aria-valuenow={Math.round(gap.progress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Progresso até o frete grátis"
              className="mt-2.5 h-1 overflow-hidden rounded-pill bg-border"
            >
              <motion.div
                animate={{ width: `${gap.progress * 100}%` }}
                transition={transition.slow}
                className="h-full rounded-pill bg-primary"
              />
            </div>
          </div>

          {/* Linhas */}
          <ul className="flex flex-col divide-y divide-border">
            {lines.map((line) => (
              <li key={line.id} className="py-5 first:pt-0 last:pb-0">
                <CartLineRow line={line} />
              </li>
            ))}
          </ul>

          {/* Cupom compacto */}
          <div className="border-t border-border pt-5">
            {couponCode && cupomAplicado ? (
              <div className="flex items-start justify-between gap-3">
                <p
                  className={cn(
                    'flex items-center gap-2 text-small',
                    cupomAplicado.ok ? 'text-ink' : 'text-danger',
                  )}
                >
                  <Ticket className="size-3.5 shrink-0 text-primary-strong" strokeWidth={1.75} />
                  {cupomAplicado.message}
                </p>
                <button
                  type="button"
                  onClick={removerCupom}
                  aria-label={`Remover cupom ${couponCode}`}
                  className="-m-1 shrink-0 rounded-pill p-1 text-ink-muted transition-colors hover:text-ink"
                >
                  <X className="size-3.5" strokeWidth={1.5} />
                </button>
              </div>
            ) : (
              <>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    aplicarCupom();
                  }}
                  className="flex gap-2"
                >
                  <label htmlFor="minicart-cupom" className="sr-only">
                    Código do cupom
                  </label>
                  <input
                    id="minicart-cupom"
                    value={codigoDigitado}
                    onChange={(e) => {
                      setCodigoDigitado(e.target.value);
                      setAvisoCupom(null);
                    }}
                    placeholder="Cupom de desconto"
                    autoComplete="off"
                    className="w-full rounded-md border border-border bg-surface px-4 py-2.5 text-small text-ink uppercase transition-shadow duration-[180ms] placeholder:normal-case placeholder:text-ink-muted/70 focus:border-primary focus:shadow-[0_0_0_3px_rgba(184,145,43,0.12)] focus:outline-none"
                  />
                  <Button type="submit" variant="secondary" size="sm">
                    Aplicar
                  </Button>
                </form>
                {avisoCupom && (
                  <p
                    role="status"
                    className={cn('mt-2 text-small', avisoCupom.ok ? 'text-ink-soft' : 'text-danger')}
                  >
                    {avisoCupom.texto}
                  </p>
                )}
              </>
            )}
          </div>

          {/* Totais — verde SÓ no total, a convenção de dinheiro da marca. */}
          <dl className="flex flex-col gap-2 border-t border-border pt-5 text-body">
            <div className="flex justify-between">
              <dt className="font-light text-ink-soft">Subtotal</dt>
              <dd className="tabular text-ink">{formatPrice(subtotal)}</dd>
            </div>
            {desconto > 0 && (
              <div className="flex justify-between">
                <dt className="font-light text-ink-soft">Desconto ({couponCode})</dt>
                <dd className="tabular text-ink">−{formatPrice(desconto)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="font-light text-ink-soft">Frete estimado</dt>
              <dd className="tabular text-ink">
                {precoFrete === undefined
                  ? 'calculado no checkout'
                  : precoFrete === 0
                    ? 'Grátis'
                    : formatPrice(precoFrete)}
              </dd>
            </div>
            <div className="mt-1 flex items-baseline justify-between border-t border-border pt-3">
              <dt className="font-medium text-ink">Total</dt>
              <dd className="tabular text-h4 font-medium text-success">{formatPrice(total)}</dd>
            </div>
          </dl>
        </div>
      )}
    </Drawer>
  );
}
