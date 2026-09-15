import type { ReactNode } from 'react';

/**
 * Formulário da linguagem ORDER ONE · Executive Operations UI.
 *
 * ⚠️ Tudo no ESCOPO DO MÓDULO de propósito: componente com `<input>` declarado
 * dentro de outro componente vira tipo novo a cada render — o React remonta o
 * campo e só a primeira letra entra (incidente da ficha do CRM, 03/08).
 */

export const CAMPO =
  'w-full rounded-md border border-oo-line-strong bg-oo-surface px-3 text-[14px] font-medium text-oo-ink ' +
  'placeholder:font-normal placeholder:text-oo-muted transition-shadow duration-150 ' +
  'focus:border-oo-primary focus:outline-none focus:ring-[3px] focus:ring-oo-primary/15 ' +
  'disabled:bg-oo-subtle disabled:text-oo-muted';

export const BTN_PRIMARIO =
  'inline-flex h-10 items-center justify-center gap-2 rounded-md bg-oo-primary px-4 text-[14px] font-semibold text-white ' +
  'transition-colors duration-150 hover:bg-oo-primary-hover active:translate-y-px disabled:pointer-events-none disabled:opacity-50 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oo-primary focus-visible:ring-offset-2';

export const BTN_SECUNDARIO =
  'inline-flex h-10 items-center justify-center gap-2 rounded-md border border-oo-line-strong bg-oo-surface px-3.5 text-[14px] font-medium text-oo-ink ' +
  'transition-colors duration-150 hover:bg-oo-subtle active:translate-y-px disabled:pointer-events-none disabled:opacity-50 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oo-primary';

/** secundário sobre a faixa navy */
export const BTN_ESCURO =
  'inline-flex h-10 items-center justify-center gap-2 rounded-md border border-white/15 bg-white/[0.04] px-3.5 text-[14px] font-medium text-white ' +
  'transition-colors duration-150 hover:bg-white/10 active:translate-y-px ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60';

export const ROTULO = 'text-[12px] font-semibold text-oo-ink-2';

/** Rótulo + campo + dica. */
export function Campo({
  label,
  dica,
  className,
  children,
}: {
  label: ReactNode;
  dica?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`block min-w-0 ${className || ''}`}>
      <span className={`mb-1.5 block ${ROTULO}`}>{label}</span>
      {children}
      {dica && <span className="mt-1.5 block text-[12px] text-oo-muted">{dica}</span>}
    </label>
  );
}

/**
 * Seção de formulário em duas colunas no desktop (título e explicação à
 * esquerda, campos à direita) — leitura de "configuração", não de cartão.
 */
export function Secao({
  titulo,
  descricao,
  icone,
  acao,
  children,
}: {
  titulo: ReactNode;
  descricao?: ReactNode;
  icone?: ReactNode;
  acao?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-x-10 gap-y-4 border-b border-oo-line px-5 py-6 last:border-b-0 sm:px-8 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
      <div>
        <h2 className="flex items-center gap-2 font-oo-display text-[16px] font-semibold tracking-[-0.01em] text-oo-ink">
          {icone && <span className="text-oo-muted">{icone}</span>}
          {titulo}
        </h2>
        {descricao && <p className="mt-1.5 max-w-xs text-[13px] leading-relaxed text-oo-ink-2">{descricao}</p>}
        {acao && <div className="mt-3">{acao}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/** Rodapé de ação do formulário: feedback à esquerda, botões à direita. */
export function BarraAcoes({ feedback, children }: { feedback?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-oo-line bg-oo-subtle px-5 py-4 sm:px-8">
      {feedback && <div className="mr-auto text-[13px] font-medium">{feedback}</div>}
      {children}
    </div>
  );
}
