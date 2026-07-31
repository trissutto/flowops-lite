'use client';

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Casca de cada seção do checkout one-page — o accordion é CONTROLADO pela
 * página (um único estado `step`), nunca por estado interno: a sequência
 * identificação → entrega → pagamento → revisão é regra de negócio, e regra
 * de negócio não mora em componente de UI.
 *
 * Três estados:
 *   locked — ainda não chegou a vez (esmaecida, sem interação)
 *   active — seção aberta com o formulário
 *   done   — colapsada num resumo de 1 linha + "editar"
 *
 * As quatro seções ficam SEMPRE no DOM na mesma ordem (nada de montar/
 * desmontar seção inteira) — o que muda é só o miolo. Isso mantém o scroll
 * estável e evita salto de layout na troca de etapa.
 */

export type SectionState = 'locked' | 'active' | 'done';

interface SectionShellProps {
  step: number;
  title: string;
  state: SectionState;
  /** Resumo de 1 linha exibido quando `done` (ex.: "SEDEX · R$ 28,90"). */
  summary?: React.ReactNode;
  onEdit?: () => void;
  children: React.ReactNode;
}

export function SectionShell({ step, title, state, summary, onEdit, children }: SectionShellProps) {
  const headingId = `checkout-secao-${step}`;

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'rounded-md border bg-surface transition-colors duration-[320ms]',
        state === 'active' ? 'border-primary/50 shadow-sm' : 'border-border',
        state === 'locked' && 'opacity-55',
      )}
    >
      <header className="flex items-center gap-4 px-5 py-4 sm:px-7">
        {/* Número da etapa — vira check dourado quando concluída. */}
        <span
          aria-hidden
          className={cn(
            'tabular flex size-8 shrink-0 items-center justify-center rounded-pill border text-small font-medium transition-colors duration-[320ms]',
            state === 'done' && 'border-primary bg-primary text-light',
            state === 'active' && 'border-ink bg-ink text-light',
            state === 'locked' && 'border-border-strong text-ink-muted',
          )}
        >
          {state === 'done' ? <Check className="size-4" strokeWidth={2.5} /> : step}
        </span>
        <h2 id={headingId} className="flex-1 font-display text-h4 text-ink">
          {title}
        </h2>
        {state === 'done' && onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="link-underline text-small font-medium text-primary-strong"
          >
            editar
          </button>
        )}
      </header>

      {state === 'done' && summary && (
        <p className="truncate border-t border-border px-5 py-3 text-small text-ink-soft sm:px-7">
          {summary}
        </p>
      )}

      {state === 'active' && (
        <div className="border-t border-border px-5 py-6 sm:px-7">{children}</div>
      )}
    </section>
  );
}
