'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShoppingBag } from 'lucide-react';
import { lineKey, useCartStore, useCartSubtotal } from '@/store/cart';
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
import { maskPhone } from '@/components/checkout/masks';
import { applyCoupon } from '@/lib/commerce/cupom';
import { PIX_DESCONTO_PCT, pixDiscount, pixTotal } from '@/lib/commerce/pix';
import { clearCheckoutDraft, readCheckoutDraft, writeCheckoutDraft } from '@/lib/commerce/checkout-draft';
import { useClienteLogada } from '@/hooks/useClienteLogada';
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
import type { CartLine } from '@/types';
import type {
  CouponResult,
  CheckoutContact,
  CreateOrderInput,
  CreateOrderResult,
  CustomerIdentity,
  CheckoutErrorCode,
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
 *
 * DEPOIS DO PEDIDO CRIADO A PÁGINA NÃO GUARDA NADA (17/08). PIX ou cartão, o
 * destino é `/checkout/confirmacao/:id`, que lê o pedido do servidor — o
 * PixPanel vive lá. Antes o pedido PIX morava num `useState` daqui: F5,
 * "voltar" ou a aba descartada quando a cliente ia pro app do banco
 * zeravam o estado, e como a sacola já tinha sido limpa ela caía em "Sua
 * sacola está vazia" sem QR, sem link, sem e-mail — pra pagar precisava
 * remontar tudo e nascia um 2º pedido. Ver `finalizar()`.
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
  // "Atualize a página" não atualizava nada: o preço fica congelado na sacola
  // (localStorage) e F5 restaura o mesmo. Remover e readicionar é o que renova.
  item_unitPrice: 'O preço de uma peça mudou. Remova a peça da sacola e adicione ela de novo.',
  total: 'Algo não fechou no total do pedido. Revise a sacola e tente novamente.',
};

/**
 * SERVER > LOCAL > FALLBACK (17/08).
 *
 * A frase do servidor tem precedência: ela é específica por contrato — "o
 * cartão não tinha limite disponível", "\"Vestido X\" no tamanho 50 acabou de
 * esgotar", "esse vale-troca é nominal" — e o BFF só repassa texto já curado
 * (`OrderStoreError.publico`, nunca status/stack). De 15 a 17/08 a ordem
 * estava invertida (#899): o texto local genérico vencia SEMPRE, porque
 * `mensagens` cobre todos os códigos do backend. Cartão sem limite virava
 * "confira os dados, tente outro cartão" — a cliente redigitava o MESMO
 * cartão, tomava a 2ª e a 3ª recusa, e da 3ª em diante a aprovação é zero.
 *
 * Os textos locais ficam como fallback pra quando o servidor não conseguiu
 * dizer nada (rede, resposta inválida) ou mandou `error` vazio — por isso o
 * `||` na frente: `??` deixaria a string vazia passar.
 */
function mensagemAcionavel(
  code: CheckoutErrorCode,
  serverMessage: string | undefined,
  method: 'pix' | 'card',
): string {
  const mensagens: Partial<Record<CheckoutErrorCode, string>> = {
    card_declined: 'O cartão não aprovou esta compra. Confira os dados, tente outro cartão ou escolha Pix.',
    catalog_unavailable: 'Uma peça, preço ou estoque mudou enquanto você comprava. Ajuste a sacola antes de tentar novamente.',
    coupon_invalid: 'O cupom não está mais válido para este pedido. Remova ou troque o cupom e tente novamente.',
    shipping_invalid: 'A opção de entrega mudou ou expirou. Volte à entrega e escolha o frete novamente.',
    validation_error: 'Alguns dados do pedido precisam ser revisados antes de continuar.',
    rate_limited: 'Foram feitas muitas tentativas seguidas. Aguarde um minuto ou escolha Pix.',
    payment_unavailable: 'O pagamento está temporariamente indisponível. Tente Pix ou tente novamente em instantes.',
    internal_error: ERRO_GENERICO,
    network_error: 'A conexão falhou antes da confirmação. Seus dados continuam preenchidos; tente novamente.',
    invalid_response: ERRO_GENERICO,
  };
  return (
    (serverMessage?.trim() || undefined) ??
    mensagens[code] ??
    (method === 'card' ? ERRO_CARTAO : ERRO_GENERICO)
  );
}

