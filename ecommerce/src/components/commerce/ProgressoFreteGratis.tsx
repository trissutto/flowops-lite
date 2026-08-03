'use client';

import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { freeShippingGap } from '@/lib/commerce/frete';
import { transition } from '@/lib/motion';
import { cn, formatPrice } from '@/lib/utils';

/**
 * "Faltam R$ 45 para o frete grátis" — o incentivo mais honesto da sacola.
 *
 * É honesto porque a meta é REAL (a regra dos R$ 399 é a mesma que o checkout
 * aplica) e porque o número é o que falta de verdade, não um teto inventado
 * pra empurrar peça.
 *
 * Estava só no mini-carrinho. Agora vive num lugar só e aparece também na
 * página da sacola, que é onde a cliente decide se fecha ou se volta pra
 * vitrine — o momento em que "levo mais uma pra bater a meta" acontece.
 */
export function ProgressoFreteGratis({
  subtotal,
  className,
}: {
  subtotal: number;
  className?: string;
}) {
  const gap = freeShippingGap(subtotal);

  return (
    <div className={cn('rounded-sm border border-border bg-surface-alt/60 px-4 py-3.5', className)}>
      {gap.reached ? (
        <motion.p
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={transition.base}
          className="flex items-center gap-2 text-small font-medium text-primary-strong"
        >
          <Sparkles className="size-3.5" strokeWidth={1.75} />
          Você ganhou frete grátis
        </motion.p>
      ) : (
        <p className="text-small font-light text-ink-soft">
          Faltam <span className="tabular font-medium text-ink">{formatPrice(gap.missing)}</span>{' '}
          para o frete grátis
        </p>
      )}
      <div
        role="progressbar"
        aria-valuenow={Math.round(gap.progress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Progresso até o frete grátis"
        className="mt-2.5 h-1 overflow-hidden rounded-pill bg-border"
      >
        <motion.div
          animate={{ width: `${gap.progress * 100}%` }}
          transition={transition.slow}
          className="h-full rounded-pill bg-primary"
        />
      </div>
    </div>
  );
}
