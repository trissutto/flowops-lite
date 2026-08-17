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
import { PIX_DESCONTO_PCT, pixDiscount, pixTotal } from '@/lib/commerce/pix';
import { clearCheckoutDraft, readCheckoutDraft, writeCheckoutDraft } from '@/lib/commerce/checkout-draft';
import { formatPrice } from '@/lib/utils';
import {
  trackBeginCheckout,
  trackCouponApplied,
  trackCouponRemoved,
  trackCheckoutError,
  trackCheckoutSubmission,
  trackCheckoutRecovered,
  trackCardDeclined,
  trackPaymentRetry,
  trackPixCreated,
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
  CheckoutContact,
  CreateOrderInput,
  CreateOrderResult,
  CustomerIdentity,
  CheckoutErrorCode,
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
 * O total que vale é recalculado no POST /api/checkout (cupom, pixPrice,
 * frete) e conferido de novo pelo BACKEND FlowOps, dono do pedido desde a
 * sprint 011. Se divergirem, o do backend vence — e é o que o PixPanel mostra
 * depois do pedido criado.
 */

type Step = 1 | 2 | 3 | 4;

/**
 * Mensagens elegantes por cenário — a cliente nunca vê status HTTP nem stack.
 * O `error` do server já vem elegante por contrato (CreateOrderResult); estas
 * cobrem o que acontece ANTES de uma resposta existir.
 */
const ERRO_GENERICO =
  'Não conseguimos concluir seu pedido agora. Fica tranquila: nada foi cobrado — tente de novo em instantes.';
/** Cartão que nem chegou a ser tokenizado (gateway sem chave, rede caiu). */
const ERRO_CARTAO =
  'Não conseguimos validar seu cartão agora. Tente de novo ou finalize com Pix — sai com 5% off e cai na hora.';

/**
 * CAMPO REPROVADO → A FRASE QUE DIZ ONDE MEXER.
 *
 * "Alguns dados do pedido precisam ser revisados" mandava a cliente procurar
 * agulha no palheiro: as sessões do painel mostram gente tentando 4, 5, 6
 * vezes o MESMO pedido, falhando sempre pelo mesmo campo, sem nunca descobrir
 * qual. O `field` vem do BFF (só o nome do campo, nunca o valor) e vira a
 * seção onde ela precisa clicar em "Editar".
 */
const AVISO_POR_CAMPO: Record<string, string> = {
  name: 'Confira o nome completo em Identificação — ele não foi aceito do jeito que está.',
  // CPF e e-mail moram em PAGAMENTO desde 17/08 — apontar pra Identificação
  // mandava a cliente procurar o campo na etapa errada.
  email: 'Confira o e-mail em Pagamento — ele não foi aceito do jeito que está.',
  cpf: 'Confira o CPF em Pagamento — ele não foi aceito do jeito que está.',
  phone: 'Confira o celular em Identificação — ele precisa ter DDD e só números.',
  street: 'Confira a rua em Entrega: o texto está longo demais para a etiqueta (até 160 caracteres).',
  number: 'Confira o número em Entrega: use só o número (até 20 caracteres) e leve o resto para o complemento.',
  complement: 'Confira o complemento em Entrega: ele está longo demais (até 80 caracteres).',
  neighborhood: 'Confira o bairro em Entrega — ele não foi aceito do jeito que está.',
  city: 'Confira a cidade em Entrega — ela não foi aceita do jeito que está.',
  uf: 'Confira o estado (UF) em Entrega — use as duas letras, como SP.',
  cep: 'Confira o CEP em Entrega — ele precisa ter 8 números.',
  endereco_ausente: 'Falta o endereço de entrega. Abra a seção Entrega e confira os dados.',
  shippingQuoteId: 'A opção de entrega expirou. Abra a seção Entrega e escolha o frete de novo.',
  item_size: 'Uma peça da sacola está com o tamanho fora do padrão. Remova e adicione ela de novo.',
  item_image_src: 'Uma peça da sacola está sem foto no cadastro. Remova e adicione ela de novo.',
  item_unitPrice: 'O preço de uma peça mudou. Atualize a página e confira a sacola.',
  total: 'Algo não fechou no total do pedido. Revise a sacola e tente novamente.',
};

function mensagemAcionavel(
  code: CheckoutErrorCode,
  serverMessage: string | undefined,
  method: 'pix' | 'card',
): string {
  const mensagens: Partial<Record<CheckoutErrorCode, string>> = {
    card_declined: 'O cartão não aprovou esta compra. Confira os dados, tente outro cartão ou escolha Pix.',
    catalog_unavailable: 'Uma peça, preço ou estoque mudou enquanto você comprava. Revise a sacola antes de tentar novamente.',
    coupon_invalid: 'O cupom não está mais válido para este pedido. Remova ou troque o cupom e tente novamente.',
    shipping_invalid: 'A opção de entrega mudou ou expirou. Volte à entrega e escolha o frete novamente.',
    validation_error: 'Alguns dados do pedido precisam ser revisados antes de continuar.',
    rate_limited: 'Foram feitas muitas tentativas seguidas. Aguarde um minuto ou escolha Pix.',
    payment_unavailable: 'O pagamento está temporariamente indisponível. Tente Pix ou tente novamente em instantes.',
    internal_error: ERRO_GENERICO,
    network_error: 'A conexão falhou antes da confirmação. Seus dados continuam preenchidos; tente novamente.',
    invalid_response: ERRO_GENERICO,
  };
  return mensagens[code] ?? serverMessage ?? (method === 'card' ? ERRO_CARTAO : ERRO_GENERICO);
}

export default function CheckoutPage() {
  const router = useRouter();
  const mounted = useMounted();

  const lines = useCartStore((s) => s.lines);
  const clearCart = useCartStore((s) => s.clear);
  const subtotal = useCartSubtotal();

  /* Estado das 4 seções — a página é a dona da sequência. */
  const [step, setStep] = useState<Step>(1);
  const [contact, setContact] = useState<CheckoutContact | null>(null);
  const [customer, setCustomer] = useState<CustomerIdentity | null>(null);
  /** Ver `finalizar()`: guarda contra pedido duplicado no clique repetido. */
  const enviandoRef = useRef(false);
  const [shipping, setShipping] = useState<ShippingSelection | null>(null);
  const [payment, setPayment] = useState<PaymentSelection | null>(null);
  const [coupon, setCoupon] = useState<CouponResult | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [failureCount, setFailureCount] = useState(0);
  const [lastErrorCode, setLastErrorCode] = useState<CheckoutErrorCode | null>(null);
  /** Pedido criado aguardando PIX — troca a página inteira pelo PixPanel. */
  const [pixOrder, setPixOrder] = useState<Order | null>(null);
  const [draftReady, setDraftReady] = useState(false);

  useEffect(() => {
    const draft = readCheckoutDraft(window.sessionStorage);
    if (draft) {
      setContact(draft.contact);
      setCustomer(draft.customer);
      setShipping(draft.shipping);
      setPayment(draft.payment);
      // A etapa 4 não existe mais (17/08): rascunho com pagamento escolhido
      // volta pra 3. Ir pra 4 deixava TODAS as seções colapsadas, sem
      // nenhum botão na tela — checkout morto depois de um F5.
      setStep(draft.contact ? (draft.shipping ? 3 : 2) : 1);
    }
    setDraftReady(true);
  }, []);

  useEffect(() => {
    if (!draftReady) return;
    writeCheckoutDraft(window.sessionStorage, { contact, customer, shipping, payment });
  }, [draftReady, contact, customer, shipping, payment]);

  /** Captura mínima para recuperação. Nunca bloqueia nem atrasa o checkout. */
  function saveRecovery(nextContact: CheckoutContact) {
    void fetch('/api/checkout/recovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        sessionId: getSessionId(), anonymousId: getAnonymousId(),
        name: nextContact.name, phone: nextContact.phone,
        recoveryConsent: nextContact.recoveryConsent,
        subtotal, path: '/checkout', attribution: captureAttribution(),
        items: lines.map((line) => ({
          productId: line.productId, name: line.name, size: line.size,
          color: line.color, quantity: line.quantity, unitPrice: line.unitPrice,
        })),
      }),
    }).catch(() => undefined);
  }

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
  /**
   * O Pix desconta de verdade a partir de 06/08 — antes a tela prometia 5% em
   * três lugares e o total saía cheio. A base é o subtotal já sem o cupom, pra
   * 10% + 5% não virarem 15% sobre o valor original.
   */
  const descontoPix = pixDiscount(subtotal - discount, payment?.method);
  const total = subtotal - discount - descontoPix + (shippingPrice ?? 0);
  const totalPix = pixTotal(subtotal - discount, shippingPrice ?? 0);

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

  /**
   * RECEBE O QUE ACABOU DE SER ESCOLHIDO (17/08).
   *
   * Agora o mesmo clique que escolhe PIX/cartão já cria o pedido. `setState`
   * do React não é síncrono: ler `customer`/`payment` do estado aqui pegaria
   * os valores VELHOS (null) e a função sairia calada no primeiro `if`.
   * Por isso os parâmetros — o estado continua sendo atualizado pra tela,
   * mas quem manda no envio é o argumento.
   */
  async function finalizar(over?: { customer?: CustomerIdentity; payment?: PaymentSelection }) {
    const cliente = over?.customer ?? customer;
    const pagamento = over?.payment ?? payment;
    // A trava é um REF, não o estado: dois cliques rápidos no mesmo botão
    // rodam na mesma renderização, onde `submitting` ainda vale false —
    // e sairiam dois pedidos. O ref muda na hora, antes do await.
    if (!cliente || !shipping || !pagamento || enviandoRef.current) return;
    enviandoRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    if (failureCount > 0) trackPaymentRetry(pagamento.method, failureCount + 1);
    trackCheckoutSubmission(pagamento.method);

    // O campo `tracking` costura a compra ao funil: anonymous/session ligam
    // ao GA4, fbp/fbc casam a CAPI, attribution fecha o "de onde veio".
    const input: CreateOrderInput = {
      customer: cliente,
      shippingAddress: shipping.address,
      shippingQuoteId: shipping.quote.id,
      cep: shipping.cep,
      items: lines,
      couponCode: coupon?.ok ? coupon.code : undefined,
      paymentMethod: pagamento.method,
      installments: pagamento.installments,
      // Token do cartão (quando houver): o número ficou no navegador, isto é
      // a única coisa que viaja — ver CardForm.
      cardToken: pagamento.cardToken,
      tracking: {
        anonymous_id: getAnonymousId(),
        session_id: getSessionId(),
        ...getMetaBrowserIds(),
        attribution: { ...captureAttribution() },
        recovery_consent: contact?.recoveryConsent === true,
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
        const code = result?.code ?? (result ? 'api_rejected' : 'invalid_response');
        const attempt = failureCount + 1;
        setFailureCount(attempt);
        setLastErrorCode(code);
        const field = result?.field;
        trackCheckoutError(pagamento.method, code, { stage: 'submission', attempt, field });
        if (code === 'card_declined') trackCardDeclined(attempt);
        // A mensagem do server tem PRECEDÊNCIA: por contrato ela já vem
        // elegante e é específica ("cartão recusado", "cupom expirou") — bem
        // mais útil que o genérico. Os textos locais cobrem só o que acontece
        // quando o server não conseguiu dizer nada. E o aviso POR CAMPO ganha
        // dos dois: repetir a mesma tentativa sem saber o que corrigir é o que
        // fazia a cliente desistir depois da sexta vez.
        setSubmitError(
          (field ? AVISO_POR_CAMPO[field] : undefined) ??
            mensagemAcionavel(code, result?.error, pagamento.method),
        );
        return;
      }

      // Pedido existe no server → a sacola local cumpriu o papel dela.
      // (Se o PIX expirar, o produto volta pro estoque no server; manter a
      // sacola viva aqui criaria pedido duplicado no F5.)
      clearCheckoutDraft(window.sessionStorage);
      clearCart();

      if (failureCount > 0 && result.order.payment.method === 'card') {
        trackCheckoutRecovered('card', result.order.id);
      }

      // ⚠️ NENHUM purchase disparado aqui: o pedido ainda nem foi pago.
      // Quem dispara é o SERVER, no webhook de pagamento (docs/purchase.md).
      if (result.order.payment.method === 'pix' && result.order.payment.pix) {
        trackPixCreated();
        setPixOrder(result.order);
        window.scrollTo({ top: 0 });
      } else {
        router.push(`/checkout/confirmacao/${result.order.id}`);
      }
    } catch {
      const attempt = failureCount + 1;
      setFailureCount(attempt);
      setLastErrorCode('network_error');
      trackCheckoutError(pagamento.method, 'network_error', { stage: 'submission', attempt });
      setSubmitError(mensagemAcionavel('network_error', undefined, pagamento.method));
    } finally {
      enviandoRef.current = false;
      setSubmitting(false);
    }
  }

  /* ------------------------------------------------------------- RENDER */

  // O carrinho vem do localStorage (zustand persist): antes do mount o server
  // e o client discordam — skeleton segura a tela sem flash de "sacola vazia".
  if (!mounted || !draftReady) return <CheckoutSkeleton />;

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
          pixDiscount={descontoPix}
          total={total}
          className="lg:sticky lg:top-8 lg:col-start-2 lg:row-start-1"
        />

        {/* As 4 seções — sempre no DOM, na mesma ordem (ver SectionShell). */}
        <div className="flex flex-col gap-4 lg:col-start-1 lg:row-start-1">
          <SectionShell
            step={1}
            title="Identificação"
            state={stateOf(1, contact !== null)}
            summary={
              contact
                ? `${contact.name} · ${maskPhone(contact.phone)}`
                : undefined
            }
            onEdit={() => setStep(1)}
          >
            <IdentificationStep
              defaults={contact}
              onDone={(c) => {
                setSubmitError(null);
                setContact(c);
                // Mudou nome/telefone? Atualiza a identidade em vez de ZERAR: zerar
                // apagava o CPF e o e-mail que ela já tinha digitado na etapa 3.
                if (customer && (customer.phone !== c.phone || customer.name !== c.name)) {
                  setCustomer({ ...customer, name: c.name, phone: c.phone });
                }
                saveRecovery(c);
                // Editou só a identificação com o resto pronto? Volta pro
                // pagamento — ninguém refaz etapa já concluída, e a etapa 4
                // (revisão) não existe mais.
                setStep(!shipping ? 2 : 3);
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
              pecas={lines.reduce((s, l) => s + l.quantity, 0)}
              itemsTracked={itemsTracked}
              defaults={shipping}
              onDone={(s) => {
                setSubmitError(null);
                setShipping(s);
                setStep(3);
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
                  ? `PIX à vista · ${PIX_DESCONTO_PCT}% off aplicado no total`
                  : `Cartão de crédito · ${payment.installments ?? 1}x sem juros`
                : undefined
            }
            onEdit={() => setStep(3)}
          >
            {/* ESCOLHA PRIMEIRO, CONFIRMAÇÃO DEPOIS.

                A etapa pede CPF e e-mail e então libera PIX/cartão. Escolher
                o método apenas revela seus detalhes; um CTA explícito cria o
                pedido. Isso evita que explorar o PIX gere abandono artificial.

                O motivo é medido: de 14 a 17/08, quem tentou UMA vez
                converteu 71%; duas, 25%; três ou mais, ZERO. Cada botão
                intermediário era uma chance de desistir sem nada acontecer.

                Nome e telefone vêm da etapa 1 e completam a identidade aqui
                — por isso a etapa não abre sem `contact`. */}
            <PaymentStep
              total={total}
              pixTotal={totalPix}
              itemsTracked={itemsTracked}
              defaultsNota={customer ? { email: customer.email, cpf: customer.cpf } : null}
              // Ela corrigiu o CPF/e-mail depois de uma recusa? O painel de erro
              // abaixo reenvia com `finalizar()` sem argumento, que lê o ESTADO —
              // sem isto ele mandaria o valor velho de novo, e a cliente veria a
              // mesma recusa por um erro que já tinha consertado.
              onNotaChange={(nota) => setCustomer((atual) => (atual ? { ...atual, ...nota } : atual))}
              enviando={submitting}
              onDone={(p, nota) => {
                if (!contact) return;
                setSubmitError(null);
                setFailureCount(0);
                setLastErrorCode(null);
                const identity: CustomerIdentity = {
                  name: contact.name,
                  phone: contact.phone,
                  email: nota.email,
                  cpf: nota.cpf,
                };
                setPayment(p);
                setCustomer(identity);
                void finalizar({ customer: identity, payment: p });
              }}
            />

            {/* SÓ APARECE SE DEU ERRADO.

                Era a revisão obrigatória antes de comprar; virou o painel de
                recuperação depois de uma tentativa que falhou. Mostrar o
                pedido inteiro tem valor exatamente aqui: cartão recusado ou
                cupom expirado é quando a cliente precisa conferir os dados,
                trocar pro PIX ou tentar de novo — antes disso era só um
                obstáculo entre ela e a compra.

                Ela continua com CPF, e-mail e os dois métodos logo acima:
                a etapa 3 não colapsa, porque `step` nunca sai do 3. */}
            {customer && shipping && payment && submitError && (
              <ReviewCard
                customer={customer}
                shipping={shipping}
                payment={payment}
                lines={lines}
                subtotal={subtotal}
                shippingPrice={shippingPrice ?? 0}
                coupon={coupon}
                pixDiscount={descontoPix}
                total={total}
                submitting={submitting}
                error={submitError}
                failureCount={failureCount}
                errorCode={lastErrorCode}
                onEditIdentity={() => setCustomer(null)}
                onReviewData={() => {
                  setSubmitError(null);
                  setCustomer(null);
                }}
                onUsePix={() => {
                  setSubmitError(null);
                  setFailureCount(0);
                  setLastErrorCode(null);
                  setPayment({ method: 'pix' });
                }}
                onSubmit={() => void finalizar()}
                reenvioNoFormulario={payment.method === 'card'}
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
