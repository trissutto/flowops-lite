'use client';

import { useState } from 'react';
import { Heart, MapPin, MessageCircle, Ruler, ShoppingBag, Sparkles, Star, Truck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SizePill } from '@/components/ui/Choice';
import { FitAssistant } from '@/components/fit/FitAssistant';
import { ProductBadgeTag } from '@/components/ui/Badge';
import { useToast } from '@/components/feedback/ToastProvider';
import { useCartStore } from '@/store/cart';
import { useUiStore } from '@/store/ui';
import { useWishlistStore } from '@/store/wishlist';
import { trackAddToCart } from '@/lib/tracking';
import { useMounted } from '@/hooks';
import { cn, discountPercent, formatPrice } from '@/lib/utils';
import type { Product } from '@/types';

/**
 * BUY BOX — a coluna de decisão de compra.
 *
 * Ordem deliberada: nome → avaliação → preço (com Pix e parcelamento) →
 * tamanho → comprar. O seletor de tamanho vem ANTES do botão porque a dúvida
 * real da cliente plus size é "tem no meu número?", não "quanto custa".
 *
 * Sem tamanho escolhido o botão não some nem fica desabilitado em silêncio:
 * ele avisa. Botão morto sem explicação é o erro clássico de PDP.
 */
export interface CorEscolhivel {
  nome: string;
  swatch: { tipo: 'cor' | 'foto'; hex: string | null; focoX: number | null; focoY: number | null; imagem: string | null };
  estoque: number;
}

