'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { BLUR_DATA_URL, cn } from '@/lib/utils';
import { fadeUp, reveal } from '@/lib/motion';
import { useNearViewport } from '@/hooks';
import type { VideoMedia } from '@/types';

/**
 * VIDEO BLOCK — vídeo institucional grande.
 *
 * Autoplay em mute + loop + playsInline (única combinação que os navegadores
 * permitem autoplay). O poster carrega via next/image, então o bloco já tem
 * imagem antes do primeiro frame — sem retângulo preto.
 *
 * Controles mínimos (play/pause e som) porque autoplay sem controle de pausa
 * é violação de acessibilidade (WCAG 2.2.2).
 *
 * ⚠️ NUNCA passar `poster` pro <video>. O atributo aceita só uma URL crua, sem
 * passar pelo next/image, e o browser baixa o original inteiro — a foto do
 * Unsplash usada aqui pesa 4,9 MB e sozinha respondia por 90% do peso da home
 * (PageSpeed de 31/07: 5.448 KB no total). O poster é o <Image> abaixo, que
 * sai otimizado e no tamanho certo. O <video> só monta quando o bloco chega
 * perto da viewport, então no carregamento da home ele não custa nada.
 */

interface VideoBlockProps {
  video: VideoMedia;
  eyebrow?: string;
  title?: React.ReactNode;
  caption?: string;
  aspect?: '16/9' | '21/9' | '4/3';
  /** Fica em loop e sem áudio desde o início. */
  autoPlay?: boolean;
  className?: string;
}

export function VideoBlock({
  video,
  eyebrow,
  title,
  caption,
  aspect = '16/9',
  autoPlay = true,
  className,
}: VideoBlockProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const [figureRef, near] = useNearViewport<HTMLElement>();
  const [playing, setPlaying] = useState(autoPlay);
  const [muted, setMuted] = useState(true);
  // O src pode simplesmente não existir mais (o vídeo institucional de hoje é
  // um placeholder do Pexels que responde 403). Quando falha, o bloco vira o
  // poster — sem retângulo preto e sem controles que não controlam nada.
  const [failed, setFailed] = useState(false);
  const showVideo = near && !failed;

  const aspectClass =
    aspect === '16/9' ? 'aspect-video' : aspect === '21/9' ? 'aspect-21/9' : 'aspect-4/3';

  function togglePlay() {
    const node = ref.current;
    if (!node) return;
    if (node.paused) {
      void node.play();
      setPlaying(true);
    } else {
      node.pause();
      setPlaying(false);
    }
  }

  function toggleMute() {
    const node = ref.current;
    if (!node) return;
    node.muted = !node.muted;
    setMuted(node.muted);
  }

  return (
    <motion.figure ref={figureRef} {...reveal(fadeUp)} className={cn('relative', className)}>
      <div className={cn('relative overflow-hidden rounded-lg bg-ink', aspectClass)}>
        {/* Poster por baixo — evita frame preto antes do vídeo montar */}
        <Image
          src={video.poster}
          alt={failed ? video.alt : ''}
          aria-hidden={failed ? undefined : true}
          fill
          sizes="(max-width: 1024px) 100vw, 1280px"
          placeholder="blur"
          blurDataURL={BLUR_DATA_URL}
          className="object-cover"
        />
        {showVideo && (
          <video
            ref={ref}
            src={video.src}
            autoPlay={autoPlay}
            muted
            loop
            playsInline
            preload="none"
            aria-label={video.alt}
            onError={() => setFailed(true)}
            className="relative size-full object-cover"
          />
        )}

        {(eyebrow || title) && (
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-ink/70 via-transparent to-transparent p-8 lg:p-14">
            {eyebrow && <p className="eyebrow text-primary-soft">{eyebrow}</p>}
            {title && <h2 className="mt-4 max-w-2xl text-h2 text-light">{title}</h2>}
          </div>
        )}

        {/* Controles — só quando existe vídeo pra controlar */}
        <div className={cn('absolute right-5 bottom-5 flex gap-2', !showVideo && 'hidden')}>
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? 'Pausar vídeo' : 'Reproduzir vídeo'}
            className="flex size-10 items-center justify-center rounded-pill bg-light/85 text-ink backdrop-blur transition-colors hover:bg-light"
          >
            {playing ? (
              <Pause className="size-4" strokeWidth={1.75} />
            ) : (
              <Play className="size-4" strokeWidth={1.75} />
            )}
          </button>
          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted ? 'Ativar som' : 'Desativar som'}
            className="flex size-10 items-center justify-center rounded-pill bg-light/85 text-ink backdrop-blur transition-colors hover:bg-light"
          >
            {muted ? (
              <VolumeX className="size-4" strokeWidth={1.75} />
            ) : (
              <Volume2 className="size-4" strokeWidth={1.75} />
            )}
          </button>
        </div>
      </div>

      {caption && (
        <figcaption className="mt-4 text-small font-light text-ink-muted">{caption}</figcaption>
      )}
    </motion.figure>
  );
}
