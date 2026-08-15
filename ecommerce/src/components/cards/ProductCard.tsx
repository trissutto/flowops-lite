'use client';


import Image from 'next/image';
import { AppLink as Link } from '@/components/ui/AppLink';
import { Eye, Heart, ShoppingBag } from 'lucide-react';
import { BLUR_DATA_URL, cn, discountPercent, formatInstallments, formatPrice } from '@/lib/utils';
import { ProductBadgeTag } from '@/components/ui/Badge';
import { useWishlistStore } from '@/store/wishlist';
import { useQuickAddStore } from '@/store/quick-add';
import { useMounted } from '@/hooks';
import type { Product } from '@/types';
import { ProgressiveImage } from '@/components/media/ProgressiveImage';

/**
 * PRODUCT CARD — o card definitivo do ecommerce. Nenhuma página cria o seu.
 *
 * Comportamento premium no hover (desktop):
 *   - a segunda foto entra em crossfade (troca automática de imagem)
 *   - a foto ativa dá zoom de 4%
 *   - "Quick view" e os tamanhos disponíveis sobem por baixo
 * No mobile nada disso dispara: o card fica limpo e o toque vai direto pro
 * produto (hover em touch é armadilha de usabilidade).
 *
 * Preço: valor cheio riscado + preço atual + Pix + parcelamento. O desconto
 * aparece como etiqueta calculada, nunca digitada à mão.
 */

interface ProductCardProps {
  product: Product;
  /** Índice na grade — usado só pro stagger da animação de entrada. */
  index?: number;
  /** Abre o Quick View (a página decide o que fazer). */
  onQuickView?: (product: Product) => void;
  /** Proporção da foto. 3/4 é o padrão editorial da marca. */
  aspect?: '3/4' | '4/5' | '1/1';
  className?: string;
  /** Primeiras fotos da primeira dobra podem priorizar carregamento. */
  priority?: boolean;
  /**
   * `sizes` do next/image. O padrão descreve a GRADE (categoria, busca). Num
   * carrossel o card é bem mais largo — quem monta o carrossel passa o seu,
   * senão o Next escolhe uma variante pequena demais e a foto sai borrada.
   */
  sizes?: string;
  /** Usado só na home: segura o download até a vitrine se aproximar. */
  progressiveImage?: boolean;
}

/** Largura do card na grade padrão de catálogo. */
const GRID_SIZES = '(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw';

/**
 * Largura do card no carrossel `perView={{ base: 1.35, sm: 2, lg: 3, xl: 4 }}`
 * — no mobile ele ocupa ~2/3 da tela, muito mais que os 50vw da grade.
 */
export const CAROUSEL_PRODUCT_SIZES =
  '(max-width: 640px) 68vw, (max-width: 1024px) 46vw, (max-width: 1280px) 31vw, 23vw';

