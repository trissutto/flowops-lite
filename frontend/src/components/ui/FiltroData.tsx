'use client';

import { useId } from 'react';
import Button from './Button';
import { Rotulo } from './Field';
import { cn } from '@/lib/cn';

/**
 * O filtro de tempo da casa — REGRA FIXA, não preferência de tela.
 *
 * Dois `<input type="date">` De/Até + atalhos Hoje · Ontem · 7 dias · Mês.
 * NUNCA um `<select>` de períodos fixos: dropdown só mostra o que já existe e
 * trava a consulta (foi o que aconteceu na tela de comissões, que só listava
 * "2026-07"). O dono já pediu isso mais de uma vez.
 *
 * Existir como primitivo é o ponto: tela nova herda a regra sem precisar
 * lembrar dela. Referência original: /retaguarda/faturamento.
 */

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isoDaysAgo(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  return d.toISOString().slice(0, 10);
}

export function firstOfMonthIso(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

/** Padrão do sistema: mês corrente (1º dia → hoje). */
export const PERIODO_PADRAO = { de: firstOfMonthIso(), ate: todayIso() };

export interface Periodo {
  de: string;
  ate: string;
}

export default function FiltroData({
  valor,
  onChange,
  onAplicar,
  carregando,
  className,
  children,
}: {
  valor: Periodo;
  onChange: (p: Periodo) => void;
  /** ausente = aplica na hora que muda */
  onAplicar?: () => void;
  carregando?: boolean;
  className?: string;
  /** filtros extras da tela, à direita dos atalhos */
  children?: React.ReactNode;
}) {
  const deId = useId();
  const ateId = useId();

  function atalho(p: Periodo) {
    onChange(p);
    /* atalho aplica na hora — clicar em "Hoje" e ter que confirmar irrita */
    if (onAplicar) setTimeout(onAplicar, 0);
  }

  const CAIXA =
    'rounded-field border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink tabular-nums ' +
    'focus:outline-none focus:ring-2 focus:ring-action focus:border-action';

  return (
    <div
      className={cn(
        'flex flex-wrap items-end gap-2.5 rounded-card border border-line bg-surface px-3 py-2.5',
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <Rotulo htmlFor={deId}>De</Rotulo>
        <input
          id={deId}
          type="date"
          value={valor.de}
          onChange={(e) => onChange({ ...valor, de: e.target.value })}
          className={CAIXA}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Rotulo htmlFor={ateId}>Até</Rotulo>
        <input
          id={ateId}
          type="date"
          value={valor.ate}
          onChange={(e) => onChange({ ...valor, ate: e.target.value })}
          className={CAIXA}
        />
      </div>

      {onAplicar && (
        <Button variant="primary" onClick={onAplicar} disabled={carregando}>
          {carregando ? 'Buscando…' : 'Aplicar'}
        </Button>
      )}

      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" onClick={() => atalho({ de: todayIso(), ate: todayIso() })}>
          Hoje
        </Button>
        <Button size="sm" onClick={() => atalho({ de: isoDaysAgo(1), ate: isoDaysAgo(1) })}>
          Ontem
        </Button>
        <Button size="sm" onClick={() => atalho({ de: isoDaysAgo(6), ate: todayIso() })}>
          7 dias
        </Button>
        <Button size="sm" onClick={() => atalho({ de: firstOfMonthIso(), ate: todayIso() })}>
          Mês
        </Button>
      </div>

      {children ? <div className="ml-auto flex flex-wrap items-end gap-2.5">{children}</div> : null}
    </div>
  );
}
