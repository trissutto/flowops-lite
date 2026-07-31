'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fadeUp, reveal } from '@/lib/motion';
import type { TaxonomyCard } from '@/types';

/**
 * FabricCard — cada tecido tem identidade própria.
 *
 * A "identidade" é o campo `tone` (um gradiente que remete ao material:
 * viscolycra tem cair fluido e brilho suave; jeans é índigo; linho é cru).
 * Sem foto de propósito: a textura desenhada dá unidade à seção inteira,
 * o que fotos avulsas de estoque não conseguem.
 */

interface FabricCardProps {
  data: TaxonomyCard;
  index?: number;
  className?: string;
}

/** Gradientes de identidade por tecido — chave = slug. */
const FABRIC_TONES: Record<string, string> = {
  'viscolycra-premium': 'from-[#2f2a33] via-[#4a4150] to-[#211c25]',
  jeans: 'from-[#1f3347] via-[#2f5573] to-[#16242f]',
  linho: 'from-[#d9cdb4] via-[#e8ded0] to-[#c9bb9f]',
  crepe: 'from-[#3b2f33] via-[#5c4a50] to-[#2a2124]',
  tricot: 'from-[#b99c7e] via-[#d3bda4] to-[#a3856a]',
  malha: 'from-[#4d4f54] via-[#71757c] to-[#3a3c40]',
  alfaiataria: 'from-[#22242a] via-[#3d4048] to-[#181a1f]',
};

/** Tecidos claros pedem texto escuro pra manter contraste AA. */
const LIGHT_FABRICS = new Set(['linho', 'tricot']);

export function FabricCard({ data, index = 0, className }: FabricCardProps) {
  const tone = data.tone ?? FABRIC_TONES[data.slug] ?? 'from-champagne via-surface-alt to-border';
  const isLight = LIGHT_FABRICS.has(data.slug);

  return (
    <motion.div {...reveal(fadeUp, '-40px')} transition={{ duration: 0.56, delay: (index % 4) * 0.06 }}>
      <Link
        href={data.href}
        className={cn(
          'group relative flex aspect-4/5 flex-col justify-end overflow-hidden rounded-md p-6 transition-transform duration-[560ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-1.5',
          className,
        )}
      >
        {/* Textura do tecido */}
        <div className={cn('grain absolute inset-0 bg-gradient-to-br', tone)} />
        {/* Brilho diagonal — sugere o caimento do material */}
        <div className="absolute inset-0 bg-[linear-gradient(115deg,transparent_35%,rgba(255,255,255,0.14)_50%,transparent_65%)] opacity-0 transition-opacity duration-[900ms] group-hover:opacity-100" />

        <div className="relative">
          <h3
            className={cn(
              'font-display text-[1.375rem] leading-tight',
              isLight ? 'text-ink' : 'text-light',
            )}
          >
            {data.title}
          </h3>
          {data.description && (
            <p
              className={cn(
                'mt-2 text-small font-light',
                isLight ? 'text-ink-soft' : 'text-light/75',
              )}
            >
              {data.description}
            </p>
          )}
          <span
            className={cn(
              'mt-4 inline-flex items-center gap-2 text-[0.625rem] font-medium tracking-[0.16em] uppercase',
              isLight ? 'text-primary-strong' : 'text-primary-soft',
            )}
          >
            Ver peças
            <ArrowRight className="size-3 transition-transform duration-[320ms] group-hover:translate-x-1" />
          </span>
        </div>
      </Link>
    </motion.div>
  );
}