export function ProductCard({
  product,
  index = 0,
  onQuickView,
  aspect = '3/4',
  className,
  priority = false,
  sizes = GRID_SIZES,
  progressiveImage = false,
}: ProductCardProps) {
  const mounted = useMounted();
  const abrirQuickAdd = useQuickAddStore((s) => s.abrir);
  const toggleWishlist = useWishlistStore((s) => s.toggle);
  const isFavorite = useWishlistStore((s) => s.ids.includes(product.id));

  const href = `/produto/${product.slug}`;
  const cover = product.images[0];
  const alternate = product.images[1];
  const discount = product.compareAtPrice
    ? discountPercent(product.compareAtPrice, product.price)
    : 0;
  const availableSizes = product.sizes.filter((s) => s.available);
  const temEstoque = availableSizes.length > 0;
  /**
   * Esgotado = sem grade disponível E sem estoque online. As duas condições
   * porque a grade pode chegar vazia numa peça que existe (cadastro sem
   * tamanho), e riscar o preço de peça vendável é pior que não riscar.
   */
  const esgotado = !temEstoque && product.availability?.online === false;

  /**
   * "Do 44 ao 60" — a pergunta nº 1 da cliente plus size é se serve nela, e a
   * resposta cabe numa linha. Só sai quando os tamanhos são numéricos: com
   * P/M/G a faixa não significa nada.
   */
  const faixaDeTamanhos = (() => {
    const numeros = availableSizes
      .map((s) => parseInt(String(s.label).replace(/\D/g, ''), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (numeros.length < 2) return null;
    const min = Math.min(...numeros);
    const max = Math.max(...numeros);
    return min === max ? null : `Do ${min} ao ${max}`;
  })();

  const aspectClass =
    aspect === '3/4' ? 'aspect-3/4' : aspect === '4/5' ? 'aspect-4/5' : 'aspect-square';
  const ProductImage = progressiveImage ? ProgressiveImage : Image;

  return (
    <article
      className={cn(
        'group relative flex animate-[widget-enter_560ms_cubic-bezier(0.22,1,0.36,1)_both] flex-col',
        className,
      )}
      style={{ animationDelay: `${(index % 4) * 60}ms` }}
    >
      {/* Mídia */}
      <div className={cn('relative overflow-hidden rounded-md bg-surface-alt', aspectClass)}>
        <Link href={href} className="absolute inset-0" aria-label={product.name}>
          <ProductImage
            src={cover.src}
            alt={cover.alt}
            fill
            priority={priority}
            sizes={sizes}
            placeholder="blur"
            blurDataURL={BLUR_DATA_URL}
            className={cn(
              'object-cover transition-all duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
              'opacity-100 lg:group-hover:scale-[1.04]',
              // A troca de foto no hover era `useState` — agora é `group-hover`.
              // Ver o comentário no topo do componente.
              alternate && 'lg:group-hover:opacity-0',
            )}
          />
          {alternate && (
            <ProductImage
              src={alternate.src}
              alt=""
              aria-hidden
              fill
              sizes={sizes}
              placeholder="blur"
              blurDataURL={BLUR_DATA_URL}
              className={cn(
                'hidden object-cover transition-all duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)] lg:block',
                'opacity-0 lg:group-hover:scale-[1.04] lg:group-hover:opacity-100',
              )}
            />
          )}
        </Link>

        {/* Etiquetas */}
        <div className="pointer-events-none absolute top-3 left-3 flex flex-col items-start gap-1.5">
          {discount > 0 && <ProductBadgeTag badge="promocao" />}
          {product.badges?.filter((badge) => badge !== 'promocao').slice(0, 2).map((badge) => (
            <ProductBadgeTag key={badge} badge={badge} />
          ))}
        </div>

        {/* Favoritar */}
        <button
          type="button"
          onClick={() => toggleWishlist(product.id)}
          aria-label={isFavorite ? `Remover ${product.name} dos favoritos` : `Salvar ${product.name} nos favoritos`}
          aria-pressed={mounted ? isFavorite : undefined}
          className="absolute top-3 right-3 flex size-9 items-center justify-center rounded-pill bg-surface/85 text-ink backdrop-blur transition-colors hover:bg-surface"
        >
          <Heart
            className={cn(
              'size-4 transition-colors',
              mounted && isFavorite ? 'fill-secondary text-secondary' : 'text-ink-soft',
            )}
            strokeWidth={1.5}
          />
        </button>

        {/* ADICIONAR RÁPIDO — abre a janelinha de cor/tamanho sem sair da
            página. Fica FORA da camada de hover de propósito: no celular não
            existe hover, e é no celular que a cliente compra. */}
        {temEstoque && (
          <button
            type="button"
            onClick={() => abrirQuickAdd(product)}
            aria-label={`Adicionar ${product.name} à sacola`}
            className="absolute right-3 bottom-3 z-[1] flex size-10 items-center justify-center rounded-pill bg-ink/90 text-light backdrop-blur transition-transform hover:scale-105 lg:size-9"
          >
            <ShoppingBag className="size-4" strokeWidth={1.75} />
          </button>
        )}

        {/* Camada de hover: quick view + tamanhos (desktop) */}
        <div
          className={cn(
            'pointer-events-none absolute inset-x-3 bottom-3 hidden flex-col gap-2 transition-all duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)] lg:flex',
            'translate-y-3 opacity-0 lg:group-hover:translate-y-0 lg:group-hover:opacity-100',
          )}
        >
          {availableSizes.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {/* A GRADE INTEIRA (dono 07/08). O corte em 6 escondia o 58 e o
                  60 justamente nas peças que vão até lá — o card mostrava
                  "46 48 50 52 54 56" embaixo da frase "Do 44 ao 60", e a
                  cliente de 60 concluía que a peça não servia pra ela. A grade
                  da casa tem 9 números; cabem em duas linhas de pílula. */}
              {availableSizes.slice(0, 10).map((size) => (
                <span
                  key={size.label}
                  className="tabular rounded-xs bg-surface/90 px-2 py-1 text-[0.625rem] font-medium text-ink backdrop-blur"
                >
                  {size.label}
                </span>
              ))}
            </div>
          )}
          {onQuickView && (
            <button
              type="button"
              onClick={() => onQuickView(product)}
              className="pointer-events-auto inline-flex items-center justify-center gap-2 rounded-pill bg-ink/90 px-4 py-2.5 text-[0.6875rem] font-medium tracking-[0.16em] text-light uppercase backdrop-blur transition-colors hover:bg-ink"
            >
              <Eye className="size-3.5" strokeWidth={1.75} />
              Ver rápido
            </button>
          )}
        </div>
      </div>

      {/* Texto */}
      <div className="mt-4 flex flex-1 flex-col">
        {product.fabric && <p className="eyebrow text-ink-muted">{product.fabric}</p>}

        <h3 className="mt-1.5">
          <Link
            href={href}
            className="text-body font-normal text-ink transition-colors hover:text-primary-strong"
          >
            {product.name}
          </Link>
        </h3>

        {/* ESGOTADO aparece, riscado (item 37 — decisão do dono 04/08).
            A peça esgotada sumia da vitrine sem explicação: quem viu no
            Instagram voltava e achava que o site tinha quebrado. Vendo que
            existe e acabou, a cliente pergunta quando volta — que é
            exatamente a lista de espera que queremos. */}
        {esgotado ? (
          <>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <span className="tabular text-body text-ink-muted line-through">
                {formatPrice(product.price)}
              </span>
            </div>
            <p className="mt-1 text-small font-medium text-ink-soft">Esgotado por enquanto</p>
          </>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              {product.compareAtPrice && (
                <span className="tabular text-small text-ink-muted line-through">
                  {formatPrice(product.compareAtPrice)}
                </span>
              )}
              <span className="tabular text-body font-medium text-ink">{formatPrice(product.price)}</span>
              {discount > 0 && (
                <span className="tabular text-small font-medium text-secondary">-{discount}%</span>
              )}
            </div>

            <p className="mt-1 text-small font-light text-ink-soft">
              {product.pixPrice && (
                <>
                  <span className="tabular font-medium text-success">{formatPrice(product.pixPrice)}</span>{' '}
                  no Pix ·{' '}
                </>
              )}
              <span className="tabular">
                {product.installments
                  ? `${product.installments.times}x de ${formatPrice(product.installments.value)}`
                  : formatInstallments(product.price)}
              </span>
            </p>
          </>
        )}

        {faixaDeTamanhos && (
          <p className="mt-1.5 text-small text-ink-muted">{faixaDeTamanhos}</p>
        )}

        {/* Cores disponíveis */}
        {product.colors && product.colors.length > 1 && (
          <div className="mt-3 flex items-center gap-1.5" aria-label="Cores disponíveis">
            {product.colors.slice(0, 5).map((color) => (
              <span
                key={color.name}
                title={color.name}
                className="size-3.5 rounded-pill border border-border"
                style={{ backgroundColor: color.hex }}
              />
            ))}
            {product.colors.length > 5 && (
              <span className="text-[0.625rem] text-ink-muted">+{product.colors.length - 5}</span>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
