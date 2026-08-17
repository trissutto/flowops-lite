'use client';

import type { Ref } from 'react';
import Link from 'next/link';
import { LoaderCircle, Lock, MessageCircle, RefreshCw, ShoppingBag, Ticket, Truck } from 'lucide-react';
import { formatPrice } from '@/lib/utils';
import { PIX_DESCONTO_PCT } from '@/lib/commerce/pix';
import { Button } from '@/components/ui/Button';
import { SeloPagamentoSeguro } from '@/components/commerce/SeloPagamentoSeguro';
import { stores } from '@/data/stores';
import type { CartLine } from '@/types';
import type { CheckoutErrorCode, CouponResult, CustomerIdentity } from '@/types/checkout';
import { linkWhatsapp } from '@/data/contato';
import type { PaymentSelection } from './PaymentStep';
import type { ShippingSelection } from './ShippingStep';
import { maskCpf } from './masks';

/**
 * § 4 — REVISÃO. A última chance de conferir tudo antes do dinheiro sair.
 * Nada aqui é editável: cada bloco só espelha a seção correspondente (quem
 * quer mudar clica em "editar" na seção). Repetir formulário aqui dobraria a
 * chance de inconsistência.
 *
 * O botão FINALIZAR é o ÚNICO verde da página — a convenção da marca reserva
 * o verde pra dinheiro, e ele é literalmente o momento do dinheiro.
 *
 * O AVISO DE ERRO VEM PRIMEIRO (17/08). Desde que a etapa de revisão virou o
 * painel que só aparece depois de uma falha, este card entra logo ABAIXO do
 * botão que a cliente acabou de apertar (Gerar PIX / Pagar com cartão). O
 * `role="alert"` ficava no rodapé, depois de peças, endereço, pagamento e
 * totais — uns 500-600px abaixo do botão no celular, fora da tela. Ela via o
 * formulário intacto, concluía que "não aconteceu nada" e tocava de novo (é
 * o "tentou 4, 5, 6 vezes o mesmo pedido" medido no painel). No topo, o
 * aviso nasce a ~24px do botão; a página ainda rola/foca por `alertRef`.
 */

interface ReviewCardProps {
  customer: CustomerIdentity;
  shipping: ShippingSelection;
  payment: PaymentSelection;
  lines: CartLine[];
  subtotal: number;
  shippingPrice: number;
  coupon: CouponResult | null;
  /** Desconto do Pix em reais — 0 nos outros meios. */
  pixDiscount?: number;
  total: number;
  submitting: boolean;
  /** Mensagem elegante quando o POST falhou — nunca status/stack técnico. */
  error: string | null;
  failureCount: number;
  errorCode: CheckoutErrorCode | null;
  onSubmit: () => void;
  /**
   * Cartão recusado NÃO reenvia daqui. O token da Pagar.me é de uso único e
   * curto: mandar o mesmo de novo é recusa garantida — e a cliente acharia
   * que o cartão dela não presta. O reenvio de cartão é pelo formulário
   * acima (novo token). Este painel fica só com o aviso e as saídas.
   */
  reenvioNoFormulario?: boolean;
  onEditIdentity: () => void;
  onReviewData: () => void;
  onUsePix: () => void;
  /**
   * SAÍDAS POR CÓDIGO, JÁ NA 1ª FALHA. "Revise a sacola" sem botão pra
   * sacola, "remova o cupom" sem botão de remover e "escolha o frete de novo"
   * sem link pra entrega eram becos sem saída — os botões genéricos só
   * apareciam da 2ª falha em diante. Opcionais: sem callback, o CTA não sai.
   */
  onRemoveCoupon?: () => void;
  onEditShipping?: () => void;
  /** Container do aviso — a página rola/foca nele quando o erro muda. */
  alertRef?: Ref<HTMLDivElement>;
}

const METODO_LABEL: Record<PaymentSelection['method'], string> = {
  pix: 'PIX à vista',
  card: 'Cartão de crédito',
};

