'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ShoppingBag, Ticket, X } from 'lucide-react';
import { Container } from '@/components/layout/Container';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { CartLineRow } from '@/components/commerce/CartLineRow';
import { ProgressoFreteGratis } from '@/components/commerce/ProgressoFreteGratis';
import { CompletarFreteGratis } from '@/components/commerce/CompletarFreteGratis';
import { RecommendationRail } from '@/components/commerce/RecommendationRail';
import { MaisDaFamilia } from '@/components/commerce/MaisDaFamilia';
import { getRecommendations } from '@/lib/recommendations/engine';
import { useCartStore } from '@/store/cart';
import { useCepGuardado, useCepStore } from '@/store/cep';
import { useMounted } from '@/hooks';
import { applyCoupon, conheceCupom, validarCupomRemoto } from '@/lib/commerce/cupom';
import { fetchQuotes, isValidCep, onlyDigits } from '@/lib/commerce/frete';
import {
  avisoDaLinha as calcularAvisoDaLinha,
  cartStockBlocksCheckout,
  currentCartStockNotice,
  type CartStockNotice,
} from '@/lib/commerce/cart-stock';
import { mapPeca } from '@/services/products';
import { toTrackedItem, trackViewCart, trackCouponApplied, trackCouponRemoved } from '@/lib/tracking';
import { cn, formatPrice } from '@/lib/utils';
import type { CartLine, Product } from '@/types';
import type { ShippingQuote } from '@/types/checkout';
import { SeloPagamentoSeguro } from '@/components/commerce/SeloPagamentoSeguro';

/**
 * PÁGINA DA SACOLA — a visão completa (o mini-cart é o resumo rápido).
 *
 * Desktop: duas colunas — linhas à esquerda, resumo sticky à direita (o
 * total acompanha o scroll, como a cliente espera de um checkout sério).
 * Mobile: empilhado, resumo depois das peças.
 *
 * As REGRAS (cupom, frete, frete grátis) não moram aqui: vêm de
 * lib/commerce/* — as mesmas funções que o mini-cart e o checkout usam.
 * Esta página só orquestra e exibe. Ver docs/cart.md.
 */

/** Peça crua do BFF — o shape que `mapPeca` traduz (o tipo não é exportado). */
type PecaApi = Parameters<typeof mapPeca>[0];

/** CartLine → item de tracking (a sacola não guarda categoria/coleção). */
function itensRastreados(lines: CartLine[]) {
  return lines.map((l) =>
    toTrackedItem(
      { id: l.productId, sku: l.productId, name: l.name, price: l.unitPrice },
      { tamanho: l.size, cor: l.color, quantidade: l.quantity },
    ),
  );
}

