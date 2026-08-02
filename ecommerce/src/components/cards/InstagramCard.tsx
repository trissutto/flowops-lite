'use client';

import Image from 'next/image';
import { Heart, Play, ShoppingBag } from 'lucide-react';
import { BLUR_DATA_URL, cn } from '@/lib/utils';
import type { InstagramPost } from '@/types';

/**
 * INSTAGRAM CARD — post da galeria social.
 *
 * Feito à mão de propósito: widget de terceiro carrega iframe, script externo
 * e mata o Lighthouse. Aqui é só next/image + link, e os produtos marcados
 * viram atalho de compra (é o que transforma inspiração em venda).
 */

export function InstagramCard({
  post,
  className,
}: {
  post: InstagramPost;
  className?: string;
}) {
  const tagged = post.taggedProducts ?? [];

  return (
    <a
      href={post.permalink}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('group relative block aspect-square overflow-hidden rounded-md bg-surface-alt', className)}
    >
      <Image
        src={post.image.src}
        alt={post.image.alt}
        fill
        // Sempre lazy. Antes as 4 primeiras eram `eager`, e o next/image
        // transforma isso em <link rel=preload>: quatro preloads da 12ª seção
        // da home competindo com a imagem do hero, que é o LCP. Esta grade
        // vive no fim da página — nunca vale a pena adiantar.
        loading="lazy"
        sizes="(max-width: 640px) 45vw, (max-width: 1024px) 31vw, 16vw"
        placeholder="blur"
        blurDataURL={BLUR_DATA_URL}
        className="object-cover transition-transform duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.04]"
      />

      {post.isVideo && (
        <span className="absolute top-3 right-3 flex size-8 items-center justify-center rounded-pill bg-ink/50 text-light backdrop-blur">
          <Play className="size-3.5 fill-current" strokeWidth={0} />
        </span>
      )}

      {/* Véu com métricas — só no hover, pra não poluir a grade */}
      <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-ink/75 via-ink/10 to-transparent p-4 opacity-0 transition-opacity duration-[320ms] group-hover:opacity-100">
        {tagged.length > 0 && (
          <p className="flex items-center gap-1.5 text-[0.6875rem] font-medium tracking-[0.12em] text-light uppercase">
            <ShoppingBag className="size-3.5" strokeWidth={1.75} />
            {tagged.length === 1 ? '1 peça marcada' : `${tagged.length} peças marcadas`}
          </p>
        )}
        {post.likes !== undefined && (
          <p className="tabular mt-1.5 flex items-center gap-1.5 text-small text-light/85">
            <Heart className="size-3.5 fill-current" strokeWidth={0} />
            {post.likes.toLocaleString('pt-BR')}
          </p>
        )}
      </div>
    </a>
  );
}
