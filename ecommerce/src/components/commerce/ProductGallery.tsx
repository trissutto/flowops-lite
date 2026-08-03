'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { BLUR_DATA_URL, cn } from '@/lib/utils';
import { transition } from '@/lib/motion';
import type { Media } from '@/types';

/**
 * Galeria do produto.
 *
 * Desktop: miniaturas verticais à esquerda + foto grande.
 * Mobile: carrossel com scroll-snap nativo (gesto que a cliente já conhece)
 * e bullets — sem JS de arraste.
 *
 * A foto é o argumento de venda: proporção 3/4 e `priority` na primeira,
 * que é o LCP da página.
 */
export function ProductGallery({
  images,
  name,
  autoPlay = false,
}: {
  images: Media[];
  name: string;
  /** Passa as fotos sozinha a cada 4,5s — e para no primeiro sinal de interesse. */
  autoPlay?: boolean;
}) {
  const [active, setActive] = useState(0);
  const [parado, setParado] = useState(false);
  const safeImages = images.length > 0 ? images : [{ src: '', alt: name }];
  const current = safeImages[active];

  function step(delta: number) {
    setActive((i) => (i + delta + safeImages.length) % safeImages.length);
  }

  /**
   * Autoplay: mostra o caimento de vários ângulos (e as outras cores da peça)
   * sem a cliente precisar clicar.
   *
   * PARA no primeiro sinal de interesse — mouse em cima ou toque — e não
   * volta. Carrossel que continua andando enquanto a pessoa tenta olhar uma
   * foto é pior que carrossel nenhum: o automático serve pra quem está
   * passando o olho, não pra quem já parou pra decidir.
   */
  useEffect(() => {
    if (!autoPlay || parado || safeImages.length < 2) return;
    const timer = setInterval(() => {
      setActive((i) => (i + 1) % safeImages.length);
    }, 4500);
    return () => clearInterval(timer);
  }, [autoPlay, parado, safeImages.length]);

  return (
    <div
      className="flex flex-col gap-4 lg:flex-row-reverse lg:gap-6"
      onPointerDown={() => setParado(true)}
      onMouseEnter={() => setParado(true)}
    >
      {/* Foto principal */}
      <div className="relative aspect-3/4 flex-1 overflow-hidden rounded-lg bg-surface-alt">
        {current.src ? (
          <motion.div
            key={current.src}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={transition.base}
            className="absolute inset-0"
          >
            <Image
              src={current.src}
              alt={current.alt}
              fill
              priority={active === 0}
              sizes="(max-width: 1024px) 100vw, 45vw"
              placeholder="blur"
              blurDataURL={BLUR_DATA_URL}
              className="object-cover"
            />
          </motion.div>
        ) : (
          <div className="grain size-full bg-gradient-to-br from-champagne to-surface-alt" />
        )}

        {safeImages.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label="Foto anterior"
              className="absolute top-1/2 left-4 flex size-10 -translate-y-1/2 items-center justify-center rounded-pill bg-surface/85 text-ink backdrop-blur transition-colors hover:bg-surface"
            >
              <ChevronLeft className="size-4" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label="Próxima foto"
              className="absolute top-1/2 right-4 flex size-10 -translate-y-1/2 items-center justify-center rounded-pill bg-surface/85 text-ink backdrop-blur transition-colors hover:bg-surface"
            >
              <ChevronRight className="size-4" strokeWidth={1.75} />
            </button>
            <span className="tabular absolute right-4 bottom-4 rounded-pill bg-ink/70 px-3 py-1 text-[0.625rem] text-light backdrop-blur">
              {active + 1}/{safeImages.length}
            </span>
          </>
        )}
      </div>

      {/* Miniaturas */}
      {safeImages.length > 1 && (
        <div
          className="no-scrollbar flex gap-3 overflow-x-auto lg:w-20 lg:flex-col lg:overflow-visible"
          role="tablist"
          aria-label="Fotos do produto"
        >
          {safeImages.map((image, index) => (
            <button
              key={`${image.src}-${index}`}
              type="button"
              role="tab"
              aria-selected={index === active}
              aria-label={`Ver foto ${index + 1}`}
              onClick={() => setActive(index)}
              className={cn(
                'relative aspect-3/4 w-16 shrink-0 overflow-hidden rounded-md border transition-all duration-[320ms] lg:w-full',
                index === active
                  ? 'border-primary opacity-100'
                  : 'border-transparent opacity-65 hover:opacity-100',
              )}
            >
              {image.src && (
                <Image
                  src={image.src}
                  alt=""
                  aria-hidden
                  fill
                  sizes="80px"
                  placeholder="blur"
                  blurDataURL={BLUR_DATA_URL}
                  className="object-cover"
                />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
