'use client';

import Image, { getImageProps } from 'next/image';
import { motion, useScroll, useTransform } from 'framer-motion';
import { forwardRef, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button, type ButtonVariant } from '@/components/ui/Button';
import { Container } from '@/components/layout/Container';
import { BLUR_DATA_URL, cn } from '@/lib/utils';
import { EASE_LURDS, transition } from '@/lib/motion';
import type { Media, VideoMedia } from '@/types';

/**
 * HERO EDITORIAL — o componente mais importante da linguagem visual.
 *
 * Configurável em imagem OU vídeo, quatro alturas, três alinhamentos, dois
 * CTAs. Traz de fábrica:
 *   - zoom-out lento de 2,2s na entrada (dá "peso" cinematográfico)
 *   - parallax leve no scroll (12% de deslocamento — nunca mais que isso)
 *   - gradiente ancorando o texto sem apagar a foto
 *
 * Regra: pouquíssimo texto. Título curto, uma linha de apoio, dois botões.
 */

/**
 * `arte` = A ARTE MANDA NA ALTURA (dono 07/08).
 *
 * Os outros modos fixam a altura e recortam a foto (`object-cover`) — certo pra
 * foto editorial, onde perder um pedaço da borda não custa nada. Errado pra
 * BANNER DE CAMPANHA: a arte já vem com texto e logo dentro, e o recorte comeu
 * o "Indomável" nas duas pontas. Aqui a seção assume a proporção da imagem, e
 * a campanha aparece inteira em qualquer tela — que é o que "se adaptar ao
 * tamanho da tela" quer dizer pra quem desenhou o banner.
 */
export type HeroHeight = 'small' | 'medium' | 'large' | 'fullscreen' | 'arte';
export type HeroAlign = 'left' | 'center' | 'right';
export type HeroOverlay = 'none' | 'soft' | 'medium' | 'strong';

const HEIGHTS: Record<HeroHeight, string> = {
  small: 'min-h-[42svh] lg:min-h-[46svh]',
  medium: 'min-h-[62svh] lg:min-h-[68svh]',
  large: 'min-h-[82svh] lg:min-h-[86svh]',
  fullscreen: 'min-h-[100svh]',
  arte: '',
};

const ALIGNMENTS: Record<HeroAlign, string> = {
  left: 'items-start text-left',
  center: 'items-center text-center',
  right: 'items-end text-right',
};

interface HeroAction {
  label: string;
  href: string;
  variant?: ButtonVariant;
  external?: boolean;
}

interface HeroProps {
  image?: Media;
  /** Recorte vertical pro celular (opcional) — arte dirigida. */
  imageMobile?: Media;
  video?: VideoMedia;
  eyebrow?: string;
  title: React.ReactNode;
  subtitle?: string;
  primaryAction?: HeroAction;
  secondaryAction?: HeroAction;
  height?: HeroHeight;
  align?: HeroAlign;
  /** Intensidade do véu escuro sobre a mídia. */
  overlay?: HeroOverlay;
  /** Conteúdo extra acima do título (breadcrumb, por exemplo). */
  above?: React.ReactNode;
  /** Seta de "role pra baixo". */
  showScrollHint?: boolean;
  /** Desliga o parallax (heros pequenos de topo de página). */
  parallax?: boolean;
  /** Hero acima da dobra → prioriza o carregamento da imagem (LCP). */
  priority?: boolean;
  className?: string;
}

const OVERLAYS = {
  none: '',
  soft: 'bg-gradient-to-b from-ink/25 via-ink/10 to-ink/35',
  medium: 'bg-gradient-to-b from-ink/45 via-ink/25 to-ink/55',
  strong: 'bg-gradient-to-b from-ink/60 via-ink/40 to-ink/70',
} as const;

