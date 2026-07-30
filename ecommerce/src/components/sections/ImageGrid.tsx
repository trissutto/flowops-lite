'use client';

import Image from 'next/image';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { BLUR_DATA_URL, cn } from '@/lib/utils';
import { fadeUp, reveal, staggerBase } from '@/lib/motion';
import type { EditorialArticle, Media } from '@/types';

/**
 * IMAGE GRID — grade editorial estilo revista.
 *
 * O truque que tira a cara de "galeria": os itens NÃO têm todos o mesmo
 * tamanho. O layout `feature` dá uma foto grande à esquerda e duas menores à
 * direita; `mosaic` alterna alturas em três colunas. É isso que cria ritmo.
 */

interface ImageGridItem {
  image: Media;
  caption?: string;
  href?: string;
}

interface ImageGridProps {
  items: ImageGridItem[];
  layout?: 'feature' | 'mosaic' | 'even';
  className?: string;
}

function GridImage({
  item,
  className,
  sizes,
}: {
  item: ImageGridItem;
  className?: string;
  sizes: string;
}) {
  const content = (
    <figure className={cn('group relative h-full overflow-hidden rounded-md bg-surface-alt', className)}>
      <Image
        src={item.image.src}
        alt={item.image.alt}
        fill
        sizes={sizes}
        placeholder="blur"
        blurDataURL={BLUR_DATA_URL}
        className="object-cover transition-transform duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.04]"
      />
      {item.caption && (
        <>
          <div className="absolute inset-0 bg-gradient-to-t from-ink/60 via-transparent to-transparent" />
          <figcaption className="absolute inset-x-5 bottom-5 flex items-center gap-2 text-small font-light text-light">
            {item.caption}
            {item.href && (
              <ArrowRight className="size-3.5 transition-transform duration-[320ms] group-hover:translate-x-1" />
            )}
          </figcaption>
        </>
      )}
    </figure>
  );

  return item.href ? (
    <Link href={item.href} className={cn('block h-full', className)}>
      {content}
    </Link>
  ) : (
    content
  );
}

export function ImageGrid({ items, layout = 'feature', className }: ImageGridProps) {
  if (layout === 'feature') {
    const [first, ...rest] = items;
    return (
      <motion.div
        {...reveal(staggerBase)}
        className={cn('grid gap-4 lg:grid-cols-2 lg:gap-6', className)}
      >
        {first && (
          <motion.div variants={fadeUp} className="aspect-4/5 lg:aspect-auto lg:min-h-[560px]">
            <GridImage item={first} sizes="(max-width: 1024px) 100vw, 50vw" />
          </motion.div>
        )}
        <div className="grid gap-4 lg:gap-6">
          {rest.slice(0, 2).map((item, i) => (
            <motion.div key={i} variants={fadeUp} className="aspect-4/3 lg:aspect-auto">
              <GridImage item={item} sizes="(max-width: 1024px) 100vw, 50vw" />
            </motion.div>
          ))}
        </div>
      </motion.div>
    );
  }

  if (layout === 'mosaic') {
    return (
      <motion.div
        {...reveal(staggerBase)}
        className={cn('grid grid-cols-2 gap-4 lg:grid-cols-3 lg:gap-6', className)}
      >
        {items.map((item, i) => (
          <motion.div
            key={i}
            variants={fadeUp}
            className={cn(i % 3 === 1 ? 'aspect-3/4' : 'aspect-square', i % 5 === 0 && 'lg:row-span-2 lg:aspect-auto')}
          >
            <GridImage item={item} sizes="(max-width: 640px) 50vw, 33vw" />
          </motion.div>
        ))}
      </motion.div>
    );
  }

  return (
    <motion.div
      {...reveal(staggerBase)}
      className={cn('grid grid-cols-2 gap-4 lg:grid-cols-4 lg:gap-6', className)}
    >
      {items.map((item, i) => (
        <motion.div key={i} variants={fadeUp} className="aspect-3/4">
          <GridImage item={item} sizes="(max-width: 640px) 50vw, 25vw" />
        </motion.div>
      ))}
    </motion.div>
  );
}

/**
 * EditorialCard — artigo da seção "Editorial da semana".
 * Fica aqui por proximidade: os dois compõem a mesma linguagem de revista.
 */
export function EditorialCard({
  article,
  index = 0,
  size = 'md',
  className,
}: {
  article: EditorialArticle;
  index?: number;
  size?: 'md' | 'lg';
  className?: string;
}) {
  return (
    <motion.article
      {...reveal(fadeUp, '-40px')}
      transition={{ duration: 0.56, delay: (index % 3) * 0.08 }}
      className={className}
    >
      <Link href={article.href} className="group block">
        <div
          className={cn(
            'relative overflow-hidden rounded-md bg-surface-alt',
            size === 'lg' ? 'aspect-16/9' : 'aspect-4/3',
          )}
        >
          <Image
            src={article.image.src}
            alt={article.image.alt}
            fill
            sizes={size === 'lg' ? '(max-width: 1024px) 100vw, 66vw' : '(max-width: 1024px) 100vw, 33vw'}
            placeholder="blur"
            blurDataURL={BLUR_DATA_URL}
            className="object-cover transition-transform duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.04]"
          />
        </div>

        <div className="mt-6">
          {article.eyebrow && <p className="eyebrow text-primary-strong">{article.eyebrow}</p>}
          <h3
            className={cn(
              'mt-3 font-display text-ink',
              size === 'lg' ? 'text-h2' : 'text-h3',
            )}
          >
            {article.title}
          </h3>
          <p className="mt-3 max-w-xl text-body font-light text-ink-soft">{article.excerpt}</p>
          <span className="mt-5 inline-flex items-center gap-2 text-[0.6875rem] font-medium tracking-[0.16em] text-ink uppercase">
            Ler matéria
            {article.readingTime && (
              <span className="font-light text-ink-muted normal-case">· {article.readingTime}</span>
            )}
            <ArrowRight className="size-3.5 transition-transform duration-[320ms] group-hover:translate-x-1" />
          </span>
        </div>
      </Link>
    </motion.article>
  );
}
