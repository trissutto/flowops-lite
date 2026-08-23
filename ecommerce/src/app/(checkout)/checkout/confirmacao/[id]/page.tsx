'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  CircleCheck,
  CircleX,
  Clock,
  FileText,
  MapPin,
  PackageSearch,
  TimerReset,
  Truck,
} from 'lucide-react';
import { cn, formatPrice } from '@/lib/utils';
import { Container } from '@/components/layout/Container';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ProductCardSkeleton, Skeleton } from '@/components/ui/Skeleton';
import { ProductCard } from '@/components/cards/ProductCard';
import { CriarContaDepoisDaCompra } from '@/components/conta/CriarContaDepoisDaCompra';
import { RastreioDoPedido } from '@/components/commerce/RastreioDoPedido';
import { WhatsAppIcon } from '@/components/ui/icons';
import { stores } from '@/data/stores';
import { mapPecasDaVitrine } from '@/services/products';
import { maskCpf } from '@/components/checkout/masks';
import { PixPanel } from '@/components/checkout/PixPanel';
import type { Product } from '@/types';
import type { Order } from '@/types/checkout';
import { WHATSAPP_ATENDIMENTO } from '@/data/contato';

/**
 * THANK YOU PAGE — a confirmação do pedido. E, desde 17/08, também a PÁGINA
 * DO PIX: o pedido aguardando pagamento chega aqui logo depois de criado
 * (`router.replace` no checkout) e o `<PixPanel>` é desenhado com o QR e o
 * copia-e-cola que o `GET /api/checkout/:id` devolve. A URL é o estado — F5,
 * "voltar", aba descartada ao trocar pro app do banco, link colado: tudo
 * volta pro mesmo código. Antes o PIX vivia só na memória da aba do checkout
 * e qualquer recarga virava "Sua sacola está vazia" com o QR perdido.
 *
 * ⚠️ GUARDA DE RECARGA: esta página NÃO dispara NENHUM evento de compra.
 * `purchase` é exclusivo do SERVIDOR (webhook de pagamento, dedupe por
 * transaction_id — ver docs/purchase.md). Uma thank you que dispara purchase
 * no client conta a mesma venda a cada F5 e infla o ROAS — o bug clássico de
 * e-commerce. Aqui é só leitura: GET /api/checkout/:id e exibição.
 *
 * O que é PLACEHOLDER honesto (sem inventar recurso que não existe):
 *   - rastreamento: o código chega pelo WhatsApp; e-mail é canal SECUNDÁRIO
 *     (depende de `PEDIDO_EMAIL_PROPRIO` — em produção está LIGADO, mas o
 *     default do código é desligado, então a página não pode DEPENDER dele
 *     nem afirmar que ele não existe — ver memória
 *     envs-producao-nao-sao-os-defaults)
 *   - nota fiscal: emitida no faturamento; pedir pelo WhatsApp
 * A página não promete "o código está no seu e-mail" como única via: até
 * 17/08 dizia isso e, quando o e-mail não saía, a cliente ficava sem o PIX.
 * O QR/copia-e-cola agora é desenhado AQUI. Ver docs/order-confirmation.md.
 */

/**
 * WhatsApp do atendimento do site — por ora o número da unidade Anália
 * Franco; trocar quando o canal dedicado do e-commerce existir.
 */


type Estado =
  | { fase: 'carregando' }
  | { fase: 'nao-encontrado' }
  | { fase: 'ok'; order: Order };