export function ReviewCard({
  customer,
  shipping,
  payment,
  lines,
  subtotal,
  shippingPrice,
  coupon,
  pixDiscount = 0,
  total,
  submitting,
  error,
  failureCount,
  errorCode,
  onSubmit,
  reenvioNoFormulario = false,
  onEditIdentity,
  onReviewData,
  onUsePix,
  onRemoveCoupon,
  onEditShipping,
  alertRef,
}: ReviewCardProps) {
  const retirada = shipping.quote.kind === 'retirada';
  const store = retirada ? stores.find((s) => s.slug === shipping.quote.storeSlug) : undefined;
  const pecas = lines.reduce((sum, l) => sum + l.quantity, 0);

  const ctaClasses =
    'inline-flex min-h-10 items-center gap-2 rounded-pill border border-secondary px-4 py-2 font-medium text-secondary transition-colors hover:bg-secondary-wash';
  // `shipping_changed` nasce no BFF (frete subiu entre a tela e o pedido) e
  // ainda não está no tipo `CheckoutErrorCode`; comparar como string até lá.
  const codigo: string | null = errorCode;
  const ctaEntrega = (codigo === 'shipping_invalid' || codigo === 'shipping_changed') && !!onEditShipping;

  return (
    <div className="flex flex-col gap-6">
      {/* O AVISO PRIMEIRO — ver o cabeçalho do arquivo. tabIndex=-1 pra a
          página conseguir focar o bloco (leitor de tela lê, teclado não para
          nele no Tab). */}
      {error && (
        <div
          ref={alertRef}
          tabIndex={-1}
          role="alert"
          className="rounded-sm bg-secondary-wash px-4 py-3 text-small text-secondary outline-none focus-visible:ring-2 focus-visible:ring-secondary/40"
        >
          <p>{error}</p>

          {/* A saída específica do código, desde a PRIMEIRA falha. */}
          {(codigo === 'catalog_unavailable' || (codigo === 'coupon_invalid' && onRemoveCoupon) || ctaEntrega) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {codigo === 'catalog_unavailable' && (
                <Link href="/carrinho" className={ctaClasses}>
                  <ShoppingBag className="size-4" /> Ajustar sacola
                </Link>
              )}
              {codigo === 'coupon_invalid' && onRemoveCoupon && (
                <button type="button" onClick={onRemoveCoupon} className={ctaClasses}>
                  <Ticket className="size-4" /> Remover cupom
                </button>
              )}
              {ctaEntrega && (
                <button type="button" onClick={onEditShipping} className={ctaClasses}>
                  <Truck className="size-4" /> Escolher entrega
                </button>
              )}
            </div>
          )}

          {failureCount >= 2 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {payment.method === 'card' && (
                <Button type="button" size="sm" variant="secondary" onClick={onUsePix}>
                  Tentar com Pix
                </Button>
              )}
              <Button type="button" size="sm" variant="secondary" onClick={onReviewData}>
                <RefreshCw /> Revisar dados
              </Button>
              <a
                href={linkWhatsapp(`Olá! Vim pelo site e não consegui finalizar minha compra. Código: ${errorCode ?? 'checkout'}.`)}
                target="_blank"
                rel="noopener noreferrer"
                className={ctaClasses}
              >
                <MessageCircle className="size-4" /> Chamar atendimento
              </a>
            </div>
          )}
        </div>
      )}

      {/* Cartão recusado: o reenvio é pelo formulário ACIMA (token novo). O
          aviso fica colado no alerta, não no rodapé — é a instrução do que
          fazer agora. */}
      {reenvioNoFormulario && (
        <p className="rounded-sm border border-border bg-surface px-4 py-3 text-center text-small text-ink-soft">
          Confira os dados do cartão acima e clique em <strong>Pagar com cartão</strong> de novo — ou pague com PIX.
        </p>
      )}

      {/* Itens — versão ultra compacta (o resumo lateral tem as fotos). */}
      <div>
        <h3 className="eyebrow mb-3 text-ink-soft">Suas peças ({pecas})</h3>
        <ul className="flex flex-col gap-1.5">
          {lines.map((line) => (
            <li key={line.id} className="flex justify-between gap-4 text-small text-ink-soft">
              <span className="truncate">
                {line.quantity}× {line.name} · Tam {line.size}
                {line.color ? ` · ${line.color}` : ''}
              </span>
              <span className="tabular shrink-0">{formatPrice(line.unitPrice * line.quantity)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="eyebrow text-ink-soft">Quem recebe</h3>
            <button type="button" onClick={onEditIdentity} className="text-caption text-secondary underline underline-offset-2">
              alterar dados
            </button>
          </div>
          <p className="text-small text-ink">{customer.name}</p>
          <p className="text-small text-ink-muted">{customer.email}</p>
          <p className="text-small text-ink-muted">CPF {maskCpf(customer.cpf)}</p>
        </div>
        <div>
          <h3 className="eyebrow mb-2 text-ink-soft">{retirada ? 'Retirada' : 'Entrega'}</h3>
          {retirada && store ? (
            <>
              <p className="text-small text-ink">Loja {store.unit}</p>
              <p className="text-small text-ink-muted">
                {store.address.street} · {store.address.neighborhood}, {store.city}/{store.uf}
              </p>
            </>
          ) : shipping.address ? (
            <>
              <p className="text-small text-ink">
                {shipping.address.street}, {shipping.address.number}
                {shipping.address.complement ? ` · ${shipping.address.complement}` : ''}
              </p>
              <p className="text-small text-ink-muted">
                {shipping.address.neighborhood} · {shipping.address.city}/{shipping.address.uf}
              </p>
            </>
          ) : null}
          <p className="mt-1 text-small text-ink-muted">
            {shipping.quote.label}
            {shippingPrice === 0 ? ' · grátis' : ` · ${formatPrice(shippingPrice)}`}
          </p>
        </div>
      </div>

      <div>
        <h3 className="eyebrow mb-2 text-ink-soft">Pagamento</h3>
        <p className="text-small text-ink">
          {METODO_LABEL[payment.method]}
          {payment.method === 'card' && payment.installments
            ? payment.installments === 1
              ? ' · à vista'
              : ` · ${payment.installments}x de ${formatPrice(total / payment.installments)} sem juros`
            : ''}
        </p>
      </div>

      {/* Totais — espelho do resumo lateral (mobile não tem a coluna à vista). */}
      <dl className="flex flex-col gap-1.5 border-t border-border pt-4 text-small text-ink-soft">
        <div className="flex justify-between">
          <dt>Subtotal</dt>
          <dd className="tabular">{formatPrice(subtotal)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Frete</dt>
          <dd className="tabular">{shippingPrice === 0 ? 'Grátis' : formatPrice(shippingPrice)}</dd>
        </div>
        {coupon?.ok && coupon.discount > 0 && (
          <div className="flex justify-between text-success">
            <dt>Cupom {coupon.code}</dt>
            <dd className="tabular">−{formatPrice(coupon.discount)}</dd>
          </div>
        )}
        {pixDiscount > 0 && (
          <div className="flex justify-between text-success">
            <dt>Desconto Pix ({PIX_DESCONTO_PCT}%)</dt>
            <dd className="tabular">−{formatPrice(pixDiscount)}</dd>
          </div>
        )}
        <div className="flex items-baseline justify-between pt-2">
          <dt className="font-display text-h4 text-ink">Total</dt>
          <dd className="tabular text-h4 font-medium text-success">{formatPrice(total)}</dd>
        </div>
      </dl>

      {/* Reenvio de PIX (o cartão reenvia pelo formulário, ver acima). */}
      {!reenvioNoFormulario && (
        <>
          {/* Verde = dinheiro. A variante whatsapp é o verde oficial (#2e7d46). */}
          <Button
            type="button"
            variant="whatsapp"
            size="lg"
            block
            disabled={submitting}
            onClick={onSubmit}
          >
            {submitting ? (
              <>
                <LoaderCircle className="animate-spin" /> Enviando pedido…
              </>
            ) : (
              <>
                <Lock /> Finalizar compra
              </>
            )}
          </Button>

          {/* O cadeado logo abaixo do botão (dono, 12/08): é o instante exato da
              hesitação, e o rodapé fica longe demais pra servir aqui. */}
          <SeloPagamentoSeguro compacto />

          <p className="text-center text-caption font-normal tracking-normal normal-case text-ink-muted">
            Ao finalizar, você concorda com os{' '}
            <Link href="/termos" className="underline underline-offset-2">
              termos de compra
            </Link>
            . Seus dados ficam protegidos.
          </p>
        </>
      )}
    </div>
  );
}
