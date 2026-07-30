'use client';

import Image from 'next/image';
import { motion, useScroll, useTransform } from 'framer-motion';
import { useRef } from 'react';
import { Button, type ButtonVariant } from '@/components/ui/Button';
import { Container } from '@/components/layout/Container';
import { BLUR_DATA_URL, cn } from '@/lib/utils';
import { fadeUp, reveal } from '@/lib/motion';
import type { Media } from '@/types';

/**
 * CTA BANNER — bloco largo de chamada. Pouco texto, muita imagem.
 *
 * Usado tanto na home (convite pra visitar loja) quanto intercalado na
 * listagem de categoria (quebra o ritmo da grade de produtos).
 */

interface CTABannerProps {
  image?: Media;
  eyebrow?: string;
  title: React.ReactNode;
  description?: string;
  primaryAction?: { label: string; href: string; variant?: ButtonVariant; external?: boolean };
  secondaryAction?: { label: string; href: string; variant?: ButtonVariant; external?: boolean };
  align?: 'left' | 'center';
  height?: 'md' | 'lg';
  className?: string;
}

export function CTABanner({
  image,
  eyebrow,
  title,
  description,
  primaryAction,
  secondaryAction,
  align = 'center',
  height = 'md',
  className,
}: CTABannerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  const y = useTransform(scrollYProgress, [0, 1], ['-6%', '6%']);

  return (
    <div
      ref={ref}
      className={cn(
        'relative flex items-center overflow-hidden',
        height === 'md' ? 'min-h-[52svh]' : 'min-h-[68svh]',
        className,
      )}
    >
      <motion.div style={{ y }} className="absolute inset-[-6%]">
        {image ? (
          <Image
            src={image.src}
            alt={image.alt}
            fill
            sizes="100vw"
            placeholder="blur"
            blurDataURL={BLUR_DATA_URL}
            className="object-cover"
          />
        ) : (
          <div className="grain size-full bg-gradient-to-br from-secondary via-ink to-ink" />
        )}
      </motion.div>
      <div className="absolute inset-0 bg-gradient-to-r from-ink/70 via-ink/45 to-ink/25" />

      <Container width="page" className="relative z-10 py-20">
        <motion.div
          {...reveal(fadeUp)}
          className={cn('flex flex-col', align === 'center' ? 'items-center text-center' : 'items-start')}
        >
          {eyebrow && <p className="eyebrow text-primary-soft">{eyebrow}</p>}
          <h2 className="mt-5 max-w-2xl text-h1 text-light">{title}</h2>
          {description && (
            <p className="mt-6 max-w-xl text-body-lg font-light text-light/80">{description}</p>
          )}
          {(primaryAction || secondaryAction) && (
            <div
              className={cn(
                'mt-10 flex w-full flex-col gap-3 sm:w-auto sm:flex-row',
                align === 'center' && 'sm:justify-center',
              )}
            >
              {primaryAction && (
                <Button
                  href={primaryAction.href}
                  external={primaryAction.external}
                  variant={primaryAction.variant ?? 'light'}
                  size="lg"
                  block
                  className="sm:w-auto"
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
                  block
                  className="sm:w-auto"
                >
                  {secondaryAction.label}
                </Button>
              )}
            </div>
          )}
        </motion.div>
      </Container>
    </div>
  );
}
