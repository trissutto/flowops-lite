'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShoppingBag } from 'lucide-react';
import { useCartStore, useCartSubtotal } from '@/store/cart';
import { useMounted } from '@/hooks';
import { Container } from '@/components/layout/Container';
import { EmptyState } from '@/components/feedback/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { SectionShell, type SectionState } from '@/components/checkout/SectionShell';
import { IdentificationStep } from '@/components/checkout/IdentificationStep';
import { ShippingStep, type ShippingSelection } from '@/components/checkout/ShippingStep';
import { PaymentStep, type PaymentSelection } from '@/components/checkout/PaymentStep';
import { ReviewCard } from '@/components/checkout/ReviewCard';
import { OrderSummary } from '@/components/checkout/OrderSummary';
import { PixPanel } from '@/components/checkout/PixPanel';
import { maskPhone } from '@/components/checkout/masks';
import { applyCoupon } from '@/lib/commerce/cupom';
import { formatPrice } from '@/lib/utils';
import {
  trackBeginCheckout,
  trackCouponApplied,
  trackCouponRemoved,
  type TrackedItem,
} from '@/lib/tracking';
import {
  captureAttribution,
  getAnonymousId,
  getMetaBrowserIds,
  getSessionId,
} from '@/lib/tracking/identity';
import type {
  CouponResult,
  CreateOrderInput,
  CreateOrderResult,
  CustomerIdentity,
  Order,
} from '@/types/checkout';

/**
 * CHECKOUT ONE-PAGE — quatro seções progressivas numa página só.
 *
 * Por que one-page e não wizard de rotas: cada troca de rota no checkout é um
 * ponto de fuga (voltar do navegador, refresh que perde estado, latência).
 * Aqui o estado inteiro mora NESTE componente e as seções são um accordion
 * CONTROLADO — concluiu, colapsa num resumo de 1 linha com "editar"; a
 * próxima abre sozinha. Ver docs/checkout.md.
 *
 * O client NUNCA decide valor: subtotal/desconto/frete daqui são exibição.
 * O total que vale é recalculado pelo server no POST /api/checkout (cupom,
 * pixPrice, frete). Se divergirem, o do server vence — e é o que o PixPanel
 * mostra depois do pedido criado.
 */

type Step = 1 | 2 | 3 | 4;

/**
 * Mensagens elegantes por cenário — a cliente nunca vê status HTTP nem stack.
 * O `error` do server já vem elegante por contrato (CreateOrderResult); estas
 * cobrem o que acontece ANTES de uma resposta existir.
 */
const ERRO_GENERICO =
  'Não conseguimos concluir seu pedido agora. Fica tranquila: nada foi cobrado — tente de novo em instantes.';
const ERRO_CARTAO =
  'Estamos finalizando este meio de pagamento. Por enquanto, escolha PIX (com 5% off) ou boleto — rapidinho igual.';

