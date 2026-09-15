import type { ReactNode } from 'react';

export type Metrica = {
  rotulo: string;
  valor: ReactNode;
  /** linha curta de contexto abaixo do número */
  apoio?: ReactNode;
  /** só quando o número É um risco */
  tom?: 'danger' | 'warning' | 'success';
  title?: string;
};

const TOM = {
  danger: 'text-oo-danger',
  warning: 'text-oo-warning',
  success: 'text-oo-success',
};

/**
 * Faixa de indicadores estilo painel financeiro: uma superfície só, divisores
 * de 1px (gap-px sobre o fio), número grande, rótulo pequeno. Não é grade de
 * cards. `flex-wrap` + `flex-1` fecha cada fileira sem célula vazia.
 */
export default function MetricStrip({ metricas, carregando }: { metricas: Metrica[]; carregando?: boolean }) {
  return (
    <dl className="flex gap-px overflow-x-auto rounded-lg border border-oo-line bg-oo-line [scrollbar-width:none] sm:flex-wrap sm:overflow-hidden">
      {metricas.map((m) => (
        <div
          key={m.rotulo}
          title={m.title}
          className="min-w-[140px] flex-[1_0_auto] bg-oo-surface sm:flex-1 px-4 py-3 sm:min-w-0 sm:shrink sm:basis-[30%] sm:px-5 sm:py-4 xl:basis-0"
        >
          <dt className="whitespace-nowrap text-[11px] sm:truncate font-semibold uppercase tracking-[0.06em] text-oo-muted">{m.rotulo}</dt>
          <dd
            className={`mt-2 font-oo-display text-[24px] sm:text-[28px] font-bold leading-none tracking-[-0.02em] tabular-nums ${
              m.tom ? TOM[m.tom] : 'text-oo-ink'
            }`}
          >
            {carregando ? <span className="inline-block h-7 w-14 animate-pulse rounded bg-oo-hover align-middle" /> : m.valor}
          </dd>
          {m.apoio && <dd className="mt-2 hidden truncate sm:block text-[12px] font-medium text-oo-ink-2">{m.apoio}</dd>}
        </div>
      ))}
    </dl>
  );
}
