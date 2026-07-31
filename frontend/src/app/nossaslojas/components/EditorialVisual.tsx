'use client';

import Image from 'next/image';
import clsx from 'clsx';

/**
 * Visual editorial dos cards e do hero.
 * Sem foto (image=null no JSON) renderiza uma arte tipográfica em tons
 * champagne/dourado — quando a foto real existir em /public, é só preencher
 * o campo "image" da loja no lojas.json que o next/image assume.
 */

const PALETTES = [
  ['#f3e8d3', '#e6d3b3'],
  ['#f6ece2', '#e9d5c0'],
  ['#f1e6da', '#ddc9ae'],
  ['#f7efe0', '#e3d2b0'],
  ['#f2e9dd', '#e0ccb4'],
];

interface Props {
  variant?: 'card' | 'hero';
  /** Índice usado pra variar a paleta entre cards (determinístico, sem flicker de hidratação). */
  seed?: number;
  /** Letra grande da arte (inicial da unidade). */
  initial?: string;
  image?: string | null;
  alt?: string;
  className?: string;
  priority?: boolean;
}

export default function EditorialVisual({
  variant = 'card',
  seed = 0,
  initial,
  image,
  alt = '',
  className,
  priority = false,
}: Props) {
  if (image) {
    return (
      <div className={clsx('relative overflow-hidden', className)}>
        <Image
          src={image}
          alt={alt}
          fill
          priority={priority}
          sizes={variant === 'hero' ? '100vw' : '(max-width: 768px) 100vw, 33vw'}
          className="object-cover"
        />
      </div>
    );
  }

  const [from, to] = PALETTES[seed % PALETTES.length];

  return (
    <div
      aria-hidden
      className={clsx('lojas-grain relative overflow-hidden', className)}
      style={{ background: `linear-gradient(135deg, ${from} 0%, ${to} 100%)` }}
    >
      {/* Arco editorial — remete a provador/vitrine de boutique */}
      <div
        className="absolute left-1/2 top-[18%] h-[130%] w-[62%] -translate-x-1/2 rounded-t-full border border-[rgba(140,115,37,0.35)]"
        style={{ background: 'rgba(253,251,247,0.35)' }}
      />
      {variant === 'hero' ? (
        <div className="lojas-serif absolute inset-0 flex items-center justify-center text-[38vw] font-medium italic leading-none text-[rgba(140,115,37,0.10)] sm:text-[24rem]">
          L
        </div>
      ) : (
        <div className="lojas-serif absolute inset-0 flex items-center justify-center text-8xl font-medium italic text-[rgba(140,115,37,0.28)]">
          {initial ?? 'L'}
        </div>
      )}
    </div>
  );
}