export default function ConfirmacaoPage() {
  const params = useParams<{ id: string }>();
  const [estado, setEstado] = useState<Estado>({ fase: 'carregando' });

  /**
   * Busca o pedido. Reutilizada pelo PixPanel (`onPaid`/`onExpired`): quando
   * o poll vê o status mudar, recarregamos o pedido em vez de navegar pra
   * esta mesma URL — `router.push` pra rota atual não refaz este efeito.
   * `silencioso` = recarga com o pedido já na tela: falha não derruba nada.
   */
  const carregar = useCallback(
    (silencioso = false) => {
      const id = params?.id;
      if (!id) return () => undefined;
      let ativo = true;
      fetch(`/api/checkout/${id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { ok: boolean; order?: Order } | null) => {
          if (!ativo) return;
          if (data?.ok && data.order) setEstado({ fase: 'ok', order: data.order });
          // Recarga silenciosa que falhou não derruba o pedido já na tela.
          else if (!silencioso) setEstado({ fase: 'nao-encontrado' });
        })
        .catch(() => {
          if (ativo && !silencioso) setEstado({ fase: 'nao-encontrado' });
        });
      return () => {
        ativo = false;
      };
    },
    [params?.id],
  );

  useEffect(() => carregar(), [carregar]);

  const recarregar = useCallback(() => {
    void carregar(true);
  }, [carregar]);

  if (estado.fase === 'carregando') return <ConfirmacaoSkeleton />;

  if (estado.fase === 'nao-encontrado') {
    return (
      <Container width="page" className="py-10 lg:py-16">
        <EmptyState
          icon={<PackageSearch strokeWidth={1.25} />}
          title="Não encontramos esse pedido"
          description="O link pode estar incompleto ou o pedido ter sido feito há muito tempo. Fale com a gente no WhatsApp com o número do pedido — resolvemos juntas."
          action={{ label: 'Voltar à loja', href: '/' }}
          secondaryAction={{ label: 'Falar no WhatsApp', href: `https://wa.me/${WHATSAPP_ATENDIMENTO}` }}
        />
      </Container>
    );
  }

  const { order } = estado;
  const pago = order.status === 'paid';
  // O backend separa de propósito `cancelled` (cancelado na retaguarda/gateway)
  // de `expired` (PIX venceu). A tela colapsava os dois em "Aguardando
  // pagamento" — cliente esperando por um pedido que já não existia.
  const encerrado = order.status === 'cancelled' || order.status === 'expired';
  const aguardandoPix =
    order.status === 'awaiting_payment' && order.payment.method === 'pix' && !!order.payment.pix;
  const retirada = order.shipping.kind === 'retirada';
  const store = retirada ? stores.find((s) => s.slug === order.shipping.storeSlug) : undefined;
  const mensagemZap = encodeURIComponent(`Oi! Acabei de fazer o pedido ${order.number}`);

  return (
    <Container width="page" className="py-10 lg:py-16">
      {/* Cabeçalho — o número do pedido é a informação que ela vai anotar. */}
      <header className="mx-auto max-w-narrow text-center">
        <span
          className={cn(
            'inline-flex items-center gap-2 rounded-pill px-4 py-1.5 text-small font-medium',
            pago
              ? 'bg-accent-wash text-success'
              : encerrado
                ? 'bg-surface-alt text-ink-soft'
                : 'bg-primary-wash text-primary-strong',
          )}
        >
          {pago ? (
            <CircleCheck className="size-4" />
          ) : order.status === 'expired' ? (
            <TimerReset className="size-4" />
          ) : order.status === 'cancelled' ? (
            <CircleX className="size-4" />
          ) : (
            <Clock className="size-4" />
          )}
          {statusBadge(order)}
        </span>
        <h1 className="mt-5 font-display text-h1 text-ink">
          Pedido <em className="tabular italic">{order.number}</em>
        </h1>
        <p className="mt-3 text-body-lg font-light text-ink-soft">
          {pago
            ? `Obrigada, ${primeiroNome(order.customer.name)}! Já estamos separando suas peças com todo o carinho.`
            : encerrado
              ? `Nada foi cobrado, ${primeiroNome(order.customer.name)}. As peças voltaram pra loja — é só montar a sacola de novo, leva um minutinho.`
              : aguardandoPix
                ? `Quase lá, ${primeiroNome(order.customer.name)}! Pague o PIX abaixo e a confirmação aparece aqui sozinha.`
                : `Quase lá, ${primeiroNome(order.customer.name)}! Assim que o pagamento for confirmado, começamos a separar suas peças.`}
        </p>
        {encerrado && (
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button href="/novidades" size="md">
              Refazer minha sacola
            </Button>
            <Button href={`https://wa.me/${WHATSAPP_ATENDIMENTO}?text=${mensagemZap}`} external variant="secondary" size="md">
              Falar no WhatsApp
            </Button>
          </div>
        )}
      </header>

      {/* O PIX MORA AQUI. O painel polla o status e, ao pagar/expirar, pede
          pra recarregar o pedido — a página então troca sozinha pro cabeçalho
          de "Pagamento confirmado" (ou "PIX expirado"). */}
      {aguardandoPix && (
        <section aria-label="Pagamento por PIX" className="mx-auto mt-10 max-w-narrow">
          <PixPanel order={order} embutido onPaid={recarregar} onExpired={recarregar} />
        </section>
      )}

      {/* Próximos passos — não fazem sentido num pedido encerrado. */}
      {!encerrado && (
        <section aria-label="Próximos passos" className="mx-auto mt-12 max-w-narrow">
          <ol className="flex flex-col gap-4">
            <PassoItem done label={pagoLabel(order)} />
            <PassoItem
              done={pago}
              label={retirada ? 'Separamos suas peças na loja' : 'Preparamos e despachamos seu pacote'}
            />
            <PassoItem
              done={false}
              label={
                retirada
                  ? `Você retira na loja ${store?.unit ?? ''} — fica pronto em ~${order.shipping.readyInHours ?? 3}h após a confirmação`
                  : 'Você recebe em casa e arrasa'
              }
            />
          </ol>
        </section>
      )}

      {/* Entrega + resumo */}
      <section className="mx-auto mt-12 grid max-w-text gap-6 sm:grid-cols-2">
        <div className="rounded-md border border-border bg-surface p-6">
          <h2 className="mb-3 flex items-center gap-2 font-display text-h4 text-ink">
            {retirada ? <MapPin className="size-4 text-primary-strong" /> : <Truck className="size-4 text-primary-strong" />}
            {retirada ? 'Retirada na loja' : 'Entrega'}
          </h2>
          {retirada && store ? (
            <>
              <p className="text-body text-ink">Loja {store.unit}</p>
              <p className="mt-1 text-small text-ink-soft">
                {store.address.street}
                <br />
                {store.address.neighborhood} · {store.city}/{store.uf}
              </p>
              <p className="mt-3 text-small text-ink-muted">
                Leve um documento com foto. Horário: {store.hours.display.join(' · ')}
              </p>
            </>
          ) : order.shippingAddress ? (
            <>
              <p className="text-body text-ink">
                {order.shippingAddress.street}, {order.shippingAddress.number}
                {order.shippingAddress.complement ? ` · ${order.shippingAddress.complement}` : ''}
              </p>
              <p className="mt-1 text-small text-ink-soft">
                {order.shippingAddress.neighborhood} · {order.shippingAddress.city}/{order.shippingAddress.uf}
              </p>
              {order.shipping.etaDays && (
                <p className="mt-3 text-small text-ink-muted">
                  {order.shipping.label} · {order.shipping.etaDays.min} a {order.shipping.etaDays.max} dias úteis
                </p>
              )}
            </>
          ) : null}
        </div>

        <div className="rounded-md border border-border bg-surface p-6">
          <h2 className="mb-3 font-display text-h4 text-ink">Resumo</h2>
          <ul className="flex flex-col gap-1.5">
            {order.items.map((item) => (
              <li key={item.id} className="flex justify-between gap-3 text-small text-ink-soft">
                <span className="truncate">
                  {item.quantity}× {item.name} · Tam {item.size}
                </span>
                <span className="tabular shrink-0">{formatPrice(item.unitPrice * item.quantity)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-4 flex flex-col gap-1 border-t border-border pt-3 text-small text-ink-soft">
            <div className="flex justify-between">
              <dt>Frete</dt>
              <dd className="tabular">
                {order.shippingPrice === 0 ? 'Grátis' : formatPrice(order.shippingPrice)}
              </dd>
            </div>
            {order.discount > 0 && (
              <div className="flex justify-between text-success">
                <dt>Desconto{order.couponCode ? ` (${order.couponCode})` : ''}</dt>
                <dd className="tabular">−{formatPrice(order.discount)}</dd>
              </div>
            )}
            <div className="flex items-baseline justify-between pt-1">
              <dt className="font-display text-h4 text-ink">Total</dt>
              <dd className="tabular text-h4 font-medium text-success">{formatPrice(order.total)}</dd>
            </div>
          </dl>
          <p className="mt-3 text-caption font-normal tracking-normal normal-case text-ink-muted">
            CPF do pedido: {maskCpf(order.customer.cpf)}
          </p>
        </div>
      </section>

      {/* O RASTREIO, DENTRO DE CASA (22/08). O card genérico abaixo continua
          valendo enquanto a peça não foi postada; assim que existe código, é
          esta seção que responde "onde está" — sem mandar a cliente pro site
          dos Correios. Pedido dividido vira uma caixa por linha. */}
      {!encerrado && <RastreioDoPedido volumes={order.volumes ?? []} />}

      {/* Acompanhamento + NF — placeholders HONESTOS (nada de link morto, e
          nada de e-mail: o canal que existe e dispara de verdade é o WhatsApp). */}
      {!encerrado && (
        <section className="mx-auto mt-6 grid max-w-text gap-6 sm:grid-cols-2">
          {/* Some quando o rastreio real já está na tela: "você recebe o
              código quando despachar" ao lado do código e do status seria
              contar a mesma história duas vezes, uma delas desatualizada. */}
          {!order.volumes?.length && (
            <div className="rounded-md bg-surface-alt p-6">
              <h2 className="mb-2 flex items-center gap-2 font-display text-h4 text-ink">
                <PackageSearch className="size-4 text-primary-strong" /> Acompanhe seu pedido
              </h2>
              <p className="text-small text-ink-soft">
                {retirada
                  ? 'Avisamos pelo WhatsApp assim que estiver tudo pronto pra retirada.'
                  : 'Você recebe o código de rastreamento pelo WhatsApp assim que o pacote for despachado.'}
              </p>
            </div>
          )}
          <div className="rounded-md bg-surface-alt p-6">
            <h2 className="mb-2 flex items-center gap-2 font-display text-h4 text-ink">
              <FileText className="size-4 text-primary-strong" /> Nota fiscal
            </h2>
            <p className="text-small text-ink-soft">
              A nota fiscal é emitida no faturamento do pedido. Precisa dela? É só pedir pelo WhatsApp
              com o número do pedido.
            </p>
          </div>
        </section>
      )}

      {/* A CONTA, NA ÚNICA HORA EM QUE ELA CUSTA UM CAMPO (22/08).
          O checkout é sem cadastro — e depois de pagar ninguém oferecia nada,
          então quem comprava como visitante nunca virava conta: não acompanha
          entrega, não vê o cashback que já está sendo creditado e não abre
          troca sozinha. Aqui CPF, nome, telefone e e-mail já foram digitados;
          falta a senha. Some pra quem já está logada e pra quem disser não. */}
      <CriarContaDepoisDaCompra />

      {/* WhatsApp — o canal onde a Lurd's realmente atende. */}
      <div className="mt-10 text-center">
        <Button
          variant="whatsapp"
          size="lg"
          href={`https://wa.me/${WHATSAPP_ATENDIMENTO}?text=${mensagemZap}`}
          external
        >
          <WhatsAppIcon /> Falar com a gente no WhatsApp
        </Button>
        <p className="mt-3 text-small text-ink-muted">
          Dúvida no pedido, no prazo ou no tamanho? A gente resolve por lá.
        </p>
      </div>

      <Recomendados />
    </Container>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] ?? '';
}

function statusBadge(order: Order): string {
  switch (order.status) {
    case 'paid':
      return 'Pagamento confirmado';
    case 'expired':
      return 'PIX expirado';
    case 'cancelled':
      return 'Pedido cancelado';
    default:
      return 'Aguardando pagamento';
  }
}

/**
 * Primeiro passo da lista. Não aponta o e-mail como o lugar do código: até
 * 17/08 dizia "o código está no seu e-mail", e quando esse e-mail não saía a
 * cliente ficava sem o PIX. O código está NESTA página, sempre — o e-mail,
 * quando sai, é cópia.
 */
function pagoLabel(order: Order): string {
  if (order.status === 'paid') return 'Pagamento confirmado';
  if (order.payment.method === 'pix') {
    return order.payment.pix ? 'Aguardando o PIX — o código está logo acima' : 'Aguardando o PIX';
  }
  return 'Pagamento em processamento';
}

function PassoItem({ done, label }: { done: boolean; label: string }) {
  return (
    <li className="flex items-center gap-3">
      <span
        aria-hidden
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-pill border',
          done ? 'border-success bg-success text-light' : 'border-border-strong text-ink-muted',
        )}
      >
        {done ? <CircleCheck className="size-4" /> : <Clock className="size-3.5" />}
      </span>
      <span className={cn('text-body', done ? 'text-ink' : 'text-ink-soft')}>{label}</span>
    </li>
  );
}

/**
 * Rail de recomendados — busca direto no BFF por URL (a página de confirmação
 * não importa engine de busca de ninguém). Falhou? O rail simplesmente não
 * aparece: recomendação nunca pode quebrar a thank you.
 */
function Recomendados() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [erro, setErro] = useState(false);

  useEffect(() => {
    let ativo = true;
    fetch('/api/loja/produtos?ordenar=relevancia&perPage=4')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!ativo) return;
        if (data?.itens?.length) setProducts(mapPecasDaVitrine(data.itens));
        else setErro(true);
      })
      .catch(() => {
        if (ativo) setErro(true);
      });
    return () => {
      ativo = false;
    };
  }, []);

  if (erro) return null;

  return (
    <section aria-label="Você também vai amar" className="mt-20">
      <div className="mb-8 text-center">
        <p className="eyebrow text-primary-strong">Enquanto seu pedido chega</p>
        <h2 className="mt-2 font-display text-h2 text-ink">
          Você também vai <em className="italic">amar</em>
        </h2>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-10 lg:grid-cols-4 lg:gap-x-6">
        {products
          ? products.map((p, i) => <ProductCard key={p.id} product={p} index={i} />)
          : Array.from({ length: 4 }, (_, i) => <ProductCardSkeleton key={i} />)}
      </div>
    </section>
  );
}

/** Silhueta da confirmação — mesmas larguras, zero salto quando carrega. */
function ConfirmacaoSkeleton() {
  return (
    <Container width="page" className="py-10 lg:py-16">
      <div className="mx-auto flex max-w-narrow flex-col items-center gap-5">
        <Skeleton className="h-8 w-52 rounded-pill" />
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-5 w-full max-w-md" />
      </div>
      <div className="mx-auto mt-12 grid max-w-text gap-6 sm:grid-cols-2">
        <Skeleton className="h-44 rounded-md" />
        <Skeleton className="h-44 rounded-md" />
      </div>
    </Container>
  );
}
