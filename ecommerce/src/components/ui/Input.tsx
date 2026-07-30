'use client';

import { forwardRef, useId } from 'react';
import { cn } from '@/lib/utils';

/**
 * Campos de formulário — Input, Textarea, Select.
 * Todos com label associada, mensagem de erro ligada por aria-describedby
 * e aria-invalid. Compatíveis com react-hook-form (aceitam ref).
 */

interface FieldShellProps {
  label?: string;
  hint?: string;
  error?: string;
  /** Esconde a label visualmente mantendo pra leitor de tela. */
  hideLabel?: boolean;
  id: string;
  children: React.ReactNode;
  className?: string;
}

function FieldShell({ label, hint, error, hideLabel, id, children, className }: FieldShellProps) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {label && (
        <label
          htmlFor={id}
          className={cn(
            'eyebrow text-ink-soft',
            hideLabel && 'sr-only',
          )}
        >
          {label}
        </label>
      )}
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-small text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

const CONTROL =
  'w-full rounded-md border bg-surface px-4 py-3 text-body text-ink transition-shadow duration-[180ms] ' +
  'placeholder:text-ink-muted/70 focus:border-primary focus:shadow-[0_0_0_3px_rgba(184,145,43,0.12)] focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:bg-surface-alt';

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className'> & {
  label?: string;
  hint?: string;
  error?: string;
  hideLabel?: boolean;
  className?: string;
  /** Ícone à esquerda (ex: lupa na busca). */
  icon?: React.ReactNode;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, hideLabel, className, icon, id: idProp, ...rest },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? autoId;

  return (
    <FieldShell label={label} hint={hint} error={error} hideLabel={hideLabel} id={id} className={className}>
      <div className="relative">
        {icon && (
          <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-primary-strong [&_svg]:size-4">
            {icon}
          </span>
        )}
        <input
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          className={cn(
            CONTROL,
            error ? 'border-danger' : 'border-border',
            icon && 'pl-11',
          )}
          {...rest}
        />
      </div>
    </FieldShell>
  );
});

type TextareaProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> & {
  label?: string;
  hint?: string;
  error?: string;
  className?: string;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, className, id: idProp, rows = 4, ...rest },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? autoId;

  return (
    <FieldShell label={label} hint={hint} error={error} id={id} className={className}>
      <textarea
        ref={ref}
        id={id}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cn(CONTROL, 'resize-y', error ? 'border-danger' : 'border-border')}
        {...rest}
      />
    </FieldShell>
  );
});

type SelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'className'> & {
  label?: string;
  hint?: string;
  error?: string;
  hideLabel?: boolean;
  className?: string;
  options: { value: string; label: string }[];
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, hideLabel, className, options, id: idProp, ...rest },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? autoId;

  return (
    <FieldShell label={label} hint={hint} error={error} hideLabel={hideLabel} id={id} className={className}>
      <select
        ref={ref}
        id={id}
        aria-invalid={error ? true : undefined}
        className={cn(
          CONTROL,
          'cursor-pointer appearance-none bg-[length:14px] bg-[right_1rem_center] bg-no-repeat pr-11',
          error ? 'border-danger' : 'border-border',
        )}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='8' viewBox='0 0 14 8' fill='none'%3E%3Cpath d='M1 1l6 6 6-6' stroke='%238C7325' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E\")",
        }}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
});
