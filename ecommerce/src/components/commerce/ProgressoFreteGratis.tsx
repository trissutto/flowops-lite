'use client';

import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { freeShippingGap } from '@/lib/commerce/frete';
import { useLojaConfig } from '@/hooks/useLojaConfig';
import { transition } from '@/lib/motion';
import { cn, formatPrice } from '@/lib/utils';

/**
 * "Faltam R$ 45 para o frete grátis" — o incentivo mais honesto da sacola.
 *
 * É honesto porque a meta é REAL e porque o número é o que falta de verdade,
 * não um teto inventado pra empurrar peça.
 *
 * ⚠️ A RÉGUA VEM DA CONFIG (item 57, 06/08). Antes ela era a constante do
 * código, e no dia em que o dono mudasse o mínimo na retaguarda esta barra
 * continuaria prometendo o valor velho — **prometendo frete grátis que o
 * checkout não daria**, que é o pior tipo de erro possível aqui.
 *
 * `minimo` chega da cotação (`fetchQuotes().freteGratis.minimo`). Sem ele, cai
 * na constante local — a mesma que serve de paraquedas do frete.
 *
 * `ativo: false` esconde a barra inteira: com o frete grátis desligado, uma
 * barra parada em "faltam R$ 499,90" só ocupa espaço e confunde.
 */
export function ProgressoFreteGratis({ subtotal, className }: { subtotal: number; className?: string }) {
  const { freteGratis } = useLojaConfig();
  const gap = freeShippingGap(subtotal, freteGratis.minimo);
  if (!freteGratis.ativo || !(freteGratis.minimo > 0)) return null;

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
