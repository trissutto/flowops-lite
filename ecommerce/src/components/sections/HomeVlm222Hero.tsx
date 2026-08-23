import { getImageProps } from 'next/image';
import { preload } from 'react-dom';
import { ArrowRight } from 'lucide-react';
import { AppLink } from '@/components/ui/AppLink';

const VLM_222_DESKTOP_IMAGE =
  'https://pub-84da472609374e0ab161fd54571b5f38.r2.dev/produtos/VLM-222/PRETO/1787276763271-ChatGPT_Image_20_de_ago._de_2026__22_45_31.jpg';
const VLM_222_MOBILE_IMAGE = '/banners/vlm222-mobile-700.webp';

/**
 * Uma única imagem responsiva para os dois layouts. Antes havia dois <Image>
 * prioritários escondidos por CSS; o HTML emitia preload dos dois e o celular
 * disputava banda com a arte desktop mesmo sem exibi-la.
 */
function ResponsiveHeroImage() {
  const desktop = getImageProps({
    src: VLM_222_DESKTOP_IMAGE,
    alt: 'Modelo usando vestido longo preto VLM-222',
    width: 1200,
    height: 1200,
    quality: 86,
    sizes: '54vw',
    decoding: 'sync',
    className: 'h-full w-full object-contain object-center transition-transform duration-700 group-hover:scale-[1.006] lg:object-center',
  });
  const mobile = getImageProps({
    src: VLM_222_MOBILE_IMAGE,
    alt: 'Modelo usando vestido longo preto VLM-222',
    width: 700,
    height: 1000,
    unoptimized: true,
    sizes: '72vw',
    decoding: 'sync',
  });

  // Os hints chegam ao <head>, mas as media queries são excludentes: cada
  // viewport baixa somente a fonte que o <picture> efetivamente usará.
  preload(mobile.props.src, {
    as: 'image',
    media: '(max-width: 1023px)',
    imageSrcSet: mobile.props.srcSet,
    imageSizes: '72vw',
    fetchPriority: 'high',
  });
  preload(desktop.props.src, {
    as: 'image',
    media: '(min-width: 1024px)',
    imageSrcSet: desktop.props.srcSet,
    imageSizes: '54vw',
    fetchPriority: 'high',
  });

  return (
    <picture className="block h-full w-full">
      <source
        media="(max-width: 1023px)"
        srcSet={mobile.props.srcSet ?? mobile.props.src}
        width={700}
        height={1000}
      />
      {/* eslint-disable-next-line jsx-a11y/alt-text */}
      <img {...desktop.props} fetchPriority="high" />
    </picture>
  );
}

/** Oferta principal responsiva da home, sem download duplicado no LCP. */
export function HomeVlm222Hero({ href }: { href: string }) {
  return (
    <section
      className="relative min-h-[31rem] w-full overflow-hidden bg-[#eee5da] lg:h-[clamp(26rem,25vw,31rem)] lg:min-h-0"
      aria-labelledby="vlm222-hero-title"
    >
      <h1 id="vlm222-hero-title" className="sr-only">
        Elegância e conforto — Vestido Longo VLM-222
      </h1>
      <AppLink
        href={href}
        className="group absolute inset-0 block focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-primary lg:grid lg:grid-cols-[46%_54%]"
      >
        {/* Cenário mobile; no desktop os dois painéis abaixo formam a arte. */}
        <div className="absolute inset-0 bg-[linear-gradient(105deg,#f5efe8_0%,#eee4d8_52%,#ddd0c1_100%)] lg:hidden" />
        <div className="absolute inset-x-0 bottom-0 h-[22%] border-t border-[#cdbca8]/45 bg-[linear-gradient(180deg,rgba(220,206,190,0.28),rgba(205,189,171,0.68))] lg:hidden" />
        <div className="absolute right-[-28%] bottom-[7%] h-[22rem] w-[22rem] rounded-full bg-white/35 blur-3xl lg:hidden" />

        {/* Texto desktop. */}
        <div className="relative z-10 hidden flex-col justify-center bg-[#f5eee6] px-[clamp(3rem,6vw,8rem)] text-ink lg:flex">
          <p className="text-[clamp(0.65rem,0.72vw,0.9rem)] font-semibold tracking-[0.08em] uppercase">Nova coleção</p>
          <p className="mt-4 font-display text-[clamp(3rem,3.7vw,4.8rem)] leading-[0.96] tracking-[-0.035em]">
            Elegância em<br />movimento
          </p>
          <p className="mt-5 text-[clamp(0.9rem,1.15vw,1.35rem)] tracking-[0.01em]">VESTIDO LONGO VLM-222</p>
          <p className="mt-2 text-[clamp(0.8rem,0.95vw,1.1rem)] text-ink-soft">Caimento fluido, conforto e elegância.</p>
          <span className="mt-8 w-fit bg-ink px-7 py-4 text-xs font-semibold tracking-[0.08em] text-light uppercase transition-colors group-hover:bg-primary-strong">
            Compre agora
          </span>
        </div>

        {/* Um único picture: absoluto no mobile, segundo painel no desktop. */}
        <div className="absolute right-[-12%] bottom-0 h-[25rem] w-[75%] min-w-0 overflow-hidden drop-shadow-[0_24px_26px_rgba(57,42,28,0.15)] sm:right-[-5%] sm:h-[28rem] lg:relative lg:right-auto lg:bottom-auto lg:h-full lg:w-full lg:bg-[#2b211c] lg:drop-shadow-none">
          <ResponsiveHeroImage />
        </div>

        {/* Contraste e texto mobile. */}
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(246,240,233,0.98)_0%,rgba(246,240,233,0.92)_42%,rgba(246,240,233,0.08)_74%)] lg:hidden" />
        <div className="relative z-10 mx-auto flex min-h-[31rem] items-start px-5 py-8 sm:px-8 lg:hidden">
          <div className="w-[62%] max-w-[14.5rem]">
            <p className="eyebrow text-primary-strong">Linha conforto</p>
            <p className="mt-3 font-display text-[2.2rem] leading-[0.94] tracking-[-0.035em] text-ink sm:text-[2.8rem]">
              Conforto em sua forma mais elegante
            </p>
            <div className="mt-5 flex flex-col items-start gap-1">
              <p className="text-sm font-light text-ink-soft">de <span className="line-through">R$ 239,90</span></p>
              <p className="font-display text-[2.25rem] leading-none text-ink">
                <span className="mr-1 font-sans text-sm font-medium">por R$</span>139,90
              </p>
            </div>
            <span className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-sm bg-ink px-5 text-[0.65rem] font-medium tracking-[0.12em] text-light uppercase transition-colors group-hover:bg-primary-strong">
              Comprar agora
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" aria-hidden />
            </span>
          </div>
        </div>
      </AppLink>
    </section>
  );
}
