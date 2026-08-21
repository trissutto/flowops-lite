import Image from 'next/image';
import { ArrowRight } from 'lucide-react';
import { AppLink } from '@/components/ui/AppLink';

const VLM_222_IMAGE =
  'https://pub-84da472609374e0ab161fd54571b5f38.r2.dev/produtos/VLM-222/PRETO/1787276763271-ChatGPT_Image_20_de_ago._de_2026__22_45_31.jpg';

/** Oferta principal responsiva da home, com uma única foto nos dois layouts. */
export function HomeVlm222Hero({ href }: { href: string }) {
  return (
    <>
      <section className="relative hidden h-[clamp(26rem,25vw,31rem)] w-full overflow-hidden bg-[#eee5da] lg:block" aria-labelledby="vlm222-desktop-hero-title">
        <h1 id="vlm222-desktop-hero-title" className="sr-only">
          Elegância em movimento — Vestido Longo VLM-222
        </h1>
        <AppLink href={href} className="group absolute inset-0 grid grid-cols-[46%_54%] focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-primary">
          <div className="relative z-10 flex flex-col justify-center bg-[#f5eee6] px-[clamp(3rem,6vw,8rem)] text-ink">
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
          <div className="relative min-w-0 overflow-hidden bg-[#d9c9b9]">
            <Image
              src={VLM_222_IMAGE}
              alt="Modelo usando vestido longo preto VLM-222"
              fill
              quality={86}
              priority
              fetchPriority="high"
              sizes="54vw"
              className="object-cover object-[center_28%] transition-transform duration-700 group-hover:scale-[1.006]"
            />
          </div>
        </AppLink>
      </section>

      <section className="relative min-h-[31rem] overflow-hidden bg-[#eee5da] lg:hidden" aria-labelledby="vlm222-hero-title">
      <AppLink href={href} className="group absolute inset-0 block focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-primary">
        <div className="absolute inset-0 bg-[linear-gradient(105deg,#f5efe8_0%,#eee4d8_52%,#ddd0c1_100%)]" />
        <div className="absolute inset-y-0 left-[47%] hidden w-px bg-white/65 shadow-[30px_0_75px_35px_rgba(255,255,255,0.32)] lg:block" />
        <div className="absolute inset-x-0 bottom-0 h-[22%] border-t border-[#cdbca8]/45 bg-[linear-gradient(180deg,rgba(220,206,190,0.28),rgba(205,189,171,0.68))] lg:h-[22%]" />
        <div className="absolute right-[-28%] bottom-[7%] h-[22rem] w-[22rem] rounded-full bg-white/35 blur-3xl lg:right-[3%] lg:bottom-[10%] lg:h-[23rem] lg:w-[23rem]" />

        {/* A mesma imagem atende os dois breakpoints; só posição e tamanho
            mudam. Isso evita baixar uma arte mobile adicional no LCP. */}
        <Image
          src={VLM_222_IMAGE}
          alt="Modelo usando vestido longo preto VLM-222"
          width={700}
          height={1000}
          quality={95}
          priority
          fetchPriority="high"
          sizes="(max-width: 1023px) 72vw, 42vw"
          className="absolute right-[-12%] bottom-0 h-[25rem] w-auto max-w-[75%] object-contain object-bottom drop-shadow-[0_24px_26px_rgba(57,42,28,0.15)] transition-transform duration-700 group-hover:scale-[1.012] sm:right-[-5%] sm:h-[28rem] lg:right-[5%] lg:h-[33rem] lg:max-w-[44%]"
        />

        {/* No celular o véu dá contraste ao texto sem apagar a modelo. */}
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(246,240,233,0.98)_0%,rgba(246,240,233,0.92)_42%,rgba(246,240,233,0.08)_74%)] lg:hidden" />

        <div className="relative z-10 mx-auto flex min-h-[31rem] max-w-[90rem] items-start px-5 py-8 sm:px-8 lg:min-h-[34rem] lg:items-center lg:px-10 lg:py-0 xl:px-16">
          <div className="w-[62%] max-w-[14.5rem] lg:w-auto lg:max-w-[38rem] lg:pb-6">
            <p className="eyebrow text-primary-strong">Linha conforto</p>
            <h1 id="vlm222-hero-title" className="mt-3 font-display text-[2.2rem] leading-[0.94] tracking-[-0.035em] text-ink sm:text-[2.8rem] lg:mt-5 lg:max-w-[35rem] lg:text-[clamp(3.2rem,4.8vw,5.6rem)]">
              Conforto em sua forma mais elegante
            </h1>
            <div className="mt-5 flex flex-col items-start gap-1 lg:mt-7 lg:flex-row lg:items-end lg:gap-5">
              <p className="text-sm font-light text-ink-soft lg:pb-1 lg:text-lg">
                de <span className="line-through">R$ 239,90</span>
              </p>
              <p className="font-display text-[2.25rem] leading-none text-ink lg:text-[3rem]">
                <span className="mr-1 font-sans text-sm font-medium lg:text-lg">por R$</span>139,90
              </p>
            </div>
            <span className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-sm bg-ink px-5 text-[0.65rem] font-medium tracking-[0.12em] text-light uppercase transition-colors group-hover:bg-primary-strong lg:mt-8 lg:min-h-12 lg:gap-3 lg:px-8 lg:text-xs lg:tracking-[0.14em]">
              Comprar agora
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" aria-hidden />
            </span>
          </div>
        </div>
      </AppLink>
      </section>
    </>
  );
}
