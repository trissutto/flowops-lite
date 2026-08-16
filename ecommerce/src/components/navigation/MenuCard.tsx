import Image from 'next/image';
import { AppLink as Link } from '@/components/ui/AppLink';
import { ArrowRight } from 'lucide-react';
import { BLUR_DATA_URL, cn } from '@/lib/utils';
import type { MenuFeature } from '@/types';

/**
 * MenuCard — card editorial dentro do mega menu. É o que impede o menu de
 * parecer uma lista de links: um convite, com foto quando ela existe.
 *
 * SEM FOTO O CARD CONTINUA (16/08/2026). Os quatro cards do menu eram
 * ilustrados com banco de imagem e saíram junto com o resto do stock — o
 * convite ("Descubra a sua numeração", "Ver guia de medidas") é o que
 * importa, e ele não depende da foto. No lugar dela entra a arte tipográfica
 * da casa: champagne com o monograma. Preencher `feature.image` com foto de
 * campanha NOSSA devolve a imagem sozinho.
 */
export function MenuCard({ feature, className }: { feature: MenuFeature; className?: string }) {
  return (
    <Link
      href={feature.href}
      className={cn('group block overflow-hidden rounded-md bg-surface-alt', className)}
    >
      <div className="relative aspect-4/3 overflow-hidden">
        {feature.image ? (
          <>
            <Image
              src={feature.image.src}
              alt={feature.image.alt}
              fill
              sizes="(max-width: 1024px) 50vw, 320px"
              placeholder="blur"
              blurDataURL={BLUR_DATA_URL}
              className="object-cover transition-transform duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.04]"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-ink/45 via-transparent to-transparent" />
          </>
        ) : (
          <div
            className="grain size-full bg-gradient-to-br from-champagne via-surface-alt to-background"
            aria-hidden
          >
            <span className="absolute inset-0 flex items-center justify-center font-display text-6xl italic text-primary/25 transition-transform duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.06]">
              L
            </span>
          </div>
        )}
      </div>
      <div className="p-5">
        {feature.eyebrow && <p className="eyebrow text-primary-strong">{feature.eyebrow}</p>}
        <h4 className="mt-2 font-display text-h4 text-ink">{feature.title}</h4>
        {feature.description && (
          <p className="mt-1.5 text-small font-light text-ink-soft">{feature.description}</p>
        )}
        {feature.cta && (
          <span className="mt-4 inline-flex items-center gap-2 text-[0.6875rem] font-medium tracking-[0.16em] text-ink uppercase">
            {feature.cta}
            <ArrowRight className="size-3.5 transition-transform duration-[320ms] group-hover:translate-x-1" />
          </span>
        )}
      </div>
    </Link>
  );
}