/**
 * A peça que o backend recusou por PREÇO, com o preço de agora — vem em
 * `item` na recusa `catalog_unavailable` do backend novo. Tipado aqui e lido
 * de forma tolerante porque o backend (Railway) e o site (Vercel) sobem em
 * momentos diferentes: sem o campo, o fluxo é o de sempre.
 */
interface ItemRecusado {
  productId: string;
  /** Vazio quando o backend não tinha tamanho (manda `null`). */
  size: string;
  color?: string;
  precoAtual: number;
}

function itemRecusadoDe(result: CreateOrderResult | null): ItemRecusado | undefined {
  const raw = (result as (CreateOrderResult & { item?: unknown }) | null)?.item;
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.productId !== 'string' || !o.productId) return undefined;
  if (typeof o.precoAtual !== 'number' || !Number.isFinite(o.precoAtual) || o.precoAtual <= 0) return undefined;
  return {
    productId: o.productId,
    size: typeof o.size === 'string' ? o.size : '',
    color: typeof o.color === 'string' && o.color ? o.color : undefined,
    precoAtual: o.precoAtual,
  };
}

/**
 * Casa a peça recusada com a linha da sacola: pela chave exata
 * (produto+tamanho+cor), depois produto+tamanho, depois só produto — este
 * último SÓ se for uma linha só (duas cores/tamanhos do mesmo produto sem
 * tamanho na resposta é ambíguo, e mexer no preço da linha errada é pior
 * que mandar a cliente ajustar a sacola).
 */
function linhaRecusada(lines: CartLine[], item: ItemRecusado): CartLine | undefined {
  if (item.size) {
    const exata = lines.find((l) => l.id === lineKey(item.productId, item.size, item.color));
    if (exata) return exata;
    const porTamanho = lines.filter((l) => l.productId === item.productId && l.size === item.size);
    if (porTamanho.length === 1) return porTamanho[0];
    return undefined;
  }
  const porProduto = lines.filter((l) => l.productId === item.productId);
  return porProduto.length === 1 ? porProduto[0] : undefined;
}