export default function CheckoutPage() {
  const router = useRouter();
  const mounted = useMounted();

  const lines = useCartStore((s) => s.lines);
  const clearCart = useCartStore((s) => s.clear);
  const subtotal = useCartSubtotal();

  /* Estado das 4 seções — a página é a dona da sequência. */
  const [step, setStep] = useState<Step>(1);
  const [customer, setCustomer] = useState<CustomerIdentity | null>(null);
  const [shipping, setShipping] = useState<ShippingSelection | null>(null);
  const [payment, setPayment] = useState<PaymentSelection | null>(null);
  const [coupon, setCoupon] = useState<CouponResult | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** Pedido criado aguardando PIX — troca a página inteira pelo PixPanel. */
  const [pixOrder, setPixOrder] = useState<Order | null>(null);

  /* Carrinho → formato de tracking (uma vez, reusado pelos 4 eventos). */
  const itemsTracked: TrackedItem[] = useMemo(
    () =>
      lines.map((l) => ({
        product_id: l.productId,
        sku: l.productId,
        name: l.name,
        cor: l.color,
        tamanho: l.size,
        quantidade: l.quantity,
        valor: l.unitPrice,
      })),
    [lines],
  );

  /* begin_checkout — UMA vez por visita à página, com os itens reais. */
  const beginFired = useRef(false);
  useEffect(() => {
    if (mounted && lines.length > 0 && !beginFired.current) {
      beginFired.current = true;
      trackBeginCheckout(itemsTracked, coupon?.ok ? coupon.code : undefined);
    }
  }, [mounted, lines.length, itemsTracked, coupon]);

  /* Totais de EXIBIÇÃO (o server recalcula os que valem). */
  const freteGratisCupom = coupon?.ok === true && coupon.kind === 'shipping';
  const shippingPrice = shipping ? (freteGratisCupom ? 0 : shipping.quote.price) : undefined;
  const discount = coupon?.ok ? coupon.discount : 0;
  const total = subtotal - discount + (shippingPrice ?? 0);

  function handleApplyCoupon(code: string) {
    const result = applyCoupon(code, subtotal);
    setCoupon(result);
    if (result.ok) trackCouponApplied(result.code, result.discount);
  }

  function handleRemoveCoupon() {
    if (coupon?.ok) trackCouponRemoved(coupon.code);
    setCoupon(null);
  }

  /* ------------------------------------------------------------- SUBMIT */

  async function finalizar() {
    if (!customer || !shipping || !payment || submitting) return;
    setSubmitting(true);
    setSubmitError(null);

    // O campo `tracking` costura a compra ao funil: anonymous/session ligam
    // ao GA4, fbp/fbc casam a CAPI, attribution fecha o "de onde veio".
    const input: CreateOrderInput = {
      customer,
      shippingAddress: shipping.address,
      shippingQuoteId: shipping.quote.id,
      cep: shipping.cep,
      items: lines,
      couponCode: coupon?.ok ? coupon.code : undefined,
      paymentMethod: payment.method,
      installments: payment.installments,
      cardToken: payment.cardToken,
      tracking: {
        anonymous_id: getAnonymousId(),
        session_id: getSessionId(),
        ...getMetaBrowserIds(),
        attribution: { ...captureAttribution() },
      },
    };

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const result = (await res.json().catch(() => null)) as CreateOrderResult | null;

      if (!result?.ok || !result.order) {
        // A mensagem do server já é elegante por contrato (recusa da
        // operadora, método indisponível…) — repassa; fallback só sem corpo.
        setSubmitError(result?.error ?? (payment.method === 'card' ? ERRO_CARTAO : ERRO_GENERICO));
        return;
      }

      // Pedido existe no server → a sacola local cumpriu o papel dela.
      // (Se o PIX expirar, o produto volta pro estoque no server; manter a
      // sacola viva aqui criaria pedido duplicado no F5.)
      clearCart();

      // ⚠️ NENHUM purchase disparado aqui: o pedido ainda nem foi pago.
      // Quem dispara é o SERVER, no webhook de pagamento (docs/purchase.md).
      if (result.order.payment.method === 'pix' && result.order.payment.pix) {
        setPixOrder(result.order);
        window.scrollTo({ top: 0 });
      } else {
        router.push(`/checkout/confirmacao/${result.order.id}`);
      }
    } catch {
      setSubmitError(ERRO_GENERICO);
    } finally {
      setSubmitting(false);
    }
  }

  /* ------------------------------------------------------------- RENDER */

  // O carrinho vem do localStorage (zustand persist): antes do mount o server
  // e o client discordam — skeleton segura a tela sem flash de "sacola vazia".
  if (!mounted) return <CheckoutSkeleton />;

  // Pedido PIX criado: a página vira o painel de pagamento.
  if (pixOrder) {
    return (
      <Container width="page" className="py-10 lg:py-16">
        <PixPanel order={pixOrder} />
      </Container>
    );
  }

  if (lines.length === 0) {
    return (
      <Container width="page" className="py-10 lg:py-16">
        <EmptyState
          icon={<ShoppingBag strokeWidth={1.25} />}
          title="Sua sacola está vazia"
          description="Escolha as peças que vão te vestir super bem e volte aqui — o checkout leva menos de dois minutos."
          action={{ label: 'Ver novidades', href: '/novidades' }}
          secondaryAction={{ label: 'Ir para a loja', href: '/' }}
        />
      </Container>
    );
  }

  /** Estado de cada seção a partir do passo ativo + dados existentes. */
  const stateOf = (n: Step, hasData: boolean): SectionState =>
    step === n ? 'active' : hasData ? 'done' : 'locked';

  return (
    <Container width="wide" className="py-8 lg:py-12">
      <h1 className="sr-only">Finalizar compra</h1>

      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start lg:gap-12">
        {/* Resumo — primeiro no DOM de propósito: no mobile ele é o bloco
            colapsável do topo; no desktop o grid o coloca na coluna direita
            (sticky). Uma fonte, duas posições, zero duplicação. */}
        <OrderSummary
          lines={lines}
          subtotal={subtotal}
          shipping={shipping?.quote}
          shippingPrice={shippingPrice}
          coupon={coupon}
          onApplyCoupon={handleApplyCoupon}
          onRemoveCoupon={handleRemoveCoupon}
          total={total}
          className="lg:sticky lg:top-8 lg:col-start-2 lg:row-start-1"
        />

        {/* As 4 seções — sempre no DOM, na mesma ordem (ver SectionShell). */}
        <div className="flex flex-col gap-4 lg:col-start-1 lg:row-start-1">
          <SectionShell
            step={1}
            title="Identificação"
            state={stateOf(1, customer !== null)}
            summary={
              customer
                ? `${customer.name} · ${customer.email} · ${maskPhone(customer.phone)}`
                : undefined
            }
            onEdit={() => setStep(1)}
          >
            <IdentificationStep
              defaults={customer}
              onDone={(c) => {
                setCustomer(c);
                // Editou só a identificação com o resto pronto? Volta direto
                // pra revisão — ninguém refaz etapa já concluída.
                setStep(!shipping ? 2 : !payment ? 3 : 4);
              }}
            />
          </SectionShell>

          <SectionShell
            step={2}
            title="Entrega"
            state={stateOf(2, shipping !== null)}
            summary={
              shipping
                ? shipping.quote.kind === 'retirada'
                  ? `${shipping.quote.label} · ${shipping.quote.storeLabel ?? ''} · Grátis`
                  : `${shipping.quote.label} · ${shipping.address?.street}, ${shipping.address?.number} — ${shipping.address?.city}/${shipping.address?.uf} · ${
                      (shippingPrice ?? 0) === 0 ? 'Grátis' : formatPrice(shippingPrice ?? 0)
                    }`
                : undefined
            }
            onEdit={() => setStep(2)}
          >
            <ShippingStep
              subtotal={subtotal}
              itemsTracked={itemsTracked}
              defaults={shipping}
              onDone={(s) => {
                setShipping(s);
                setStep(!payment ? 3 : 4);
              }}
            />
          </SectionShell>

          <SectionShell
            step={3}
            title="Pagamento"
            state={stateOf(3, payment !== null)}
            summary={
              payment
                ? payment.method === 'pix'
                  ? 'PIX à vista · 5% off aplicado no total'
                  : payment.method === 'boleto'
                    ? 'Boleto bancário'
                    : `Cartão de crédito · ${payment.installments ?? 1}x sem juros`
                : undefined
            }
            onEdit={() => setStep(3)}
          >
            <PaymentStep
              total={total}
              itemsTracked={itemsTracked}
              defaults={payment}
              onDone={(p) => {
                setPayment(p);
                setStep(4);
              }}
            />
          </SectionShell>

          <SectionShell step={4} title="Revisão" state={step === 4 ? 'active' : 'locked'}>
            {customer && shipping && payment && (
              <ReviewCard
                customer={customer}
                shipping={shipping}
                payment={payment}
                lines={lines}
                subtotal={subtotal}
                shippingPrice={shippingPrice ?? 0}
                coupon={coupon}
                total={total}
                submitting={submitting}
                error={submitError}
                onSubmit={() => void finalizar()}
              />
            )}
          </SectionShell>
        </div>
      </div>
    </Container>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

/** Silhueta da página — mesmas larguras do layout final (zero salto). */
function CheckoutSkeleton() {
  return (
    <Container width="wide" className="py-8 lg:py-12">
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start lg:gap-12">
        <Skeleton className="h-14 rounded-md lg:col-start-2 lg:row-start-1 lg:h-[420px]" />
        <div className="flex flex-col gap-4 lg:col-start-1 lg:row-start-1">
          <Skeleton className="h-64 rounded-md" />
          <Skeleton className="h-16 rounded-md" />
          <Skeleton className="h-16 rounded-md" />
          <Skeleton className="h-16 rounded-md" />
        </div>
      </div>
    </Container>
  );
}
