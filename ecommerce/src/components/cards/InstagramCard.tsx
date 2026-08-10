'use client';

import Image from 'next/image';
import { Play } from 'lucide-react';
import { InstagramIcon } from '@/components/ui/icons';
import { BLUR_DATA_URL, cn } from '@/lib/utils';
import { trackInstagramClick } from '@/lib/tracking';
import type { InstagramPost } from '@/types';

/**
 * INSTAGRAM CARD — post da galeria social.
 *
 * Feito à mão de propósito: widget de terceiro carrega iframe, script externo
 * e mata o Lighthouse. Aqui é só next/image + link.
 *
 * O véu de hover mostrava CURTIDAS e "N peças marcadas". Os dois saíram em
 * 10/08/2026: a contagem era inventada (prova social fabricada, mesmo motivo
 * que tirou os depoimentos do ar) e as peças marcadas apontavam pro catálogo
 * de maquete — o card oferecia atalho de compra pra produto inexistente.
 * Ver o comentário de `instagramPosts` em `data/content.ts`.
 */

export function InstagramCard({
  post,
  className,
}: {
  post: InstagramPost;
  className?: string;
}) {
  return (
    <a
      href={post.permalink}
      target="_blank"
      rel="noopener noreferrer"
      // Clique no Instagram é sinal de intenção de marca — entra no mesmo
      // conjunto de eventos que a conta de anúncio das lojas otimiza.
      onClick={() => trackInstagramClick('home_grid')}
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

      {/* Véu de hover — o convite pro perfil. Antes ele exibia contagem de
          curtidas e "N peças marcadas"; os dois números eram inventados e
          saíram (ver o cabeçalho). O que ficou é só o gesto de que o card leva
          a algum lugar. */}
      <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-ink/70 via-ink/10 to-transparent p-4 opacity-0 transition-opacity duration-[320ms] group-hover:opacity-100">
        <p className="flex items-center gap-1.5 text-[0.6875rem] font-medium tracking-[0.12em] text-light uppercase">
          <InstagramIcon className="size-3.5" strokeWidth={1.75} />
          Ver no Instagram
        </p>
      </div>
    </a>
  );
}
