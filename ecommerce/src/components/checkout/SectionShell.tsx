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
 *   done   — colapsada: título e resumo na MESMA linha do check + "editar"
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
      <header className="flex items-center gap-3 px-5 py-3 sm:gap-4 sm:px-7 sm:py-4">
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
        {/* O resumo da etapa concluída mora AQUI DENTRO, sob o título, e não
            mais numa segunda faixa com borda própria (19/08). A faixa custava
            45px cada — num iPhone 15 as duas etapas fechadas somavam 222px só
            pra dizer duas linhas de recibo, e empurravam os botões PIX/Cartão
            pra 219px ABAIXO da dobra. Etapa concluída não é conteúdo: cabe na
            linha do próprio título. */}
        <div className="min-w-0 flex-1">
          {/* O "editar" divide a linha do TÍTULO, não a do resumo: o resumo
              precisa da largura inteira. Num 360px ele sobrava com 178px e
              cortava justamente o fim — endereço e valor do frete, que é o
              que ela relê antes de pagar. */}
          <div className="flex items-center gap-3">
            <h2 id={headingId} className="flex-1 font-display text-h4 text-ink">
              {title}
            </h2>
            {state === 'done' && onEdit && (
              <button
                type="button"
                onClick={onEdit}
                className="link-underline shrink-0 text-small font-medium text-primary-strong"
              >
                editar
              </button>
            )}
          </div>
          {state === 'done' && summary && (
            <p className="truncate text-caption font-normal normal-case tracking-normal text-ink-soft">
              {summary}
            </p>
          )}
        </div>
      </header>

      {state === 'active' && (
        <div className="border-t border-border px-5 py-5 sm:px-7 sm:py-6">{children}</div>
      )}
    </section>
  );
}
