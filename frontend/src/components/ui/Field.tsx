'use client';

import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { useId } from 'react';
import { cn } from '@/lib/cn';

/**
 * ⚠️ Estes componentes moram no ESCOPO DO MÓDULO de propósito, e qualquer
 * campo novo tem que nascer aqui também.
 *
 * Componente com `<input>` declarado DENTRO de outro componente vira tipo novo
 * a cada render: o React desmonta e remonta o campo, o foco morre e só a
 * primeira letra entra. No campo de data é pior — o Chrome valida o ano no
 * primeiro dígito e "1975" vira 0001. Assinatura do sintoma: "só deixa digitar
 * 1 letra". Já aconteceu na ficha do CRM em 03/08/2026.
 */

const CAIXA =
  'w-full rounded-field border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink ' +
  'placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-action focus:border-action';

export function Rotulo({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="text-[11px] font-bold uppercase tracking-[.12em] text-ink-soft"
    >
      {children}
    </label>
  );
}

export function Input({
  rotulo,
  className,
  id,
  num,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { rotulo?: ReactNode; num?: boolean }) {
  const auto = useId();
  const fieldId = id || auto;
  return (
    <div className="flex flex-col gap-1">
      {rotulo ? <Rotulo htmlFor={fieldId}>{rotulo}</Rotulo> : null}
      <input
        id={fieldId}
        className={cn(CAIXA, num && 'tabular-nums', className)}
        {...props}
      />
    </div>
  );
}

export function Select({
  rotulo,
  className,
  id,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { rotulo?: ReactNode }) {
  const auto = useId();
  const fieldId = id || auto;
  return (
    <div className="flex flex-col gap-1">
      {rotulo ? <Rotulo htmlFor={fieldId}>{rotulo}</Rotulo> : null}
      <select id={fieldId} className={cn(CAIXA, className)} {...props}>
        {children}
      </select>
    </div>
  );
}