export function BuyBox({
  product, cores, corSelecionada, onSelecionarCor,
}: {
  product: Product;
  /** Cores da peça. Vazio = peça de cor única (ou catálogo sem ficha ainda). */
  cores?: CorEscolhivel[];
  corSelecionada?: string | null;
  onSelecionarCor?: (nome: string) => void;
}) {
  const [size, setSize] = useState<string | null>(null);
  const [sizeError, setSizeError] = useState(false);
  // LURDS FIT AI — assistente próprio de tamanho
  const [fitOpen, setFitOpen] = useState(false);
  const { toast } = useToast();
  const mounted = useMounted();
  const addToCart = useCartStore((s) => s.add);
  const openOverlay = useUiStore((s) => s.openOverlay);
  const toggleWishlist = useWishlistStore((s) => s.toggle);
  const isFavorite = useWishlistStore((s) => s.ids.includes(product.id));

  const available = product.sizes.filter((s) => s.available);
  const soldOut = available.length === 0;
  const discount = product.compareAtPrice
    ? discountPercent(product.compareAtPrice, product.price)
    : 0;

  function handleAdd() {
    if (!size) {
      setSizeError(true);
      document.getElementById('seletor-tamanho')?.scrollIntoView({ block: 'center' });
      return;
    }
    // A cor escolhida vai junto no carrinho: sem ela a separação não sabe qual
    // peça tirar da arara (mesma REF, cores diferentes).
    const cor = corSelecionada ?? (cores?.length === 1 ? cores[0].nome : undefined);
    addToCart({
      productId: product.id,
      slug: product.slug,
      name: cor ? `${product.name} · ${cor}` : product.name,
      image: product.images[0] ?? { src: '', alt: product.name },
      size,
      quantity: 1,
      unitPrice: product.price,
    });
    // add_to_cart SÓ depois da peça entrar de fato no carrinho (contrato do
    // tracking).
    trackAddToCart(product, { tamanho: size, cor });
    toast({
      message: 'Adicionado à sacola',
      description: `${product.name} · ${cor ? `${cor} · ` : ''}tamanho ${size}`,
    });
    // Abre o mini-cart: a cliente VÊ a peça entrar na sacola sem sair da
    // página — e o próximo passo (finalizar) já está na mão dela.
    openOverlay('cart');
  }

  const whatsapp = `https://api.whatsapp.com/send?phone=5513996050174&text=${encodeURIComponent(
    `Olá! Tenho interesse na peça "${product.name}". Vocês têm no tamanho ${size ?? '__'}?`,
  )}`;

  return (
    <div className="flex flex-col">
      {product.badges && product.badges.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {product.badges.map((badge) => (
            <ProductBadgeTag key={badge} badge={badge} />
          ))}
        </div>
      )}

      {product.fabric && <p className="eyebrow text-primary-strong">{product.fabric}</p>}

      <h1 className="mt-3 font-display text-h2 text-ink">{product.name}</h1>

      {product.rating && (
        <div className="mt-4 flex items-center gap-2">
          <span className="flex items-center gap-0.5" role="img" aria-label={`${product.rating.average} de 5`}>
            {Array.from({ length: 5 }, (_, i) => (
              <Star
                key={i}
                className={cn(
                  'size-3.5',
                  i < Math.round(product.rating!.average)
                    ? 'fill-primary text-primary'
                    : 'text-border-strong',
                )}
                strokeWidth={1.5}
              />
            ))}
          </span>
          <span className="text-small text-ink-soft">
            {product.rating.average.toFixed(1)} · {product.rating.count} avaliações
          </span>
        </div>
      )}

      {/* Preço */}
      <div className="mt-7">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {product.compareAtPrice && (
            <span className="tabular text-body text-ink-muted line-through">
              {formatPrice(product.compareAtPrice)}
            </span>
          )}
          <span className="tabular font-display text-[2rem] leading-none font-medium text-ink">
            {formatPrice(product.price)}
          </span>
          {discount > 0 && (
            <span className="tabular rounded-pill bg-secondary-wash px-2.5 py-1 text-small font-medium text-secondary">
              -{discount}%
            </span>
          )}
        </div>

        <p className="mt-3 text-body font-light text-ink-soft">
          {product.pixPrice && (
            <>
              <span className="tabular font-medium text-success">
                {formatPrice(product.pixPrice)}
              </span>{' '}
              no Pix (5% off) ·{' '}
            </>
          )}
          {product.installments && (
            <span className="tabular">
              {product.installments.times}x de {formatPrice(product.installments.value)} sem juros
            </span>
          )}
        </p>
      </div>

      {/* COR — vem ANTES do tamanho: a cliente escolhe a cor e só então vê a
          grade daquela cor (cada cor tem estoque próprio). Escolher o 48 e
          depois descobrir que ele só existe no preto é o pior caminho. */}
      {cores && cores.length > 1 && (
        <div className="mt-9">
          <p className="eyebrow text-ink">
            Cor
            {corSelecionada && <span className="ml-2 text-ink-soft normal-case">{corSelecionada}</span>}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            {cores.map((c) => {
              const escolhida = corSelecionada === c.nome;
              const esgotada = c.estoque <= 0;
              const estilo: React.CSSProperties =
                c.swatch.tipo === 'foto' && c.swatch.imagem
                  ? {
                      backgroundImage: `url(${c.swatch.imagem})`,
                      backgroundSize: '400%',
                      backgroundPosition: `${(c.swatch.focoX ?? 0.5) * 100}% ${(c.swatch.focoY ?? 0.5) * 100}%`,
                    }
                  : { backgroundColor: c.swatch.hex || '#D9D4CC' };

              return (
                <button
                  key={c.nome}
                  type="button"
                  onClick={() => onSelecionarCor?.(c.nome)}
                  aria-pressed={escolhida}
                  aria-label={`Cor ${c.nome}${esgotada ? ' (esgotada)' : ''}`}
                  title={c.nome}
                  className={cn(
                    'relative size-9 rounded-full border transition-all duration-[320ms]',
                    escolhida
                      ? 'border-ink ring-2 ring-ink ring-offset-2 ring-offset-background'
                      : 'border-border hover:border-ink-soft',
                    esgotada && 'opacity-40',
                  )}
                >
                  <span style={estilo} className="absolute inset-[3px] rounded-full" />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Tamanho */}
      <div id="seletor-tamanho" className="mt-9 scroll-mt-28">
        <div className="flex items-center justify-between">
          <p className="eyebrow text-ink">Tamanho</p>
          <a
            href="/tamanhos/guia"
            className="inline-flex items-center gap-1.5 text-small text-ink-soft underline decoration-border underline-offset-4 transition-colors hover:text-ink"
          >
            <Ruler className="size-3.5" strokeWidth={1.75} />
            Guia de medidas
          </a>
        </div>

        {/* LURDS FIT AI — mata a objeção "será que serve?" antes do seletor */}
        {!soldOut && (
          <button
            type="button"
            onClick={() => setFitOpen(true)}
            className="group mt-4 flex w-full items-center justify-center gap-2 rounded-sm border border-primary bg-primary-wash px-5 py-3.5 text-small font-medium text-primary-strong transition-all duration-[320ms] hover:border-primary-strong hover:bg-champagne"
          >
            <Sparkles
              className="size-3.5 transition-transform duration-[320ms] group-hover:scale-110"
              strokeWidth={1.75}
            />
            Descubra seu tamanho ideal
          </button>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {product.sizes.map((option) => (
            <SizePill
              key={option.label}
              label={option.label}
              selected={size === option.label}
              disabled={!option.available}
              onSelect={() => {
                setSize(option.label);
                setSizeError(false);
              }}
            />
          ))}
        </div>

        {sizeError && (
          <p role="alert" className="mt-3 text-small text-danger">
            Escolha um tamanho pra continuar.
          </p>
        )}

        {soldOut && (
          <p className="mt-3 text-small text-ink-soft">
            Esgotado no site — mas pode ter na loja. Chame uma consultora que a gente procura nas
            14 unidades.
          </p>
        )}
      </div>

      {/* Ações */}
      <div className="mt-9 flex flex-col gap-2.5">
        {!soldOut && (
          <Button size="lg" block onClick={handleAdd}>
            <ShoppingBag /> Adicionar à sacola
          </Button>
        )}

        <div className="grid grid-cols-2 gap-2.5">
          <Button
            variant="secondary"
            onClick={() => {
              toggleWishlist(product.id);
              toast({
                message:
                  mounted && isFavorite ? 'Removido dos favoritos' : 'Salvo nos favoritos',
              });
            }}
          >
            <Heart className={cn(mounted && isFavorite && 'fill-secondary text-secondary')} />
            {mounted && isFavorite ? 'Salvo' : 'Favoritar'}
          </Button>
          <Button href={whatsapp} external variant="whatsapp">
            <MessageCircle /> Tirar dúvida
          </Button>
        </div>
      </div>

      {/* Garantias — o que tira o medo de comprar online */}
      <ul className="mt-9 flex flex-col gap-3 border-t border-border pt-7 text-small text-ink-soft">
        <li className="flex items-center gap-3">
          <Truck className="size-4 shrink-0 text-primary-strong" strokeWidth={1.75} />
          Frete grátis acima de R$ 399 para todo o Brasil
        </li>
        <li className="flex items-center gap-3">
          <MapPin className="size-4 shrink-0 text-primary-strong" strokeWidth={1.75} />
          Retire e prove em uma das 14 lojas antes de levar
        </li>
        <li className="flex items-center gap-3">
          <Ruler className="size-4 shrink-0 text-primary-strong" strokeWidth={1.75} />
          Troca fácil em até 30 dias, sem burocracia
        </li>
      </ul>

      <FitAssistant
        open={fitOpen}
        onClose={() => setFitOpen(false)}
        productRef={product.sku ?? product.id}
        productName={product.name}
        categoria={product.category}
        tamanhosDisponiveis={available.map((s) => s.label)}
        onEscolherTamanho={(tamanho) => {
          setSize(tamanho);
          setSizeError(false);
          toast({ message: `Tamanho ${tamanho} selecionado`, description: 'Recomendado pelo Lurd’s Fit AI' });
          document.getElementById('seletor-tamanho')?.scrollIntoView({ block: 'center' });
        }}
      />
    </div>
  );
}
