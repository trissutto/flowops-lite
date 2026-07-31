'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Bookmark, Heart, Minus, Plus, X } from 'lucide-react';
import { useCartStore } from '@/store/cart';
import { useWishlistStore } from '@/store/wishlist';
import { trackAddToWishlist, trackRemoveFromCart } from '@/lib/tracking';
import { BLUR_DATA_URL, cn, formatPrice } from '@/lib/utils';
import type { CartLine } from '@/types';

/**
 * CART LINE ROW — a linha de peça na sacola. Mini-cart e página /carrinho
 * usam ESTE componente: o stepper, o remover e o tracking se comportam
 * igual nos dois lugares porque são o mesmo código.
 *
 * A linha fala direto com o cart store (os dois consumidores usam o mesmo)
 * em vez de receber callbacks — menos prop drilling e zero chance de um
 * lado esquecer o tracking. Os eventos disparam DEPOIS da mutação, que no
 * zustand é síncrona e não falha (contrato do tracking: medir ação, nunca
 * intenção).
 */

interface CartLineRowProps {
  line: CartLine;
  /** Linha da lista "Guardado para depois" — troca stepper por "mover pra sacola". */
  saved?: boolean;
  /** Layout da página: foto maior + ações secundárias (salvar/favoritar). */
  full?: boolean;
  /** Aviso de estoque vindo da revalidação da página (esgotado/última peça). */
  notice?: { text: string; tone: 'danger' | 'gold' };
}

/** CartLine → item rastreável (o carrinho não guarda categoria/coleção). */
function trackable(line: CartLine) {
  return { id: line.productId, sku: line.productId, name: line.name, price: line.unitPrice };
}

export function CartLineRow({ line, saved = false, full = false, notice }: CartLineRowProps) {
  const setQuantity = useCartStore((s) => s.setQuantity);
  const remove = useCartStore((s) => s.remove);
  const saveForLater = useCartStore((s) => s.saveForLater);
  const moveToCart = useCartStore((s) => s.moveToCart);
  const removeSaved = useCartStore((s) => s.removeSaved);
  const wishlistToggle = useWishlistStore((s) => s.toggle);
  const inWishlist = useWishlistStore((s) => s.ids.includes(line.productId));

  const href = `/produto/${line.slug}`;
  const lineTotal = line.unitPrice * line.quantity;

  function handleRemove() {
    if (saved) {
      // Peça guardada nunca esteve no funil de compra — sem remove_from_cart.
      removeSaved(line.id);
      return;
    }
    remove(line.id);
    trackRemoveFromCart(trackable(line), {
      tamanho: line.size,
      cor: line.color,
      quantidade: line.quantity,
    });
  }

  function handleDecrease() {
    // No 1, o "−" é um remover disfarçado — passa pelo mesmo caminho pra
    // não perder o evento de remoção.
    if (line.quantity <= 1) {
      handleRemove();
      return;
    }
    setQuantity(line.id, line.quantity - 1);
  }

  function handleSaveForLater() {
    saveForLater(line.id);
    // Sai do funil de compra (o subtotal muda) — o remove_from_cart registra
    // isso; guardar não é evento de wishlist nem de venda.
    trackRemoveFromCart(trackable(line), {
      tamanho: line.size,
      cor: line.color,
      quantidade: line.quantity,
    });
  }

  function handleMoveToWishlist() {
    // `toggle` removeria uma peça já favoritada — só adiciona se faltar.
    if (!inWishlist) {
      wishlistToggle(line.productId);
      trackAddToWishlist(trackable(line));
    }
    remove(line.id);
    trackRemoveFromCart(trackable(line), {
      tamanho: line.size,
      cor: line.color,
      quantidade: line.quantity,
    });
  }

  return (
    <div className={cn('flex gap-4', full && 'gap-5')}>
      {/* Foto 3/4 — mesmo enquadramento editorial dos cards. */}
      <Link
        href={href}
        className={cn(
          'relative shrink-0 overflow-hidden rounded-sm bg-surface-alt',
          full ? 'w-24 sm:w-28' : 'w-20',
          'aspect-3/4',
        )}
        aria-label={line.name}
        tabIndex={-1}
      >
        {line.image.src && (
          <Image
            src={line.image.src}
            alt={line.image.alt}
            fill
            sizes="112px"
            placeholder="blur"
            blurDataURL={BLUR_DATA_URL}
            className="object-cover"
          />
        )}
      </Link>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              href={href}
              className="line-clamp-2 text-body font-normal text-ink transition-colors hover:text-primary-strong"
            >
              {line.name}
            </Link>
            <p className="mt-1 text-small font-light text-ink-soft">
              {line.color ? `${line.color} · ` : ''}Tamanho {line.size}
            </p>
          </div>

          <button
            type="button"
            onClick={handleRemove}
            aria-label={`Remover ${line.name} da sacola`}
            className="-m-1 shrink-0 rounded-pill p-1 text-ink-muted transition-colors hover:text-ink"
          >
            <X className="size-4" strokeWidth={1.5} />
          </button>
        </div>

        {notice && (
          <p
            role="status"
            className={cn(
              'mt-2 text-small',
              notice.tone === 'danger' ? 'text-danger' : 'font-medium text-primary-strong',
            )}
          >
            {notice.text}
          </p>
        )}

        <div className="mt-auto flex items-end justify-between gap-3 pt-3">
          {saved ? (
            <button
              type="button"
              onClick={() => moveToCart(line.id)}
              className="link-underline text-small font-medium text-primary-strong"
            >
              Mover para a sacola
            </button>
          ) : (
            <div
              className="flex items-center rounded-pill border border-border"
              role="group"
              aria-label={`Quantidade de ${line.name}`}
            >
              <button
                type="button"
                onClick={handleDecrease}
                aria-label="Diminuir quantidade"
                className="flex size-8 items-center justify-center rounded-pill text-ink-soft transition-colors hover:text-ink"
              >
                <Minus className="size-3.5" strokeWidth={1.75} />
              </button>
              <span aria-live="polite" className="tabular min-w-6 text-center text-small font-medium text-ink">
                {line.quantity}
              </span>
              <button
                type="button"
                onClick={() => setQuantity(line.id, line.quantity + 1)}
                aria-label="Aumentar quantidade"
                className="flex size-8 items-center justify-center rounded-pill text-ink-soft transition-colors hover:text-ink"
              >
                <Plus className="size-3.5" strokeWidth={1.75} />
              </button>
            </div>
          )}

          <div className="text-right">
            <p className="tabular text-body font-medium text-ink">{formatPrice(lineTotal)}</p>
            {line.quantity > 1 && (
              <p className="tabular text-[0.6875rem] font-light text-ink-muted">
                {formatPrice(line.unitPrice)} cada
              </p>
            )}
          </div>
        </div>

        {/* Ações secundárias — só na página, onde há espaço pra respirar. */}
        {full && !saved && (
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3">
            <button
              type="button"
              onClick={handleSaveForLater}
              className="inline-flex items-center gap-1.5 text-small font-light text-ink-soft transition-colors hover:text-ink"
            >
              <Bookmark className="size-3.5" strokeWidth={1.5} />
              Salvar para depois
            </button>
            <button
              type="button"
              onClick={handleMoveToWishlist}
              className="inline-flex items-center gap-1.5 text-small font-light text-ink-soft transition-colors hover:text-ink"
            >
              <Heart className="size-3.5" strokeWidth={1.5} />
              Mover para favoritos
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
