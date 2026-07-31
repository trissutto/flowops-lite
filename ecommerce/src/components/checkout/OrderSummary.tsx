'use client';

import { useState } from 'react';
import Image from 'next/image';
import { ChevronDown, TicketPercent, X } from 'lucide-react';
import { BLUR_DATA_URL, cn, formatPrice } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import type { CartLine } from '@/types';
import type { CouponResult, ShippingQuote } from '@/types/checkout';

/**
 * Resumo do pedido — a coluna direita sticky no desktop e, no mobile, um
 * bloco COLAPSÁVEL no topo (aberto por padrão só o total: em tela pequena o
 * resumo inteiro empurraria o formulário pra fora da dobra, e o formulário é
 * o trabalho a fazer).
 *
 * Regras de exibição de dinheiro:
 *   frete undefined → "a calcular" (etapa 2 ainda não confirmou)
 *   frete 0         → "Grátis" em verde, nunca "R$ 0,00"
 *   total           → o ÚNICO número verde grande da coluna (verde = dinheiro)
 *
 * O desconto exibido vem de `applyCoupon` (client, cortesia de UX); o server
 * revalida o cupom e recalcula tudo no POST /api/checkout.
 */

interface OrderSummaryProps {
  lines: CartLine[];
  subtotal: number;
  /** undefined até a etapa de entrega ser confirmada. */
  shipping?: ShippingQuote | null;
  /** Preço de frete já com cupom FRETEGRATIS aplicado (a página decide). */
  shippingPrice?: number;
  coupon: CouponResult | null;
  onApplyCoupon: (code: string) => void;
  onRemoveCoupon: () => void;
  total: number;
  className?: string;
}

export function OrderSummary({
  lines,
  subtotal,
  shipping,
  shippingPrice,
  coupon,
  onApplyCoupon,
  onRemoveCoupon,
  total,
  className,
}: OrderSummaryProps) {
  const [openMobile, setOpenMobile] = useState(false);
  const pecas = lines.reduce((sum, l) => sum + l.quantity, 0);

  const detalhes = (
    <div className="flex flex-col gap-5">
      {/* Itens compactos */}
      <ul className="flex flex-col gap-4">
        {lines.map((line) => (
          <li key={line.id} className="flex items-center gap-3.5">
            {/* Miniatura com dimensão FIXA — zero layout shift. */}
            <div className="relative h-[76px] w-[60px] shrink-0 overflow-hidden rounded-sm bg-surface-alt">
              <Image
                src={line.image.src}
                alt={line.image.alt}
                fill
                sizes="60px"
                placeholder="blur"
                blurDataURL={BLUR_DATA_URL}
                className="object-cover"
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-small font-normal text-ink">{line.name}</p>
              <p className="text-small text-ink-muted">
                Tam {line.size}
                {line.color ? ` · ${line.color}` : ''}
                {line.quantity > 1 ? ` · ${line.quantity} un` : ''}
              </p>
            </div>
            <span className="tabular shrink-0 text-small text-ink">
              {formatPrice(line.unitPrice * line.quantity)}
            </span>
          </li>
        ))}
      </ul>

      <CouponField coupon={coupon} onApply={onApplyCoupon} onRemove={onRemoveCoupon} />

      {/* Totais */}
      <dl className="flex flex-col gap-2 border-t border-border pt-4 text-body">
        <div className="flex justify-between text-ink-soft">
          <dt>Subtotal ({pecas} {pecas === 1 ? 'peça' : 'peças'})</dt>
          <dd className="tabular">{formatPrice(subtotal)}</dd>
        </div>
        <div className="flex justify-between text-ink-soft">
          <dt>Frete{shipping ? ` · ${shipping.label}` : ''}</dt>
          <dd className={cn('tabular', shippingPrice === 0 && 'font-medium text-success')}>
            {shippingPrice === undefined ? 'a calcular' : shippingPrice === 0 ? 'Grátis' : formatPrice(shippingPrice)}
          </dd>
        </div>
        {coupon?.ok && coupon.discount > 0 && (
          <div className="flex justify-between text-success">
            <dt>Cupom {coupon.code}</dt>
            <dd className="tabular">−{formatPrice(coupon.discount)}</dd>
          </div>
        )}
        <div className="flex items-baseline justify-between border-t border-border pt-3">
          <dt className="font-display text-h4 text-ink">Total</dt>
          <dd className="tabular text-h4 font-medium text-success">{formatPrice(total)}</dd>
        </div>
      </dl>
    </div>
  );

  return (
    <div className={className}>
      {/* Mobile: barra colapsável (total sempre visível). */}
      <div className="rounded-md border border-border bg-surface lg:hidden">
        <button
          type="button"
          onClick={() => setOpenMobile((v) => !v)}
          aria-expanded={openMobile}
          className="flex w-full items-center justify-between gap-3 px-5 py-4"
        >
          <span className="text-small font-medium text-ink">
            Resumo do pedido ({pecas} {pecas === 1 ? 'peça' : 'peças'})
          </span>
          <span className="flex items-center gap-2">
            <span className="tabular text-body font-medium text-success">{formatPrice(total)}</span>
            <ChevronDown
              aria-hidden
              className={cn('size-4 text-ink-muted transition-transform duration-[180ms]', openMobile && 'rotate-180')}
            />
          </span>
        </button>
        {openMobile && <div className="border-t border-border px-5 py-5">{detalhes}</div>}
      </div>

      {/* Desktop: card sempre aberto (o sticky fica na página). */}
      <div className="hidden rounded-md border border-border bg-surface p-6 lg:block">
        <h2 className="mb-5 font-display text-h4 text-ink">Resumo do pedido</h2>
        {detalhes}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

/** Campo de cupom — aplicado vira uma linha com "remover"; erro vira texto. */
function CouponField({
  coupon,
  onApply,
  onRemove,
}: {
  coupon: CouponResult | null;
  onApply: (code: string) => void;
  onRemove: () => void;
}) {
  const [code, setCode] = useState('');

  if (coupon?.ok) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-sm bg-primary-wash px-4 py-3">
        <span className="flex items-center gap-2 text-small font-medium text-primary-strong">
          <TicketPercent className="size-4" /> {coupon.code}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remover cupom ${coupon.code}`}
          className="text-ink-muted transition-colors hover:text-danger"
        >
          <X className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim()) onApply(code);
      }}
      className="flex flex-col gap-2"
    >
      <div className="flex gap-2">
        <label htmlFor="checkout-cupom" className="sr-only">
          Cupom de desconto
        </label>
        <input
          id="checkout-cupom"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="Cupom de desconto"
          autoComplete="off"
          className="w-full min-w-0 flex-1 rounded-md border border-border bg-surface px-4 py-2.5 text-small text-ink placeholder:text-ink-muted/70 focus:border-primary focus:outline-none"
        />
        <Button type="submit" variant="secondary" size="sm" className="shrink-0">
          Aplicar
        </Button>
      </div>
      {/* Mensagem de cupom inválido — sempre elegante, vem de applyCoupon. */}
      {coupon && !coupon.ok && (
        <p role="alert" className="text-small text-danger">
          {coupon.message}
        </p>
      )}
    </form>
  );
}
