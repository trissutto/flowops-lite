'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface Aba<T extends string> {
  id: T;
  label: ReactNode;
  /** número ao lado do rótulo (pendências, resultados) */
  contagem?: number;
  /** pinta a contagem — só quando ela FOR um estado */
  tom?: 'crit' | 'warn' | 'ok';
}

/**
 * Abas controladas: a tela decide o estado.
 *
 * ⚠️ Se o valor vier da URL (`?aba=`), leia em `useEffect`, NUNCA no
 * inicializador do `useState`. Na navegação client-side do Next o componente
 * monta ANTES da URL trocar, e a aba nasce errada. Já queimou na fila da loja
 * em 11/08/2026.
 */
export default function Tabs<T extends string>({
  abas,
  valor,
  onChange,
  className,
}: {
  abas: readonly Aba<T>[];
  valor: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn('flex flex-wrap items-center gap-1 border-b border-line', className)}
    >
      {abas.map((aba) => {
        const ativa = aba.id === valor;
        return (
          <button
            key={aba.id}
            role="tab"
            type="button"
            aria-selected={ativa}
            onClick={() => onChange(aba.id)}
            className={cn(
              'relative -mb-px flex items-center gap-2 px-3.5 py-2.5 text-[13px] font-semibold',
              'border-b-2 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset',
              ativa
                ? 'border-action text-ink'
                : 'border-transparent text-ink-soft hover:text-ink',
            )}
          >
            {aba.label}
            {typeof aba.contagem === 'number' && (
              <span
                className={cn(
                  'rounded-field px-1.5 py-0.5 text-[11px] font-bold tabular-nums',
                  aba.tom === 'crit'
                    ? 'bg-crit-soft text-crit'
                    : aba.tom === 'warn'
                      ? 'bg-warn-soft text-warn'
                      : aba.tom === 'ok'
                        ? 'bg-ok-soft text-ok'
                        : 'bg-line-soft text-ink-soft',
                )}
              >
                {aba.contagem}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