export function Hero({
  image,
  imageMobile,
  video,
  eyebrow,
  title,
  subtitle,
  primaryAction,
  secondaryAction,
  height = 'large',
  align = 'center',
  overlay = 'medium',
  above,
  showScrollHint = false,
  parallax = true,
  priority = false,
  className,
}: HeroProps) {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  // Arte fechada não faz parallax nem zoom: mover a campanha corta a arte de
  // novo — pela borda, em vez de pelo enquadramento. É a mesma perda.
  const arte = height === 'arte';
  const y = useTransform(scrollYProgress, [0, 1], ['0%', parallax && !arte ? '12%' : '0%']);

  if (arte) {
    return (
      <HeroArte
        ref={ref}
        image={image}
        imageMobile={imageMobile}
        priority={priority}
        overlay={overlay}
        align={align}
        eyebrow={eyebrow}
        title={title}
        subtitle={subtitle}
        primaryAction={primaryAction}
        secondaryAction={secondaryAction}
        className={className}
      />
    );
  }

  return (
    <section
      ref={ref}
      className={cn('relative flex items-center overflow-hidden', HEIGHTS[height], className)}
    >
      {/* Mídia */}
      <motion.div style={{ y }} className="absolute inset-0">
        <motion.div
          initial={{ scale: 1.08 }}
          animate={{ scale: 1 }}
          transition={{ duration: 2.2, ease: EASE_LURDS }}
          // `relative` é obrigatório: a mídia usa <Image fill>, que precisa de
          // um pai posicionado. Sem isto o next/image reclama no console e a
          // foto passa a se ancorar no avô — funcionava por coincidência de
          // tamanho, não por desenho.
          className="relative size-full"
        >
          {video ? (
            <>
              {/* Poster pelo next/image, nunca pelo atributo `poster` do
                  <video> — ver o aviso no VideoBlock: o atributo baixa o
                  original cru (megabytes) sem passar pelo otimizador. */}
              <Image
                src={video.poster}
                alt={video.alt}
                fill
                priority={priority}
                fetchPriority={priority ? 'high' : undefined}
                sizes="100vw"
                placeholder="blur"
                blurDataURL={BLUR_DATA_URL}
                className="object-cover object-center"
              />
              <video
                src={video.src}
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
                aria-label={video.alt}
                className="relative size-full object-cover"
              />
            </>
          ) : image && imageMobile ? (
            /**
             * ARTE DIRIGIDA — foto horizontal no computador, recorte vertical
             * no celular.
             *
             * `<picture>` com `getImageProps` em vez de dois `<Image>` com
             * `hidden`: imagem escondida por CSS **continua sendo baixada**
             * pelo navegador, e o hero é o LCP da home — pagar duas vezes ali
             * é o oposto do que a sprint de performance fez.
             *
             * O `<source media>` faz o navegador escolher UM, e o
             * `getImageProps` mantém o srcset otimizado (AVIF/WebP, largura
             * certa) dos dois lados.
             */
            (() => {
              const comum = {
                alt: image.alt,
                fill: true,
                priority,
                sizes: '100vw',
                placeholder: 'blur' as const,
                blurDataURL: BLUR_DATA_URL,
                className: 'object-cover object-center',
              };
              const desktop = getImageProps({ ...comum, src: image.src });
              const mobile = getImageProps({ ...comum, src: imageMobile.src });
              return (
                <picture>
                  <source media="(max-width: 1023px)" srcSet={mobile.props.srcSet} />
                  <source media="(min-width: 1024px)" srcSet={desktop.props.srcSet} />
                  {/* eslint-disable-next-line jsx-a11y/alt-text */}
                  <img {...desktop.props} fetchPriority={priority ? 'high' : undefined} />
                </picture>
              );
            })()
          ) : image ? (
            <Image
              src={image.src}
              alt={image.alt}
              fill
              priority={priority}
              // `priority` sozinho emite o <link rel=preload> SEM
              // fetchpriority (conferido no fonte do next/image 15.5). Sem
              // isto o hero disputa banda em pé de igualdade com todo o resto
              // e o LCP desaba — era o caso da home.
              fetchPriority={priority ? 'high' : undefined}
              sizes="100vw"
              placeholder="blur"
              blurDataURL={BLUR_DATA_URL}
              className="object-cover object-center"
            />
          ) : (
            <div className="grain size-full bg-gradient-to-br from-champagne via-surface-alt to-background" />
          )}
        </motion.div>
      </motion.div>

      {overlay !== 'none' && <div className={cn('absolute inset-0', OVERLAYS[overlay])} />}

      {/* Conteúdo */}
      <Container width="page" className="relative z-10 py-20">
        <div className={cn('flex flex-col', ALIGNMENTS[align])}>
          {above && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...transition.slow, delay: 0.1 }}
              className="mb-8"
            >
              {above}
            </motion.div>
          )}

          {eyebrow && (
            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...transition.slow, delay: 0.2 }}
              className="eyebrow text-primary-soft"
            >
              {eyebrow}
            </motion.p>
          )}

          <motion.h1
            initial={{ opacity: 0, y: 26 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, ease: EASE_LURDS, delay: 0.32 }}
            className="mt-6 max-w-3xl text-display text-light"
          >
            {title}
          </motion.h1>

          {subtitle && (
            <motion.p
              initial={{ opacity: 0, y: 26 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.9, ease: EASE_LURDS, delay: 0.46 }}
              className="mt-7 max-w-xl text-body-lg font-light text-light/85"
            >
              {subtitle}
            </motion.p>
          )}

          {(primaryAction || secondaryAction) && (
            <motion.div
              initial={{ opacity: 0, y: 26 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.9, ease: EASE_LURDS, delay: 0.6 }}
              className={cn(
                'mt-11 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:gap-4',
                align === 'center' && 'sm:justify-center',
                align === 'right' && 'sm:justify-end',
              )}
            >
              {primaryAction && (
                <Button
                  href={primaryAction.href}
                  external={primaryAction.external}
                  variant={primaryAction.variant ?? 'light'}
                  size="lg"
                  className="sm:w-auto"
                  block
                >
                  {primaryAction.label}
                </Button>
              )}
              {secondaryAction && (
                <Button
                  href={secondaryAction.href}
                  external={secondaryAction.external}
                  variant={secondaryAction.variant ?? 'outlineLight'}
                  size="lg"
                  className="sm:w-auto"
                  block
                >
                  {secondaryAction.label}
                </Button>
              )}
            </motion.div>
          )}
        </div>
      </Container>

      {showScrollHint && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.6, duration: 1 }}
          className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2"
        >
          <ChevronDown className="size-6 animate-bounce text-light/75" aria-hidden />
        </motion.div>
      )}
    </section>
  );
}