/** Máscara de CEP enquanto digita: 00000-000. */
function maskCep(value: string): string {
  const d = onlyDigits(value).slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

type AvisoEstoque = CartStockNotice;

export default function CarrinhoPage() {
  const mounted = useMounted();

  const rawLines = useCartStore((s) => s.lines);
  const rawSaved = useCartStore((s) => s.savedForLater);
  const couponCode = useCartStore((s) => s.couponCode);
  const setCoupon = useCartStore((s) => s.setCoupon);
  const cepSalvo = useCartStore((s) => s.cep);
  const cepGuardado = useCepGuardado();
  const guardarCep = useCepStore((s) => s.guardar);
  const setCep = useCartStore((s) => s.setCep);
  const shippingQuoteId = useCartStore((s) => s.shippingQuoteId);
  const setShippingQuote = useCartStore((s) => s.setShippingQuote);

  // Antes da hidratação o localStorage não falou — skeleton dos dois lados.
  const lines = mounted ? rawLines : [];
  const saved = mounted ? rawSaved : [];
  const count = lines.reduce((sum, l) => sum + l.quantity, 0);
  const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);

  /* ----------------------------------------------------------------- cupom */
  const [codigoDigitado, setCodigoDigitado] = useState('');
  const [avisoCupom, setAvisoCupom] = useState<{ ok: boolean; texto: string } | null>(null);
  const [aplicandoCupom, setAplicandoCupom] = useState(false);
  // Bump quando uma regra REMOTA chega (o cache em memória do lib/commerce/
  // cupom foi semeado) — sem isto o memo abaixo não reprocessa.
  const [regrasRev, setRegrasRev] = useState(0);

  // Revalidado a cada render: subtotal caiu abaixo do mínimo → desconto some.
  const cupomAplicado = useMemo(
    () => (couponCode ? applyCoupon(couponCode, subtotal) : null),
    // regrasRev é dependência de propósito (regra remota chegou → recalcula).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [couponCode, subtotal, regrasRev],
  );
  const desconto = cupomAplicado?.ok ? cupomAplicado.discount : 0;

  // Cupom salvo que o site não sabe calcular localmente (regra mora no
  // backend e o cache em memória morreu no reload) — revalida e resseia.
  useEffect(() => {
    if (!couponCode || conheceCupom(couponCode)) return;
    let vivo = true;
    validarCupomRemoto(couponCode, subtotal).then((r) => {
      if (!vivo) return;
      if (r.ok || r.reason === 'nominal_sem_cpf') setRegrasRev((v) => v + 1);
      else {
        setCoupon(null);
        setAvisoCupom({ ok: false, texto: r.message });
      }
    });
    return () => {
      vivo = false;
    };
    // subtotal fora de propósito: o efeito só semeia a regra uma vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [couponCode, setCoupon]);

  async function aplicarCupom() {
    if (aplicandoCupom) return;
    setAplicandoCupom(true);
    try {
      // Backend primeiro (site_cupons: retaguarda + vale-troca); rede fora
      // cai na tabela local de campanhas dentro do próprio helper.
      const resultado = await validarCupomRemoto(codigoDigitado, subtotal);
      setAvisoCupom({ ok: resultado.ok, texto: resultado.message });
      if (resultado.ok) {
        setCoupon(resultado.code);
        trackCouponApplied(resultado.code, resultado.discount);
        setCodigoDigitado('');
      }
    } finally {
      setAplicandoCupom(false);
    }
  }

  function removerCupom() {
    if (couponCode) trackCouponRemoved(couponCode);
    setCoupon(null);
    setAvisoCupom(null);
  }

  /* ----------------------------------------------------------------- frete */
  const [cepInput, setCepInput] = useState('');

  /**
   * Pré-preenche — só depois da hidratação.
   *
   * Duas fontes, nesta ordem: o CEP DESTA SACOLA (escolha desta compra) e,
   * na falta dele, o CEP que a cliente digitou em qualquer outra tela
   * (`store/cep`, gravado pelo simulador da peça e pelo checkout). Antes só a
   * primeira existia, então quem calculou o frete na peça e foi pra sacola
   * digitava tudo de novo — a mesma pergunta, três telas seguidas.
   */
  useEffect(() => {
    if (!mounted) return;
    const inicial = cepSalvo || cepGuardado;
    if (inicial) setCepInput(maskCep(inicial));
  }, [mounted, cepSalvo, cepGuardado]);

  /**
   * A SACOLA MOSTRAVA UM FRETE QUE NÃO É O QUE SE COBRA (corrigido 17/08).
   *
   * Ela lia a tabela LOCAL — a de emergência, congelada no código. Pra um
   * CEP do litoral de SP ela anunciava SEDEX R$ 28,90 enquanto o checkout
   * cobrava R$ 9,99 pela promoção: quase 3× a mais, na tela exata em que a
   * cliente decide se continua. E escondia justamente o "frete
   * promocional", que é o argumento pra ela seguir.
   *
   * Agora é a MESMA fonte do checkout (`fetchQuotes` → /api/loja/frete):
   * mesma promoção, mesmo raio de 20 km na retirada, mesma ordem. Duas
   * telas com dois preços é como a cliente perde a confiança no total.
   *
   * `fetchQuotes` nunca rejeita — backend fora, ela mesma devolve a tabela
   * local. Então aqui não há caminho sem cotação.
   */
  const [cotacoes, setCotacoes] = useState<ShippingQuote[]>([]);
  const pecasNaSacola = lines.reduce((s, l) => s + l.quantity, 0);

  useEffect(() => {
    if (!isValidCep(cepInput)) {
      setCotacoes([]);
      return;
    }
    const controller = new AbortController();
    void fetchQuotes(cepInput, subtotal, pecasNaSacola || 1, controller.signal).then((r) => {
      if (!controller.signal.aborted) setCotacoes(r.quotes);
    });
    return () => controller.abort();
  }, [cepInput, subtotal, pecasNaSacola]);

  function aoDigitarCep(value: string) {
    const mascarado = maskCep(value);
    setCepInput(mascarado);
    if (isValidCep(mascarado)) {
      setCep(onlyDigits(mascarado));
      // Vale pro site inteiro, não só pra esta sacola: a próxima peça que ela
      // abrir já mostra o prazo em vez de pedir o CEP de novo.
      guardarCep(onlyDigits(mascarado));
    } else if (shippingQuoteId) {
      // CEP incompleto invalida a opção escolhida — sem cotação fantasma.
      setShippingQuote(null);
    }
  }

  const freteSelecionado = cotacoes.find((q) => q.id === shippingQuoteId);
  // Cupom de frete zera o ENVIO, não o subtotal (regra em lib/commerce/cupom).
  const precoFrete =
    freteSelecionado === undefined
      ? undefined
      : cupomAplicado?.ok && cupomAplicado.kind === 'shipping'
        ? 0
        : freteSelecionado.price;

  const total = Math.max(0, subtotal - desconto) + (precoFrete ?? 0);
  // Pix 5% off e 12x sem juros — as mesmas regras do precoPix/parcelamento
  // do catálogo. O valor que VALE é recalculado no server no checkout.
  const totalPix = Math.round(total * 0.95 * 100) / 100;
  const parcela12 = total / 12;

  /* -------------------------------------------------------------- tracking */
  const jaRastreouView = useRef(false);
  useEffect(() => {
    if (!mounted || jaRastreouView.current || lines.length === 0) return;
    jaRastreouView.current = true;
    trackViewCart(itensRastreados(lines));
  }, [mounted, lines]);

  /* ------------------------------------------- estoque em tempo (quase) real */
  const [avisosEstoque, setAvisosEstoque] = useState<Record<string, AvisoEstoque>>({});
  /**
   * As peças da sacola RESOLVIDAS no catálogo — saem da mesma revalidação de
   * estoque abaixo, de graça. É o que a recomendação precisa: `CartLine` não
   * guarda categoria, e sem categoria "Complete seu look" não tem o que
   * complementar.
   */
  const [pecasDaSacola, setPecasDaSacola] = useState<Product[]>([]);
  /**
   * AS SUGESTÕES QUE FICAM ANTES DO RESUMO (31/08).
   *
   * Os trilhos do rodapé desta página estavam mortos, e não por falta de
   * qualidade: **em 7 dias, 1.989 sessões abriram a sacola e "Complete seu
   * look" levou 3 cliques** — 0,15%. Eles moram DEPOIS do resumo e do botão
   * "Finalizar compra"; no celular, ninguém rola além do botão de fechar.
   *
   * A mesma sugestão, subida pra logo abaixo das peças, encontra o olho onde
   * ele já está. E é a fuga que mais custa: **52% dos pedidos pagos levam UMA
   * peça só** (2,01 de média em 30 dias).
   *
   * Formato `MaisDaFamilia` porque é o único trilho desenhado pra viver DENTRO
   * de uma coluna (é o que fica na coluna de compra da peça). `RecommendationRail`
   * se embrulha em `Section` de largura própria e quebraria a grade daqui.
   */
  const [sugestoes, setSugestoes] = useState<Product[]>([]);
  const jaRevalidou = useRef(false);

  useEffect(() => {
    if (!mounted || jaRevalidou.current || rawLines.length === 0) return;
    jaRevalidou.current = true;

    // BEST-EFFORT honesto: revalida via busca textual pelo SKU (não existe
    // endpoint de consulta por REF exata ainda). Miss na busca NÃO significa
    // esgotado — só avisamos quando a resposta AFIRMA indisponibilidade.
    // Falha de rede é silenciosa: aviso de estoque é cortesia, o checkout é
    // quem trava a venda de verdade. Roda uma vez, pras 8 primeiras linhas.
    const controller = new AbortController();

    /** Devolve o aviso (se houver) e a peça resolvida no catálogo. */
    async function revalidar(
      line: CartLine,
    ): Promise<{ aviso: [string, AvisoEstoque] | null; peca: Product | null }> {
      const nada = { aviso: null, peca: null };
      try {
        const resposta = await fetch(
          `/api/loja/produtos?busca=${encodeURIComponent(line.productId)}&perPage=5`,
          { signal: controller.signal },
        );
        if (!resposta.ok) return nada;
        const dados = await resposta.json();
        const peca = ((dados.itens ?? []) as PecaApi[]).find((p) => p.ref === line.productId);
        if (!peca) return nada;
        const produto = mapPeca(peca);

        // A REGRA mora em `lib/commerce/cart-stock` desde 22/08: o mini-cart
        // precisa da mesma, e duas cópias divergiriam no primeiro ajuste.
        const aviso = calcularAvisoDaLinha(line, peca);
        return { aviso: aviso ? ([line.id, aviso] as [string, AvisoEstoque]) : null, peca: produto };
      } catch {
        return nada;
      }
    }

    Promise.all(rawLines.slice(0, 8).map(revalidar)).then((resultados) => {
      const avisos = Object.fromEntries(
        resultados.map((r) => r.aviso).filter((a): a is [string, AvisoEstoque] => a !== null),
      );
      if (Object.keys(avisos).length) setAvisosEstoque(avisos);
      const pecas = resultados.map((r) => r.peca).filter((p): p is Product => p !== null);
      if (pecas.length) setPecasDaSacola(pecas);
    });

    return () => controller.abort();
  }, [mounted, rawLines]);

  /**
   * MESMO MOTOR do trilho do rodapé (`complete-seu-look`), olhando a sacola
   * INTEIRA: quem já tem calça e blusa não precisa de mais uma blusa. Sugestão
   * é cortesia — falha vira seção ausente, nunca erro na tela de quem está
   * fechando a compra.
   */
  useEffect(() => {
    if (!pecasDaSacola.length) return;
    let vivo = true;
    void getRecommendations({ kind: 'complete-seu-look', seeds: pecasDaSacola, limit: 6 })
      .then((r: Product[]) => {
        if (vivo) setSugestoes(r);
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, [pecasDaSacola]);

  /* ------------------------------------------------------------------ render */

  if (!mounted) {
    // Silhueta da página real — sem salto de layout quando o carrinho chegar.
    return (
      <Container className="py-12 lg:py-16">
        <Skeleton className="h-9 w-56" />
        <div className="mt-10 grid gap-12 lg:grid-cols-[1fr_400px]">
          <div className="flex flex-col gap-8">
            {Array.from({ length: 2 }, (_, i) => (
              <div key={i} className="flex gap-5">
                <Skeleton className="aspect-3/4 w-28 rounded-sm" />
                <div className="flex flex-1 flex-col gap-3">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-8 w-24" />
                </div>
              </div>
            ))}
          </div>
          <Skeleton className="h-96 rounded-md" />
        </div>
      </Container>
    );
  }

  const vazio = lines.length === 0;
  const avisoDaLinha = (line: CartLine): AvisoEstoque | undefined => {
    return currentCartStockNotice(line.quantity, avisosEstoque[line.id]);
  };
  const estoqueImpedeCheckout = lines.some((line) =>
    cartStockBlocksCheckout(line.quantity, avisosEstoque[line.id]),
  );

  return (
    <>
    <Container className="py-12 lg:py-16">
      <h1 className="font-display text-h2 text-ink">
        Sua sacola{' '}
        {count > 0 && <span className="tabular text-h4 font-light text-ink-soft">({count} {count === 1 ? 'peça' : 'peças'})</span>}
      </h1>

      {/* A meta do frete grátis aparece AQUI também, e não só no mini-carrinho:
          é nesta tela que a cliente decide fechar ou voltar pra vitrine — o
          momento em que "levo mais uma pra bater a meta" acontece. */}
      {!vazio && <ProgressoFreteGratis subtotal={subtotal} className="mt-6" />}

      {vazio && saved.length === 0 ? (
        <EmptyState
          icon={<ShoppingBag strokeWidth={1.5} />}
          title="Sua sacola está vazia"
          description="As peças que você escolher aparecem aqui. Que tal começar pelo que acabou de chegar?"
          action={{ label: 'Ver novidades', href: '/novidades' }}
          secondaryAction={{ label: 'Vestidos', href: '/categoria/vestidos' }}
        />
      ) : (
        <div className="mt-10 grid items-start gap-12 lg:grid-cols-[1fr_400px]">
          {/* ------------------------------------------------------- LINHAS */}
          <div>
            {vazio ? (
              <p className="text-body font-light text-ink-soft">
                Sua sacola está vazia — mas você guardou peças para depois, logo abaixo.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {lines.map((line) => (
                  <li key={line.id} className="py-7 first:pt-0">
                    <CartLineRow
                      line={line}
                      full
                      notice={avisoDaLinha(line)}
                      maxQuantity={avisoDaLinha(line)?.maxQuantity}
                    />
                  </li>
                ))}
              </ul>
            )}

            {/* Guardado para depois */}
            {saved.length > 0 && (
              <section aria-label="Guardado para depois" className="mt-14">
                <h2 className="font-display text-h3 text-ink">
                  Guardado para depois{' '}
                  <span className="tabular text-body font-light text-ink-soft">({saved.length})</span>
                </h2>
                <ul className="mt-6 flex flex-col divide-y divide-border">
                  {saved.map((line) => (
                    <li key={line.id} className="py-6 first:pt-0">
                      <CartLineRow line={line} saved full />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* A SEGUNDA PEÇA, ANTES DO BOTÃO DE FECHAR — ver `sugestoes`.
                Na coluna das peças de propósito: no celular ela cai logo
                depois da sacola e antes do resumo; no PC fica embaixo das
                linhas, ao lado do resumo grudado. */}
            {!vazio && sugestoes.length > 0 && (
              <MaisDaFamilia
                pecas={sugestoes}
                titulo="Leve também"
                lista="sacola-completa"
              />
            )}
          </div>

          {/* ------------------------------------------------------- RESUMO */}
          {!vazio && (
            <aside className="lg:sticky lg:top-28" aria-label="Resumo do pedido">
              <div className="rounded-md border border-border bg-surface p-6 sm:p-7">
                <h2 className="font-display text-h4 text-ink">Resumo</h2>

                <dl className="mt-5 flex flex-col gap-2.5 text-body">
                  <div className="flex justify-between">
                    <dt className="font-light text-ink-soft">Subtotal</dt>
                    <dd className="tabular text-ink">{formatPrice(subtotal)}</dd>
                  </div>
                  {desconto > 0 && couponCode && (
                    <div className="flex justify-between">
                      <dt className="font-light text-ink-soft">Desconto ({couponCode})</dt>
                      <dd className="tabular text-ink">−{formatPrice(desconto)}</dd>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <dt className="font-light text-ink-soft">Frete</dt>
                    <dd className="tabular text-ink">
                      {precoFrete === undefined
                        ? 'a calcular'
                        : precoFrete === 0
                          ? 'Grátis'
                          : formatPrice(precoFrete)}
                    </dd>
                  </div>
                </dl>

                {/* Cupom */}
                <div className="mt-6 border-t border-border pt-6">
                  {couponCode && cupomAplicado ? (
                    <div className="flex items-start justify-between gap-3">
                      <p
                        className={cn(
                          'flex items-start gap-2 text-small',
                          cupomAplicado.ok ? 'text-ink' : 'text-danger',
                        )}
                      >
                        <Ticket className="mt-0.5 size-3.5 shrink-0 text-primary-strong" strokeWidth={1.75} />
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
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        aplicarCupom();
                      }}
                    >
                      <div className="flex items-end gap-2">
                        <Input
                          label="Cupom de desconto"
                          id="carrinho-cupom"
                          value={codigoDigitado}
                          onChange={(e) => {
                            setCodigoDigitado(e.target.value);
                            setAvisoCupom(null);
                          }}
                          placeholder="Digite o código"
                          autoComplete="off"
                          className="flex-1"
                        />
                        <Button type="submit" variant="secondary" className="shrink-0" disabled={aplicandoCupom}>
                          {aplicandoCupom ? 'Conferindo…' : 'Aplicar'}
                        </Button>
                      </div>
                      {avisoCupom && (
                        <p
                          role="status"
                          className={cn('mt-2 text-small', avisoCupom.ok ? 'text-ink-soft' : 'text-danger')}
                        >
                          {avisoCupom.texto}
                        </p>
                      )}
                    </form>
                  )}
                </div>

                {/* Frete por CEP */}
                <div className="mt-6 border-t border-border pt-6">
                  <Input
                    label="Calcular frete e prazo"
                    id="carrinho-cep"
                    value={cepInput}
                    onChange={(e) => aoDigitarCep(e.target.value)}
                    placeholder="00000-000"
                    inputMode="numeric"
                    autoComplete="postal-code"
                    hint={cotacoes.length === 0 ? 'Digite seu CEP para ver as opções de entrega.' : undefined}
                  />

                  {cotacoes.length > 0 && (
                    <fieldset className="mt-4">
                      <legend className="sr-only">Opções de entrega</legend>
                      <div className="flex flex-col gap-2">
                        {cotacoes.map((quote) => {
                          const selecionada = quote.id === shippingQuoteId;
                          return (
                            <label
                              key={quote.id}
                              className={cn(
                                'flex cursor-pointer items-center gap-3 rounded-sm border px-4 py-3 transition-colors duration-[180ms]',
                                selecionada
                                  ? 'border-primary bg-primary-wash'
                                  : 'border-border hover:border-primary/50',
                              )}
                            >
                              <input
                                type="radio"
                                name="frete"
                                value={quote.id}
                                checked={selecionada}
                                onChange={() => setShippingQuote(quote.id)}
                                className="size-4 accent-[#8c7325]"
                              />
                              <span className="flex min-w-0 flex-1 flex-col">
                                <span className="text-small font-medium text-ink">{quote.label}</span>
                                <span className="text-[0.6875rem] font-light text-ink-soft">
                                  {quote.kind === 'retirada'
                                    ? `${quote.storeLabel} · pronta em ~${quote.readyInHours}h`
                                    : quote.etaDays
                                      ? `${quote.etaDays.min}–${quote.etaDays.max} dias úteis`
                                      : ''}
                                </span>
                              </span>
                              <span className="tabular shrink-0 text-small font-medium text-ink">
                                {quote.price === 0 ? 'Grátis' : formatPrice(quote.price)}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>
                  )}
                </div>

                {/* Total — verde SÓ aqui, a convenção de dinheiro da marca. */}
                <div className="mt-6 border-t border-border pt-6">
                  <div className="flex items-baseline justify-between">
                    <p className="font-medium text-ink">Total</p>
                    <p className="tabular font-display text-[1.75rem] leading-none font-medium text-success">
                      {formatPrice(total)}
                    </p>
                  </div>
                  <p className="mt-2.5 text-right text-small font-light text-ink-soft">
                    ou <span className="tabular font-medium">{formatPrice(totalPix)}</span> no Pix ·{' '}
                    <span className="tabular">até 12x de {formatPrice(parcela12)} sem juros</span>
                  </p>
                </div>

                {estoqueImpedeCheckout ? (
                  <div className="mt-6" role="alert">
                    <Button block size="lg" disabled>
                      Revise a sacola
                    </Button>
                    <p className="mt-2 text-center text-small text-danger">
                      Corrija as peças marcadas acima para continuar.
                    </p>
                  </div>
                ) : (
                  <Button block size="lg" href="/checkout" className="mt-6">
                    Finalizar compra
                  </Button>
                )}
                {/* Cadeado ANTES de ela entrar no checkout (dono, 12/08): a
                    dúvida sobre o cartão nasce aqui, não lá dentro. */}
                <SeloPagamentoSeguro compacto className="mt-3" />
                <Button block variant="ghost" href="/novidades" className="mt-3">
                  Continuar comprando
                </Button>
              </div>
            </aside>
          )}
        </div>
      )}

    </Container>

    {/*
      RECOMENDAÇÃO NO CARRINHO (12/08/2026, decisão do dono).

      Os dois blocos vieram da página do produto. Aqui eles trabalham melhor:
      é a tela onde a cliente decide fechar ou voltar pra vitrine, e onde
      "levo mais uma pra bater o frete grátis" acontece de verdade. No
      checkout NÃO entram — distração na hora de pagar derruba conversão.

      "Complete seu look" olha a SACOLA INTEIRA (`seeds`), não a primeira
      peça: quem tem calça e blusa no carrinho não precisa de mais uma blusa.
      Antes daqui havia um bloco caseiro que chamava `/relacionados` — ou
      seja, mostrava MAIS DO MESMO com o título "Complete seu look".

      Cada rail some sozinho quando não há o que mostrar; por isso a sacola
      vazia não fica com seção fantasma, e "Vistos por você" continua valendo
      (é o convite pra retomar de onde ela parou).
    */}
    {/* A barra de progresso lá em cima dizia o quanto FALTAVA pro frete grátis
        e parava aí — uma conta pra cliente resolver sozinha num catálogo de
        milhares de peças. Esta prateleira mostra as que fecham a conta. */}
    <CompletarFreteGratis subtotal={subtotal} />

    {pecasDaSacola.length > 0 && (
      <RecommendationRail
        kind="complete-seu-look"
        seeds={pecasDaSacola}
        eyebrow="Estilo completo"
        title="Complete seu look"
        description="Peças que fecham a produção com o que já está na sua sacola — escolhidas pela curadoria, não pelo acaso."
      />
    )}
    <RecommendationRail
      kind="ultimos-vistos"
      seeds={pecasDaSacola}
      eyebrow="Sua navegação"
      title="Vistos por você"
      tone="alt"
    />
    </>
  );
}
