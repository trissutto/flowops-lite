'use client';

import { Fragment } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { ProductCard } from '@/components/cards/ProductCard';
import { LookCard } from '@/components/cards/LookCard';
import { BLUR_DATA_URL, cn } from '@/lib/utils';
import type { Look, Media, Product } from '@/types';

/**
 * GRID EDITORIAL — o que separa "coleção curada" de "catálogo".
 *
 * A grade NÃO é uniforme: a cada N produtos, um bloco editorial entra e
 * ocupa 2 colunas (imagem de campanha, look completo ou banner). O ritmo
 * resultante é o de uma revista, não de uma prateleira.
 *
 * `interruptions` é uma lista de blocos com a posição onde entram. Se a
 * página não passar nada, o grid degrada pra grade limpa — o componente
 * continua servindo pra busca e outlet.
 */

export type GridInterruption =
  | { at: number; kind: 'image'; image: Media; caption?: string; href?: string }
  | { at: number; kind: 'look'; look: Look }
  | { at: number; kind: 'banner'; eyebrow?: string; title: string; description?: string; href: string; cta: string };

interface EditorialProductGridProps {
  products: Product[];
  interruptions?: GridInterruption[];
  onQuickView?: (product: Product) => void;
  /** Visualização compacta (mais colunas, sem interrupções). */
  view?: 'editorial' | 'grid';
  className?: string;
}

export function EditorialProductGrid({
  products,
  interruptions = [],
  onQuickView,
  view = 'editorial',
  className,
}: EditorialProductGridProps) {
  const byPosition = new Map<number, GridInterruption>();
  if (view === 'editorial') {
    for (const item of interruptions) byPosition.set(item.at, item);
  }

  return (
    <div
      className={cn(
        'grid gap-x-4 gap-y-10 lg:gap-x-6 lg:gap-y-14',
        view === 'editorial'
          ? 'grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
          : 'grid-cols-2 lg:grid-cols-4 xl:grid-cols-5',
        className,
      )}
    >
      {products.map((product, index) => {
        const interruption = byPosition.get(index);
        return (
          <Fragment key={product.id}>
            {interruption && <Interruption block={interruption} />}
            <ProductCard
              product={product}
              index={index}
              onQuickView={onQuickView}
              priority={index < 4}
            />
          </Fragment>
        );
      })}
    </div>
  );
}

/** Bloco que quebra o ritmo da grade. Sempre ocupa 2 colunas. */
function Interruption({ block }: { block: GridInterruption }) {
  if (block.kind === 'look') {
    return (
      <div className="col-span-2 lg:col-span-2">
        <LookCard look={block.look} />
      </div>
    );
  }

  if (block.kind === 'banner') {
    return (
      <div className="col-span-2 flex flex-col justify-center rounded-md bg-ink p-8 text-light lg:col-span-2 lg:p-12">
        {block.eyebrow && <p className="eyebrow text-primary-soft">{block.eyebrow}</p>}
        <h3 className="mt-4 font-display text-h3 text-light">{block.title}</h3>
        {block.description && (
          <p className="mt-4 text-body font-light text-light/70">{block.description}</p>
        )}
        <Link
          href={block.href}
          className="group mt-7 inline-flex items-center gap-2 self-start text-[0.6875rem] font-medium tracking-[0.16em] text-primary-soft uppercase"
        >
          {block.cta}
          <ArrowRight className="size-3.5 transition-transform duration-[320ms] group-hover:translate-x-1" />
        </Link>
      </div>
    );
  }

  const content = (
    <figure className="group relative aspect-4/5 overflow-hidden rounded-md bg-surface-alt lg:aspect-auto lg:h-full">
      <Image
        src={block.image.src}
        alt={block.image.alt}
        fill
        sizes="(max-width: 1024px) 100vw, 50vw"
        placeholder="blur"
        blurDataURL={BLUR_DATA_URL}
        className="object-cover transition-transform duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.04]"
      />
      {block.caption && (
        <>
          <div className="absolute inset-0 bg-gradient-to-t from-ink/60 via-transparent to-transparent" />
          <figcaption className="absolute inset-x-6 bottom-6 font-display text-h4 text-light">
            {block.caption}
          </figcaption>
        </>
      )}
    </figure>
  );

  return (
    <div className="col-span-2 lg:col-span-2">
      {block.href ? <Link href={block.href}>{content}</Link> : content}
    </div>
  );
}