/**
 * HERO DE ARTE FECHADA — a imagem entra em FLUXO (`w-full h-auto`), então a
 * seção tem exatamente a altura da arte na largura da tela. Sem recorte, sem
 * faixa preta, em qualquer proporção que a retaguarda subir.
 *
 * O texto e os botões continuam existindo (o dono pode querer os dois), mas
 * ficam SOBREPOSTOS em absoluto — nunca esticam a seção. Em tela estreita, o
 * `min-h` do conteúdo garante que os botões não amassem em cima da arte.
 */
const HeroArte = forwardRef<HTMLElement, {
  image?: Media;
  imageMobile?: Media;
  priority?: boolean;
  overlay?: HeroOverlay;
  align?: HeroAlign;
  eyebrow?: string;
  title?: React.ReactNode;
  subtitle?: string;
  primaryAction?: HeroAction;
  secondaryAction?: HeroAction;
  className?: string;
}>(function HeroArte(
  { image, imageMobile, priority, overlay = 'none', align = 'center',
    eyebrow, title, subtitle, primaryAction, secondaryAction, className },
  ref,
) {
  const temTexto = !!(eyebrow || title || subtitle);
  const temBotao = !!(primaryAction || secondaryAction);

  const comum = {
    alt: image?.alt ?? '',
    width: 2400,
    height: 1350,
    priority,
    sizes: '100vw',
    className: 'w-full h-auto',
  };
  const desktop = image ? getImageProps({ ...comum, src: image.src }) : null;
  const mobile = imageMobile ? getImageProps({ ...comum, src: imageMobile.src }) : null;

  return (
    <section ref={ref} className={cn('relative w-full', className)}>
      {/**
       * PRELOAD DO LCP NA MÃO — o `<Image>` emite sozinho, o `getImageProps`
       * NÃO (10/08/2026).
       *
       * Medido no HTML de produção: a home saía com preload de TRÊS FONTES e
       * NENHUM de imagem. O navegador só descobria o banner depois de parsear
       * o HTML, com as fontes já na frente dele na fila. É o formato exato do
       * PageSpeed de hoje — FCP 1,6s (verde) e LCP 4,3s (vermelho): a página
       * aparece rápido e a arte grande chega quase 3s depois.
       *
       * O `fetchPriority` no `<img>` abaixo só age DEPOIS da descoberta; o
       * atraso estava na descoberta.
       *
       * `media` casa com os `<source>` — sem ele o navegador baixaria as DUAS
       * artes e o remédio viraria veneno. `imageSrcSet` preserva a escolha de
       * largura e formato (AVIF/WebP) do otimizador.
       */}
      {priority && desktop && (
        <>
          {mobile && (
            <link
              rel="preload"
              as="image"
              media="(max-width: 1023px)"
              imageSrcSet={mobile.props.srcSet}
              imageSizes="100vw"
              fetchPriority="high"
            />
          )}
          <link
            rel="preload"
            as="image"
            media="(min-width: 1024px)"
            imageSrcSet={desktop.props.srcSet}
            imageSizes="100vw"
            fetchPriority="high"
          />
        </>
      )}

      {desktop && (
        <picture>
          {mobile && <source media="(max-width: 1023px)" srcSet={mobile.props.srcSet} />}
          <source media="(min-width: 1024px)" srcSet={desktop.props.srcSet} />
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <img {...desktop.props} fetchPriority={priority ? 'high' : undefined} />
        </picture>
      )}

      {overlay !== 'none' && <div className={cn('absolute inset-0', OVERLAYS[overlay])} />}

      {/* PERTO DA BASE (dono 07/08). Centralizado, o botão caía em cima do
          "Indomável" — a arte já usa o meio. Embaixo ele fica sobre a área
          calma da foto e vira o último passo natural da leitura. */}
      {(temTexto || temBotao) && (
        <div className="absolute inset-0 flex items-end">
          <Container width="page" className="relative z-10 pb-6 sm:pb-8 lg:pb-12">
            <div className={cn('flex flex-col', ALIGNMENTS[align])}>
              {eyebrow && <p className="eyebrow text-primary-soft">{eyebrow}</p>}
              {title && <h1 className="mt-4 max-w-3xl text-display text-light">{title}</h1>}
              {subtitle && (
                <p className="mt-5 max-w-xl text-body-lg font-light text-light/85">{subtitle}</p>
              )}
              {temBotao && (
                <div
                  className={cn(
                    'mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:gap-4',
                    align === 'center' && 'sm:justify-center',
                    align === 'right' && 'sm:justify-end',
                  )}
                >
                  {primaryAction && (
                    <Button
                      href={primaryAction.href}
                      external={primaryAction.external}
                      variant={primaryAction.variant ?? 'light'}
                      size="lg"
                      className="sm:w-auto"
                      block
                    >
                      {primaryAction.label}
                    </Button>
                  )}
                  {secondaryAction && (
                    <Button
                      href={secondaryAction.href}
                      external={secondaryAction.external}
                      variant={secondaryAction.variant ?? 'outlineLight'}
                      size="lg"
                      className="sm:w-auto"
                      block
                    >
                      {secondaryAction.label}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Container>
        </div>
      )}
    </section>
  );
});
