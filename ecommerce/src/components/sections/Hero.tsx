'use client';

import Image from 'next/image';
import { motion, useScroll, useTransform } from 'framer-motion';
import { useRef } from 'react';
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

export type HeroHeight = 'small' | 'medium' | 'large' | 'fullscreen';
export type HeroAlign = 'left' | 'center' | 'right';

const HEIGHTS: Record<HeroHeight, string> = {
  small: 'min-h-[42svh] lg:min-h-[46svh]',
  medium: 'min-h-[62svh] lg:min-h-[68svh]',
  large: 'min-h-[82svh] lg:min-h-[86svh]',
  fullscreen: 'min-h-[100svh]',
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
  video?: VideoMedia;
  eyebrow?: string;
  title: React.ReactNode;
  subtitle?: string;
  primaryAction?: HeroAction;
  secondaryAction?: HeroAction;
  height?: HeroHeight;
  align?: HeroAlign;
  /** Intensidade do véu escuro sobre a mídia. */
  overlay?: 'none' | 'soft' | 'medium' | 'strong';
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
  // 12% de deslocamento — o suficiente pra dar profundidade sem "descolar".
  const y = useTransform(scrollYProgress, [0, 1], ['0%', parallax ? '12%' : '0%']);

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
          className="size-full"
        >
          {video ? (
            <video
              src={video.src}
              poster={video.poster}
              autoPlay
              muted
              loop
              playsInline
              aria-label={video.alt}
              className="size-full object-cover"
            />
          ) : image ? (
            <Image
              src={image.src}
              alt={image.alt}
              fill
              priority={priority}
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
