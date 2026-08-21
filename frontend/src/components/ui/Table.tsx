'use client';

import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type EstadoLinha = 'crit' | 'warn' | 'ok';

/**
 * Tabela do sistema Semáforo.
 *
 * O TRAÇO DA DIREÇÃO: o estado da linha é uma FAIXA na lateral, não uma
 * pílula colorida. Faixa é forma além de cor — funciona pra quem não distingue
 * vermelho de verde, porque a posição já informa —, e some da coluna de dados,
 * que fica livre pro número.
 *
 * A faixa é desenhada no PRIMEIRO `<td>` da linha (variante de filho), e não
 * como box-shadow no `<tr>`: com `border-collapse` a sombra no `<tr>` não
 * renderiza de forma confiável.
 */
const FAIXA_BASE =
  '[&>td:first-child]:relative [&>td:first-child]:pl-[22px] ' +
  '[&>td:first-child]:before:absolute [&>td:first-child]:before:left-[9px] ' +
  '[&>td:first-child]:before:top-1/2 [&>td:first-child]:before:-translate-y-1/2 ' +
  '[&>td:first-child]:before:h-[58%] [&>td:first-child]:before:w-[3px] ' +
  '[&>td:first-child]:before:rounded-full [&>td:first-child]:before:content-[""]';

const FAIXA: Record<EstadoLinha, string> = {
  crit: `${FAIXA_BASE} [&>td:first-child]:before:bg-crit`,
  warn: `${FAIXA_BASE} [&>td:first-child]:before:bg-warn`,
  ok:   `${FAIXA_BASE} [&>td:first-child]:before:bg-ok`,
};

export function Table({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLTableElement>) {
  return (
    /* wide content rola dentro da própria caixa — a página nunca rola de lado */
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className={cn('w-full border-collapse text-[13.5px]', className)} {...props}>
        {children}
      </table>
    </div>
  );
}

export function Th({
  className,
  align,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' }) {
  return (
    <th
      className={cn(
        'bg-ground border-b border-line px-3.5 py-2',
        'text-[11px] font-bold uppercase tracking-[.11em] text-ink-soft',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
      {...props}
    />
  );
}

export function Tr({
  estado,
  className,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { estado?: EstadoLinha }) {
  return (
    <tr
      className={cn(
        'border-b border-line-soft last:border-b-0 transition-colors hover:bg-surface-2',
        estado && FAIXA[estado],
        className,
      )}
      {...props}
    />
  );
}

export function Td({
  className,
  align,
  num,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & {
  align?: 'left' | 'right';
  /** número: alinha em coluna com tabular-nums */
  num?: boolean;
}) {
  return (
    <td
      className={cn(
        'h-row px-3.5 text-ink',
        align === 'right' ? 'text-right' : 'text-left',
        num && 'tabular-nums',
        className,
      )}
      {...props}
    />
  );
}

/** Estado vazio da tabela — mensagem que diz o que fazer, não só "sem dados". */
export function TabelaVazia({ children, colSpan }: { children: ReactNode; colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3.5 py-10 text-center text-[13px] text-ink-soft">
        {children}
      </td>
    </tr>
  );
}