export default function CheckoutPage() {
  const router = useRouter();
  const mounted = useMounted();

  const lines = useCartStore((s) => s.lines);
  const clearCart = useCartStore((s) => s.clear);
  const refreshPrice = useCartStore((s) => s.refreshPrice);
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
  /**
   * Pedido criado no servidor, navegação pra confirmação em andamento. Segura
   * o skeleton no lugar do "Sua sacola está vazia": a sacola é limpa ANTES do
   * `router.replace` (senão um F5 no meio criaria pedido duplicado) e, sem
   * esta flag, a tela piscaria vazia entre o clear e a troca de rota.
   */
  const [pedidoCriado, setPedidoCriado] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  /** O bloco `role="alert"` do ReviewCard — pra rolar/focar quando o erro nasce. */
  const erroRef = useRef<HTMLDivElement>(null);

  /**
   * ERRO VISÍVEL, SEMPRE. O aviso nasce no ReviewCard, logo abaixo do CTA —
   * mas no celular com o teclado aberto ou o formulário do cartão na tela
   * ele ainda pode ficar fora da dobra. `block: 'nearest'` só rola se
   * precisar; `failureCount` nas deps re-rola quando a MESMA mensagem repete
   * (a string não muda, a tentativa sim). O foco leva o leitor de tela junto.
   */
  useEffect(() => {
    if (!submitError) return;
    const el = erroRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    el.focus({ preventScroll: true });
  }, [submitError, failureCount]);

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

  /**
   * A CLIENTE LOGADA NÃO DIGITA DE NOVO (22/08).
   *
   * O checkout nunca consultava a conta: nome, WhatsApp, CPF, e-mail e o
   * endereço salvo em /conta/enderecos ficavam de fora, e quem já comprava na
   * loja física redigitava tudo no celular com a compra já decidida.
   *
   * Só preenche o que está VAZIO, e só depois que o rascunho da sessão foi
   * lido: o que ela digitou nesta compra sempre vence o cadastro. Sem sessão
   * ou com backend fora, `cliente` é null e nada muda.
   */
  const { cliente: clienteLogada, enderecos: enderecosSalvos } = useClienteLogada();
  const jaPreencheuDaConta = useRef(false);
  useEffect(() => {
    if (!draftReady || !clienteLogada || jaPreencheuDaConta.current) return;
    jaPreencheuDaConta.current = true;

    setContact((atual) =>
      atual ??
      (clienteLogada.nome && clienteLogada.telefone.length >= 10
        ? { name: clienteLogada.nome, phone: clienteLogada.telefone, recoveryConsent: false }
        : null),
    );
    setCustomer((atual) =>
      atual ?? {
        name: clienteLogada.nome,
        email: clienteLogada.email,
        cpf: clienteLogada.cpf,
        phone: clienteLogada.telefone,
      },
    );
  }, [draftReady, clienteLogada]);

  /**
   * Com nome e WhatsApp já conhecidos, a etapa 1 não é mais uma parada: ela
   * abre CONFIRMADA e o checkout começa na entrega. A cliente ainda pode
   * abrir e corrigir — a seção continua editável, só não bloqueia mais.
   */
  useEffect(() => {
    if (!draftReady || !contact || step !== 1) return;
    if (!jaPreencheuDaConta.current) return;
    setStep(2);
    // Só na primeira vez que o preenchimento vem da conta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftReady, contact]);

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
  /**
   * A MESMA regra do BFF (api/checkout/route.ts): o cupom de frete zera o
   * ECONÔMICO (Correios), nunca o expresso nem a retirada (que já é 0). A
   * tela zerava qualquer opção — SEDEX + FRETEGRATIS aparecia "Grátis" e o
   * BFF cobrava o SEDEX calado. Desde que o preço que a cliente VIU viaja
   * no pedido (`shippingPriceSeen`), tela e BFF precisam concordar, senão o
   * BFF recusa por "frete mudou" um frete que só a tela tinha zerado.
   */
  const freteZerado = (q: ShippingSelection['quote']) => freteGratisCupom && q.kind === 'correios';
  const shippingPrice = shipping ? (freteZerado(shipping.quote) ? 0 : shipping.quote.price) : undefined;
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

    /**
     * O QUE ELA LEU NA TELA (17/08). Calculado AQUI, do argumento `pagamento`
     * — o `total` de render usa `payment?.method` do estado, que no clique
     * ainda é o velho. O BFF compara o frete recotado com `shippingPriceSeen`
     * e recusa ANTES de criar pedido se subiu (`shipping_changed`); e manda
     * `min(totalSeen, total dele)` como teto pro backend — o teto passa a
     * proteger o número que ela leu, não a conta do próprio BFF. Aba antiga
     * do BFF ignora os dois campos (zod `.optional().catch(undefined)`).
     */
    const arredonda = (v: number) => Math.round(v * 100) / 100;
    const freteVisto = arredonda(freteZerado(shipping.quote) ? 0 : shipping.quote.price);
    const totalVisto = arredonda(
      subtotal - discount - pixDiscount(subtotal - discount, pagamento.method) + freteVisto,
    );

    // O campo `tracking` costura a compra ao funil: anonymous/session ligam
    // ao GA4, fbp/fbc casam a CAPI, attribution fecha o "de onde veio".
    const input: CreateOrderInput & { shippingPriceSeen: number; totalSeen: number } = {
      shippingPriceSeen: freteVisto,
      totalSeen: totalVisto,
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
        // `motivo`/`ref` (22/08): qual das sete recusas do guard e em que peça.
        // Só medição — a frase que a cliente lê continua vindo de `error`.
        trackCheckoutError(pagamento.method, code, {
          stage: 'submission',
          attempt,
          field,
          motivo: result?.motivo,
          ref: result?.ref,
        });
        if (code === 'card_declined') trackCardDeclined(attempt);

        // O FRETE SUBIU ENTRE A TELA E O PEDIDO: o BFF recusou ANTES de criar
        // qualquer coisa e mandou a cotação nova. Atualizamos o preço da opção
        // já escolhida (o resumo passa a mostrar o valor que vale) e a frase
        // do BFF diz "de R$ X pra R$ Y"; o próximo Finalizar manda o preço novo
        // como `shippingPriceSeen` e passa. Sem isto o clique seguinte
        // repetiria o preço velho e a recusa — em loop.
        if ((code as string) === 'shipping_changed') {
          const q = (result as { quote?: { price?: unknown } } | null)?.quote;
          const novoPreco = typeof q?.price === 'number' && Number.isFinite(q.price) ? q.price : undefined;
          if (novoPreco !== undefined) {
            setShipping((atual) => (atual ? { ...atual, quote: { ...atual.quote, price: novoPreco } } : atual));
          }
          setSubmitError(
            result?.error?.trim() ||
              'O frete pro seu CEP foi atualizado. Confira a entrega antes de pagar — nada foi cobrado.',
          );
          return;
        }

        // PREÇO SUBIU ENTRE O ADD E O CHECKOUT: o backend novo diz QUAL peça e
        // QUANTO custa agora. Reescrevemos o preço na sacola (o guard só
        // recusa quando o catálogo está MAIOR que o informado, então mandar o
        // preço atual é o único caminho que passa) e a compra volta a ficar a
        // um clique — antes a frase era "atualize a página", e F5 restaurava a
        // mesma sacola com o mesmo preço congelado. Nada foi criado no
        // servidor: a recusa acontece antes de pedido/cobrança existirem.
        const item = code === 'catalog_unavailable' ? itemRecusadoDe(result) : undefined;
        if (item) {
          const linha = linhaRecusada(lines, item);
          if (linha && Math.abs(linha.unitPrice - item.precoAtual) > 0.009) {
            const antes = linha.unitPrice;
            refreshPrice(linha.id, item.precoAtual);
            setSubmitError(
              `O preço de ${linha.name} passou de ${formatPrice(antes)} pra ${formatPrice(item.precoAtual)} — confira o total e finalize.`,
            );
            return;
          }
        }

        // SERVER > LOCAL > FALLBACK (ver `mensagemAcionavel`). O aviso POR
        // CAMPO ganha dos dois: repetir a mesma tentativa sem saber o que
        // corrigir é o que fazia a cliente desistir depois da sexta vez.
        // `backend_validacao` NÃO é campo — é a marca de telemetria de que o
        // `validation_error` nasceu no backend (route.ts); nesse caso a frase
        // do backend já diz o campo ("O CPF informado não parece completo").
        setSubmitError(
          (field && field !== 'backend_validacao' ? AVISO_POR_CAMPO[field] : undefined) ??
            mensagemAcionavel(code, result?.error, pagamento.method),
        );
        return;
      }

      // Pedido existe no server → a sacola local cumpriu o papel dela.
      // (Se o PIX expirar, o produto volta pro estoque no server; manter a
      // sacola viva aqui criaria pedido duplicado no F5.) `pedidoCriado`
      // entra no MESMO lote de estado que o clear: a tela segura o skeleton
      // em vez de piscar "sacola vazia" enquanto a rota troca.
      setPedidoCriado(true);
      clearCheckoutDraft(window.sessionStorage);
      clearCart();

      if (failureCount > 0 && result.order.payment.method === 'card') {
        trackCheckoutRecovered('card', result.order.id);
      }

      // ⚠️ NENHUM purchase disparado aqui: o pedido ainda nem foi pago.
      // Quem dispara é o SERVER, no webhook de pagamento (docs/purchase.md).
      if (result.order.payment.method === 'pix' && result.order.payment.pix) {
        trackPixCreated();
        // A URL É O ESTADO DO PIX. `replace`, não `push`: "voltar" não pode
        // reabrir um /checkout vazio por cima do código que ela precisa pagar.
        // A confirmação lê o pedido pelo GET (que já traz QR + copia-e-cola)
        // e desenha o PixPanel enquanto o status for `awaiting_payment`.
        router.replace(`/checkout/confirmacao/${result.order.id}`);
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

  // Pedido criado, indo pra /checkout/confirmacao/:id — a sacola já foi
  // limpa; sem isto a cliente veria "sacola vazia" por um instante.
  if (pedidoCriado) return <CheckoutSkeleton />;

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
              salvos={enderecosSalvos}
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
                // Saídas por código, desde a 1ª falha (ver ReviewCard).
                onRemoveCoupon={
                  coupon
                    ? () => {
                        handleRemoveCoupon();
                        setSubmitError(null);
                      }
                    : undefined
                }
                onEditShipping={() => {
                  setSubmitError(null);
                  setStep(2);
                }}
                alertRef={erroRef}
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
