'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { Plus, ShoppingBag, Ticket, X } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { AppLink } from '@/components/ui/AppLink';
import { hexDaCor, rotuloDaCor, type CorApi } from '@/services/products';
import { EmptyState } from '@/components/feedback/EmptyState';
import { CartLineRow } from '@/components/commerce/CartLineRow';
import { useCartStore } from '@/store/cart';
import { useLookOfferStore } from '@/store/look-offer';
import { useQuickAddStore } from '@/store/quick-add';
import { useIsCartOpen, useUiStore } from '@/store/ui';
import { useMounted } from '@/hooks';
import { applyCoupon } from '@/lib/commerce/cupom';
import { ProgressoFreteGratis } from '@/components/commerce/ProgressoFreteGratis';
import {
  toTrackedItem,
  trackCouponApplied,
  trackCouponRemoved,
  trackViewCart,
} from '@/lib/tracking';
import { cn, formatPrice } from '@/lib/utils';
import type { CartLine } from '@/types';
import type { PublicPromotionConfig } from '@/types/promotion';
import { previewBuyFourPayThree } from '@/lib/commerce/buy-four-pay-three';
import { PromotionProgress } from '@/components/commerce/PromotionProgress';

/**
 * MINI-CART — o drawer da sacola. Abre pelo ícone do header e sozinho ao
 * adicionar uma peça (a cliente VÊ a peça entrar, sem sair da página — o
 * porquê está em docs/mini-cart.md).
 *
 * Montado uma vez no layout (public) e controlado 100% pelo uiStore: nenhuma
 * página precisa saber que ele existe. Segue o padrão do repo de overlay
 * sempre montado (prop `open` + inert) — nada de AnimatePresence.
 */

/**
 * OUTRAS CORES DA PEÇA QUE ACABOU DE ENTRAR (dono, 20/08: "sugira outra cor
 * da referência escolhida nesta tela").
 *
 * Olha a ÚLTIMA linha da sacola (a que acabou de ser adicionada — é ela que
 * está fresca na cabeça da cliente), busca a ficha da peça no mesmo BFF da
 * PDP e mostra até 4 outras cores COM estoque, tirando as que já estão na
 * sacola. Clicar leva pra PDP já ancorada naquela cor (`?cor=`).
 *
 * Sem foto própria a cor mostra o swatch chapado — nunca a foto de outra cor
 * (a armadilha da "foto ilustrativa" sem aviso). Falhou a busca? O bloco
 * simplesmente não aparece: sugestão é bônus, nunca pode quebrar a sacola.
 */
