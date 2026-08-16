'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
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

/**
 * Miniatura POR COR (pedido do dono, 06/08): em peça com várias cores, a
 * barra lateral deixa de listar foto por foto — vira uma miniatura por cor,
 * e clicar TROCA A COR INTEIRA (galeria, preço e grade), igual à bolinha.
 * As demais fotos da cor ficam nas setas/contador da foto grande.
 */
export interface GrupoDeCor {
  nome: string;
  capa: string;
  ativa: boolean;
  onSelect: () => void;
}

export function ProductGallery({
  images,
  name,
  autoPlay = false,
  grupos,
}: {
  images: Media[];
  name: string;
  /** Passa as fotos sozinha a cada 4,5s — e para no primeiro sinal de interesse. */
  autoPlay?: boolean;
  /** Presente (2+) = barra lateral vira "uma miniatura por cor". */
  grupos?: GrupoDeCor[];
}) {
  const [active, setActive] = useState(0);
  const [parado, setParado] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const safeImages = images.length > 0 ? images : [{ src: '', alt: name }];
  const current = safeImages[active];

  function step(delta: number) {
    setZoomed(false);
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
              /**
               * QUALIDADE 90, e não o padrão 75 do Next.
               *
               * A foto do produto é o produto: é nela que a cliente decide se
               * o caimento serve. Medido em 13/08 na VLM-222 — a mesma foto em
               * AVIF sai com 11,4 KB a 75 e 15,5 KB a 90. Quatro quilobytes
               * pela textura do tecido é troca óbvia; 75 é ajuste de banner.
               */
              quality={90}
              /**
               * ⚠️ NÃO INFLAR ISTO. Tentei 70vw em 13/08 pra a lupa (que
               * amplia 1,7×) e o efeito foi a FOTO SUMIR da PDP.
               *
               * Cada largura nova é uma otimização a frio: a Vercel busca o
               * arquivo no R2 e reencoda na hora, e o domínio público do R2
               * responde **429 quando é puxado em paralelo** — a imagem falha
               * e o quadro vira texto alternativo. Com fonte de 700px ainda
               * por cima não havia ganho nenhum: w=1280, w=1920 e w=2400
               * devolvem os mesmos 21,8 KB, porque o teto é o arquivo.
               *
               * Aqui fica o tamanho REAL do quadro. Quando as fotos de
               * 1400×2000 entrarem, a nitidez vem delas — não de pedir uma
               * largura que o arquivo não tem.
               */
              sizes="(max-width: 1024px) 100vw, 45vw"
              placeholder="blur"
              blurDataURL={BLUR_DATA_URL}
              className={cn(
                'object-cover transition-transform duration-500',
                zoomed && 'scale-[1.7] cursor-zoom-out',
              )}
            />
          </motion.div>
        ) : (
          <div className="grain size-full bg-gradient-to-br from-champagne to-surface-alt" />
        )}

        {current.src && (
          <button
            type="button"
            onClick={() => setZoomed((value) => !value)}
            aria-label={zoomed ? 'Reduzir foto' : 'Ampliar foto'}
            aria-pressed={zoomed}
            className="absolute top-4 right-4 z-[2] flex size-11 items-center justify-center rounded-pill bg-surface/90 text-ink backdrop-blur transition-colors hover:bg-surface"
          >
            {zoomed ? <ZoomOut className="size-4" /> : <ZoomIn className="size-4" />}
          </button>
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

      {/* Miniaturas: uma POR COR quando a peça tem variações; senão, por foto.

          A coluna é um trilho que ROLA DENTRO da altura da foto: o `absolute`
          tira as miniaturas do cálculo de altura, então uma peça de 8 cores
          não estica a galeria pra baixo — ela rola ali mesmo, do lado da
          foto. Sem isso, cada cor a mais devolveria a rolagem que a mudança
          de 15/08 veio eliminar. */}
      {grupos && grupos.length > 1 ? (
        <div className="relative w-14 shrink-0 lg:w-20">
        <div
          className="no-scrollbar absolute inset-0 flex flex-col gap-3 overflow-y-auto"
          role="tablist"
          aria-label="Cores da peça"
        >
          {grupos.map((g) => (
            <button
              key={g.nome}
              type="button"
              role="tab"
              aria-selected={g.ativa}
              aria-label={`Cor ${g.nome}`}
              title={g.nome}
              onClick={g.onSelect}
              className="w-full shrink-0"
            >
              <span
                className={cn(
                  'relative block aspect-3/4 overflow-hidden rounded-md border transition-all duration-[320ms]',
                  g.ativa
                    ? 'border-primary opacity-100'
                    : 'border-transparent opacity-65 hover:opacity-100',
                )}
              >
                <Image
                  src={g.capa}
                  alt=""
                  aria-hidden
                  fill
                  sizes="80px"
                  placeholder="blur"
                  blurDataURL={BLUR_DATA_URL}
                  className="object-cover"
                />
              </span>
              <span
                className={cn(
                  'mt-1 block truncate text-center text-[0.625rem] leading-tight transition-colors',
                  g.ativa ? 'text-ink' : 'text-ink-muted',
                )}
              >
                {g.nome}
              </span>
            </button>
          ))}
        </div>
        </div>
      ) : safeImages.length > 1 && (
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
              onClick={() => {
                setZoomed(false);
                setActive(index);
              }}
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
