'use client';

import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Tom = 'crit' | 'warn' | 'ok' | 'neutro';

/**
 * Rótulo de estado.
 *
 * No Semáforo o padrão é SEM FUNDO — só a palavra na cor do estado. A pílula
 * preenchida (`cheio`) fica pros casos em que o rótulo precisa competir com
 * muita coisa em volta; usada demais, ela devolve à tela o carnaval de cor que
 * a direção existe pra tirar.
 */
const TOM: Record<Tom, string> = {
  crit:   'text-crit',
  warn:   'text-warn',
  ok:     'text-ok',
  neutro: 'text-ink-soft',
};

const TOM_CHEIO: Record<Tom, string> = {
  crit:   'bg-crit-soft text-crit',
  warn:   'bg-warn-soft text-warn',
  ok:     'bg-ok-soft text-ok',
  neutro: 'bg-line-soft text-ink-soft',
};

export default function Badge({
  tom = 'neutro',
  cheio = false,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tom?: Tom; cheio?: boolean }) {
  return (
    <span
      className={cn(
        'inline-block text-[12px] font-semibold',
        cheio ? cn('rounded-field px-2 py-0.5', TOM_CHEIO[tom]) : TOM[tom],
        className,
      )}
      {...props}
    />
  );
}
