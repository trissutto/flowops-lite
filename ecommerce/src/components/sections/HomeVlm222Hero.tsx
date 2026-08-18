'use client';

import { getImageProps } from 'next/image';
import { preload } from 'react-dom';
import { ArrowRight } from 'lucide-react';
import { AppLink } from '@/components/ui/AppLink';

const VLM_222_IMAGE =
  'https://pub-84da472609374e0ab161fd54571b5f38.r2.dev/produtos/VLM-222/PRETO/1786674440424-modelo-oficial-vestido-preto-pele-textura-natural-700x1000.png';
const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

/** Oferta principal da home no desktop, sem baixar a foto no celular. */
export function HomeVlm222Hero({ href }: { href: string }) {
  const image = getImageProps({
    src: VLM_222_IMAGE,
    alt: 'Modelo usando vestido longo preto VLM-222',
    width: 700,
    height: 1000,
    quality: 95,
    sizes: '(min-width: 1024px) 42vw, 1px',
  });

  preload(image.props.src, {
    as: 'image',
    media: '(min-width: 1024px)',
    imageSrcSet: image.props.srcSet,
    imageSizes: '(min-width: 1024px) 42vw, 1px',
    fetchPriority: 'high',
  });

  return (
    <section className="relative hidden min-h-[34rem] overflow-hidden bg-[#eee5da] lg:block" aria-labelledby="vlm222-hero-title">
      <AppLink href={href} className="group absolute inset-0 block focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-primary">
        <div className="absolute inset-0 bg-[linear-gradient(105deg,#f5efe8_0%,#eee4d8_52%,#ddd0c1_100%)]" />
        <div className="absolute inset-y-0 left-[47%] w-px bg-white/65 shadow-[30px_0_75px_35px_rgba(255,255,255,0.32)]" />
        <div className="absolute inset-x-0 bottom-0 h-[22%] border-t border-[#cdbca8]/45 bg-[linear-gradient(180deg,rgba(220,206,190,0.28),rgba(205,189,171,0.68))]" />
        <div className="absolute right-[3%] bottom-[10%] h-[23rem] w-[23rem] rounded-full bg-white/30 blur-3xl" />

        <div className="relative z-10 mx-auto grid min-h-[34rem] max-w-[90rem] grid-cols-[1.05fr_0.95fr] items-center px-10 xl:px-16">
          <div className="max-w-[38rem] pb-6">
            <p className="eyebrow text-primary-strong">Linha conforto</p>
            <h1 id="vlm222-hero-title" className="mt-5 max-w-[35rem] font-display text-[clamp(3.2rem,4.8vw,5.6rem)] leading-[0.94] tracking-[-0.035em] text-ink">
              Conforto em sua forma mais elegante
            </h1>
            <div className="mt-7 flex items-end gap-5">
              <p className="pb-1 text-lg font-light text-ink-soft">
                de <span className="line-through">R$ 239,90</span>
              </p>
              <p className="font-display text-[3rem] leading-none text-ink">
                <span className="mr-1 font-sans text-lg font-medium">por R$</span>139,90
              </p>
            </div>
            <span className="mt-8 inline-flex min-h-12 items-center gap-3 rounded-sm bg-ink px-8 text-xs font-medium tracking-[0.14em] text-light uppercase transition-colors group-hover:bg-primary-strong">
              Comprar agora
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" aria-hidden />
            </span>
          </div>

          <div className="relative h-[34rem] self-end">
            <picture>
              <source media="(min-width: 1024px)" srcSet={image.props.srcSet} />
              <img
                src={TRANSPARENT_PIXEL}
                alt="Modelo usando vestido longo preto VLM-222"
                width={700}
                height={1000}
                decoding="sync"
                fetchPriority="high"
                className="absolute inset-x-0 bottom-0 mx-auto h-[33rem] w-auto max-w-full object-contain object-bottom drop-shadow-[0_24px_26px_rgba(57,42,28,0.15)] transition-transform duration-700 group-hover:scale-[1.012]"
              />
            </picture>
          </div>
        </div>
      </AppLink>
    </section>
  );
}
