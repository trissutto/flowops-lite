'use client';

import { useState } from 'react';
import Image from 'next/image';
import { AppLink as Link } from '@/components/ui/AppLink';
import { motion } from 'framer-motion';
import { Bookmark, Plus, Share2, ShoppingBag } from 'lucide-react';
import { BLUR_DATA_URL, cn, formatPrice } from '@/lib/utils';
import { fadeUp, reveal, transition } from '@/lib/motion';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/feedback/ToastProvider';
import type { Look } from '@/types';

/**
 * LOOK CARD (Shop the Look) — foto editorial com pins nas peças.
 *
 * No desktop, passar o mouse revela os pins e a lista de peças do look;
 * no mobile a lista já vem aberta abaixo da foto (não existe hover no toque).
 * Dois caminhos de compra: o look completo ou peça por peça.
 */

interface LookCardProps {
  look: Look;
  index?: number;
  /** Compra o look inteiro (a página decide: adiciona tudo ou abre drawer). */
  onBuyLook?: (look: Look) => void;
  onSaveLook?: (look: Look) => void;
  className?: string;
  /**
   * `sizes` do next/image. O padrão descreve o carrossel do Shop the Look
   * (`perView={{ base: 1.1, sm: 1.6, lg: 2.4, xl: 3 }}`), que é onde este card
   * quase sempre vive. Quem usar em grade passa o seu.
   */
  sizes?: string;
}

/** Largura do card no carrossel do Shop the Look. */
const CAROUSEL_SIZES =
  '(max-width: 640px) 88vw, (max-width: 1024px) 60vw, (max-width: 1280px) 40vw, 32vw';

export function LookCard({
  look,
  index = 0,
  onBuyLook,
  onSaveLook,
  className,
  sizes = CAROUSEL_SIZES,
}: LookCardProps) {
  const [hovered, setHovered] = useState(false);
  const { toast } = useToast();

  async function share() {
    const url = `${window.location.origin}/looks/${look.slug}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: look.title, url });
      } else {
        await navigator.clipboard.writeText(url);
        toast({ message: 'Link do look copiado' });
      }
    } catch {
      /* usuário cancelou o compartilhamento */
    }
  }

  return (
    <motion.article
      {...reveal(fadeUp, '-40px')}
      transition={{ duration: 0.56, delay: (index % 3) * 0.08 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn('group flex flex-col', className)}
    >
      <div className="relative aspect-3/4 overflow-hidden rounded-md bg-surface-alt">
        <Image
          src={look.image.src}
          alt={look.image.alt}
          fill
          sizes={sizes}
          placeholder="blur"
          blurDataURL={BLUR_DATA_URL}
          className="object-cover transition-transform duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.04]"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-ink/65 via-transparent to-transparent" />

        {/* Pins sobre as peças */}
        {look.items.map(
          (item, i) =>
            item.hotspot && (
              <motion.div
                key={item.product.id}
                initial={false}
                animate={{ opacity: hovered ? 1 : 0.55, scale: hovered ? 1 : 0.9 }}
                transition={transition.base}
                style={{ left: `${item.hotspot.x}%`, top: `${item.hotspot.y}%` }}
                className="absolute hidden -translate-x-1/2 -translate-y-1/2 lg:block"
              >
                <Link
                  href={`/produto/${item.product.slug}`}
                  aria-label={`Ver ${item.product.name}`}
                  className="flex size-7 items-center justify-center rounded-pill bg-light/90 text-ink shadow-md backdrop-blur transition-transform hover:scale-110"
                >
                  <Plus className="size-3.5" strokeWidth={2} />
                  <span className="sr-only">Peça {i + 1}</span>
                </Link>
              </motion.div>
            ),
        )}

        {/* Ações secundárias */}
        <div className="absolute top-3 right-3 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => {
              onSaveLook?.(look);
              toast({ message: 'Look salvo nos favoritos' });
            }}
            aria-label="Salvar look"
            className="flex size-9 items-center justify-center rounded-pill bg-surface/85 text-ink-soft backdrop-blur transition-colors hover:bg-surface hover:text-ink"
          >
            <Bookmark className="size-4" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            onClick={share}
            aria-label="Compartilhar look"
            className="flex size-9 items-center justify-center rounded-pill bg-surface/85 text-ink-soft backdrop-blur transition-colors hover:bg-surface hover:text-ink"
          >
            <Share2 className="size-4" strokeWidth={1.5} />
          </button>
        </div>

        <div className="absolute inset-x-5 bottom-5">
          <p className="eyebrow text-primary-soft">Shop the look</p>
          <h3 className="mt-1.5 font-display text-h3 text-light">{look.title}</h3>
        </div>
      </div>

      {/* Peças do look */}
      <div className="mt-5">
        <ul className="flex flex-col gap-2.5">
          {look.items.map((item) => (
            <li key={item.product.id} className="flex items-center justify-between gap-4">
              <Link
                href={`/produto/${item.product.slug}`}
                className="link-underline min-w-0 truncate text-small font-light text-ink-soft hover:text-ink"
              >
                {item.product.name}
              </Link>
              <span className="tabular shrink-0 text-small text-ink">
                {formatPrice(item.product.price)}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-5 flex items-center justify-between gap-4 border-t border-border pt-4">
          <div>
            <p className="eyebrow text-ink-muted">Look completo</p>
            <p className="tabular mt-1 text-body font-medium text-ink">
              {formatPrice(look.totalPrice)}
            </p>
          </div>
          <Button size="sm" onClick={() => onBuyLook?.(look)}>
            <ShoppingBag /> Levar o look
          </Button>
        </div>
      </div>
    </motion.article>
  );
}
