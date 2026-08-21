'use client';

import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-card border border-line bg-surface', className)}
      {...props}
    />
  );
}

export function CardHead({
  titulo,
  acao,
  children,
  className,
}: {
  titulo: ReactNode;
  /** botões à direita do título */
  acao?: ReactNode;
  /** linha de apoio abaixo do título */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('border-b border-line px-4 py-3', className)}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-bold tracking-[-.012em] text-ink">{titulo}</h2>
        {acao ? <div className="ml-auto flex items-center gap-2">{acao}</div> : null}
      </div>
      {children ? <div className="mt-1 text-[12px] text-ink-soft">{children}</div> : null}
    </div>
  );
}

/**
 * Número grande de resumo.
 *
 * ⚠️ DINHEIRO É `ink`, NÃO VERDE. No Semáforo verde significa "em dia" — se o
 * total também fosse verde, ele competiria com o estado na mesma tela. Grafite
 * pesado com tabular-nums lê melhor sobre fundo cinza.
 */
export function Numero({
  rotulo,
  valor,
  apoio,
  tom,
  className,
}: {
  rotulo: ReactNode;
  valor: ReactNode;
  apoio?: ReactNode;
  /** só use tom quando o número FOR um estado (ex.: "12 paradas") */
  tom?: 'crit' | 'warn' | 'ok';
  className?: string;
}) {
  return (
    <div className={cn('px-4 py-3', className)}>
      <div className="text-[11px] font-bold uppercase tracking-[.13em] text-ink-soft">
        {rotulo}
      </div>
      <div
        className={cn(
          'mt-1 text-[26px] font-extrabold leading-none tracking-[-.03em] tabular-nums',
          tom === 'crit' ? 'text-crit' : tom === 'warn' ? 'text-warn' : tom === 'ok' ? 'text-ok' : 'text-ink',
        )}
      >
        {valor}
      </div>
      {apoio ? <div className="mt-1 text-[12px] text-ink-soft">{apoio}</div> : null}
    </div>
  );
}