function OutrasCoresDaRef({ lines, onNavegar }: { lines: CartLine[]; onNavegar: () => void }) {
  const ultima = lines[lines.length - 1];
  const slug = ultima?.slug ?? null;
  const [cores, setCores] = useState<CorApi[] | null>(null);

  useEffect(() => {
    if (!slug) {
      setCores(null);
      return;
    }
    let vivo = true;
    fetch(`/api/loja/produto/${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((peca) => {
        if (vivo) setCores(Array.isArray(peca?.cores) ? peca.cores : null);
      })
      .catch(() => vivo && setCores(null));
    return () => {
      vivo = false;
    };
  }, [slug]);

  if (!ultima || !slug || !cores) return null;

  // Não oferecer o que ela já levou: cores desta MESMA peça já na sacola.
  const naSacola = new Set(
    lines.filter((l) => l.slug === slug).map((l) => (l.color ?? '').toUpperCase()),
  );
  const outras = cores
    .filter((c) => c.estoque > 0 && !naSacola.has(c.nome.toUpperCase()))
    .slice(0, 4);
  if (outras.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-surface-alt/50 p-4">
      <p className="eyebrow text-ink">Esta peça também tem estas cores</p>
      <div className="mt-3 grid grid-cols-4 gap-2">
        {outras.map((c) => {
          const foto = c.fotos[0]?.src ?? c.swatch.imagem;
          return (
            <AppLink
              key={c.nome}
              href={`/produto/${slug}?cor=${encodeURIComponent(c.nome)}`}
              onClick={onNavegar}
              className="group min-w-0"
            >
              <span className="relative block aspect-3/4 overflow-hidden rounded-sm bg-surface-alt">
                {foto ? (
                  <Image
                    src={foto}
                    alt={`${ultima.name} na cor ${rotuloDaCor(c)}`}
                    fill
                    sizes="96px"
                    className="object-cover transition-transform duration-[320ms] group-hover:scale-[1.03]"
                  />
                ) : (
                  <span
                    aria-hidden
                    className="absolute inset-0"
                    style={{ background: c.swatch.hex ?? hexDaCor(c.nome) }}
                  />
                )}
              </span>
              <span className="mt-1 block truncate text-center text-[0.6875rem] leading-tight text-ink-soft group-hover:text-ink">
                {rotuloDaCor(c)}
              </span>
            </AppLink>
          );
        })}
      </div>
    </div>
  );
}

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

  /**
   * A IRMÃ DO LOOK — a peça que sai na MESMA foto da que acabou de entrar.
   *
   * A BuyBox registra o look no momento do adicionar; aqui ela vira um card
   * de oferta. O toque abre o QUICK ADD (Modal, z 70) por cima deste drawer
   * (z 60): a cliente escolhe o tamanho na janelinha e a calça cai na sacola
   * sem sair de onde está — era o buraco do fluxo (dono, 20/08: "ela compra
   * o kimono, sai da página e não volta mais"). Quem já está na sacola some
   * da oferta na hora, pela própria reatividade das lines.
   */
  const irmasDoLook = useLookOfferStore((s) => s.irmas);
  const corDoLook = useLookOfferStore((s) => s.corEscolhida);
  const abrirQuickAdd = useQuickAddStore((s) => s.abrir);

  // Antes da hidratação o localStorage ainda não falou — renderiza vazio dos
  // dois lados (server e client) pra não divergir o HTML.
  const lines = mounted ? rawLines : [];
  // Irmã que a cliente já levou sai da oferta — oferecer o que já está na
  // sacola soaria como insistência de vendedor.
  const ofertasDoLook = irmasDoLook
    .filter((irma) => !lines.some((l) => String(l.productId) === irma.ref || l.slug === irma.slug))
    /**
     * A IRMÃ NA COR DO LOOK (21/08). O look é a MESMA foto: quem levou o
     * kimono ESTAMPA AZUL quer a calça ESTAMPA AZUL. O backend manda a REF
     * crua (a curadoria não cadastra cor), e a foto que vinha era sempre a
     * da primeira cor — dava pra levar a BEGE junto da AZUL sem perceber.
     *
     * Aqui a cor escolhida na peça anterior manda: se a irmã tem essa cor
     * vendável, a oferta usa a FOTO dela e a janelinha abre já nela. Irmã
     * sem essa cor (look de peças que não compartilham cor) fica exatamente
     * como estava.
     */
    .map((irma) => {
      const casada = corDoLook
        ? (irma.cores ?? []).find((c) => c.nome === corDoLook)
        : undefined;
      return casada
        ? { ...irma, imagem: casada.imagem ?? irma.imagem, corDoLook: casada.nome }
        : { ...irma, corDoLook: null as string | null };
    });
  const count = lines.reduce((sum, l) => sum + l.quantity, 0);
  const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const [promotion, setPromotion] = useState<PublicPromotionConfig | null>(null);
  useEffect(() => {
    let active = true;
    fetch('/api/promotion')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => active && setPromotion(data))
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  const promotionPreview = useMemo(
    () => previewBuyFourPayThree(lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
    }))),
    [lines],
  );
  const promotionActive = Boolean(promotion?.enabled && promotion.mode === 'buy_4_pay_3');
  const promotionApplied = promotionActive && promotionPreview.applied;

  /* ----------------------------------------------------------------- cupom */
  const [codigoDigitado, setCodigoDigitado] = useState('');
  const [avisoCupom, setAvisoCupom] = useState<{ ok: boolean; texto: string } | null>(null);

  // O cupom persistido é REVALIDADO a cada render: se o subtotal caiu abaixo
  // do mínimo, o desconto some na hora — nunca mostramos um desconto morto.
  const cupomAplicado = useMemo(
    () => (couponCode ? applyCoupon(couponCode, subtotal) : null),
    [couponCode, subtotal],
  );
  const descontoCupom = promotionApplied ? 0 : cupomAplicado?.ok ? cupomAplicado.discount : 0;
  const descontoPromocao = promotionApplied ? promotionPreview.discountValue : 0;

  useEffect(() => {
    if (!promotionApplied || !couponCode) return;
    trackCouponRemoved(couponCode);
    setCoupon(null);
    setAvisoCupom({ ok: true, texto: 'Cupom removido: esta promoção não acumula com outros descontos.' });
  }, [promotionApplied, couponCode, setCoupon]);

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
  /**
   * O DRAWER NÃO SOMA MAIS FRETE NENHUM (17/08).
   *
   * Ele usava `findQuote`, que lê a tabela LOCAL congelada — a mesma que
   * dizia SEDEX R$ 28,90 onde o checkout cobra R$ 9,99. A sacola e o
   * checkout passaram a usar a cotação de verdade; deixar o drawer na
   * tabela velha criaria um TERCEIRO total na mesma sessão.
   *
   * Cotar aqui exigiria rede a cada abertura do drawer, pra mostrar um
   * número que a cliente vai reconferir na sacola de qualquer jeito. Então
   * o drawer passa a mostrar o subtotal e dizer que o frete vem depois —
   * um total honesto e incompleto vale mais que um total errado.
   */
  const precoFrete: number | undefined = undefined;

  const total = Math.max(0, subtotal - descontoCupom - descontoPromocao) + (precoFrete ?? 0);

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
            {/* BOTÃO DE VERDADE (dono, 20/08: "destaque o Continuar
                comprando"). Era um link cinza de rodapé — quem adicionou uma
                peça e quer seguir olhando a loja não achava a saída, e fechar
                no X parece cancelar. Vira botão do mesmo tamanho dos outros. */}
            <Button block variant="secondary" onClick={closeOverlay}>
              Continuar comprando
            </Button>
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
          {/* Barra do frete grátis — mesma peça usada na página da sacola. */}
          <ProgressoFreteGratis subtotal={subtotal} />
          {promotionActive && <PromotionProgress preview={promotionPreview} />}

          {/* Linhas */}
          <ul className="flex flex-col divide-y divide-border">
            {lines.map((line) => (
              <li key={line.id} className="py-5 first:pt-0 last:pb-0">
                <CartLineRow line={line} />
              </li>
            ))}
          </ul>

          {/* Sai na mesma foto — a irmã do look, a um toque de tamanho. */}
          {ofertasDoLook.length > 0 && (
            <div className="flex flex-col gap-3 border-t border-border pt-5">
              <p className="eyebrow text-primary-strong">Sai na mesma foto</p>
              {ofertasDoLook.map((irma) => (
                <div
                  key={irma.ref}
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface-alt p-3"
                >
                  <div className="relative aspect-[3/4] w-16 shrink-0 overflow-hidden rounded-sm bg-surface">
                    {irma.imagem && (
                      <Image
                        src={irma.imagem}
                        alt={irma.nome}
                        fill
                        sizes="64px"
                        className="object-cover"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-small text-ink">{irma.nome}</p>
                    <p className="mt-0.5 text-small font-medium tabular text-ink">
                      {formatPrice(irma.preco)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      // O Quick Add busca a grade real por slug ao abrir —
                      // este objeto mínimo só precisa apresentar a peça.
                      abrirQuickAdd({
                        id: irma.ref,
                        slug: irma.slug,
                        name: irma.nome,
                        category: '',
                        price: irma.preco,
                        pixPrice: irma.precoPix ?? undefined,
                        images: irma.imagem ? [{ src: irma.imagem, alt: irma.nome }] : [],
                        sizes: [],
                        /**
                         * A cor do look já marcada — o Quick Add só a adota se
                         * a irmã tiver essa cor COM estoque (a guarda é dele).
                         * Sem isto a janelinha abria pedindo "escolha a cor pra
                         * ver os tamanhos": um passo a mais, no escuro, com
                         * risco de levar a cor que não combina.
                         */
                        ...(irma.corDoLook
                          ? { vitrineCor: { nome: irma.corDoLook, rotulo: irma.corDoLook } }
                          : {}),
                      })
                    }
                  >
                    <Plus className="mr-1 size-3.5" strokeWidth={2} /> Levar junto
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* A VENDA CASADA NA SACOLA (dono, 20/08: "sugira outra cor da
              referência escolhida nesta tela") — as outras cores da peça que
              acabou de entrar, com foto. É a vendedora do balcão: "esse
              modelo também veio no preto, quer ver?" */}
          <OutrasCoresDaRef lines={lines} onNavegar={closeOverlay} />

          {/* Cupom compacto */}
          <div className="border-t border-border pt-5">
            {promotionApplied ? (
              <p className="text-small text-ink-soft">
                Cupom indisponível: a peça de menor valor já será grátis.
              </p>
            ) : couponCode && cupomAplicado ? (
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
            {descontoCupom > 0 && (
              <div className="flex justify-between">
                <dt className="font-light text-ink-soft">Desconto ({couponCode})</dt>
                <dd className="tabular text-ink">−{formatPrice(descontoCupom)}</dd>
              </div>
            )}
            {descontoPromocao > 0 && (
              <div className="flex justify-between text-success">
                <dt className="font-medium">Peça grátis — Leve 4, Pague 3</dt>
                <dd className="tabular">−{formatPrice(descontoPromocao)}</dd>
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
