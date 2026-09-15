import type { ReactNode } from 'react';

export type Metrica = {
  rotulo: string;
  valor: ReactNode;
  /** micro-visualização abaixo do número (barra, distribuição) */
  viz?: ReactNode;
  /** linha curta de contexto */
  apoio?: ReactNode;
  /** só quando o número É um risco */
  tom?: 'danger' | 'warning' | 'success';
  title?: string;
};

const TOM_CLARO = {
  danger: 'text-oo-danger',
  warning: 'text-oo-warning',
  success: 'text-oo-success',
};

/* no fundo navy o tom precisa de uma volta a mais de luz pra manter contraste */
const TOM_ESCURO = {
  danger: 'text-[#FF8A7A]',
  warning: 'text-[#FDB022]',
  success: 'text-[#47CD89]',
};

/**
 * Faixa de indicadores estilo painel financeiro: uma superfície só, divisores
 * de 1px (gap-px sobre o fio), número grande, rótulo pequeno, micro-viz
 * opcional. Não é grade de cards. `escuro` = dentro da faixa de comando navy.
 */
export default function MetricStrip({
  metricas,
  carregando,
  escuro,
}: {
  metricas: Metrica[];
  carregando?: boolean;
  escuro?: boolean;
}) {
  return (
    <dl
      className={`flex gap-px overflow-x-auto rounded-lg border [scrollbar-width:none] sm:flex-wrap sm:overflow-hidden ${
        escuro ? 'border-white/10 bg-white/10' : 'border-oo-line bg-oo-line'
      }`}
    >
      {metricas.map((m) => (
        <div
          key={m.rotulo}
          title={m.title}
          className={`min-w-[150px] flex-[1_0_auto] px-4 py-4 sm:min-w-0 sm:flex-1 sm:basis-[30%] sm:px-6 sm:py-5 xl:basis-0 ${
            escuro ? 'bg-oo-nav' : 'bg-oo-surface'
          }`}
        >
          <dt className={`whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.08em] sm:truncate ${escuro ? 'text-slate-400' : 'text-oo-muted'}`}>
            {m.rotulo}
          </dt>
          <dd
            className={`mt-2.5 font-oo-display text-[28px] font-bold leading-none tracking-[-0.03em] tabular-nums sm:text-[36px] ${
              m.tom ? (escuro ? TOM_ESCURO : TOM_CLARO)[m.tom] : escuro ? 'text-white' : 'text-oo-ink'
            }`}
          >
            {carregando ? (
              <span className={`inline-block h-8 w-16 animate-pulse rounded align-middle ${escuro ? 'bg-white/10' : 'bg-oo-hover'}`} />
            ) : (
              m.valor
            )}
          </dd>
          {m.viz && !carregando && <dd className="mt-3 hidden sm:block">{m.viz}</dd>}
          {m.apoio && (
            <dd className={`mt-2 hidden truncate text-[12px] font-medium sm:block ${escuro ? 'text-slate-400' : 'text-oo-ink-2'}`}>{m.apoio}</dd>
          )}
        </div>
      ))}
    </dl>
  );
}

/** Barra segmentada (distribuição ou progresso). Segmentos com `title` explicam no hover. */
export function BarraSegmentos({ partes, escuro }: { partes: { valor: number; cor: string; title: string }[]; escuro?: boolean }) {
  const total = partes.reduce((s, p) => s + p.valor, 0) || 1;
  return (
    <div className={`flex h-1.5 w-full overflow-hidden rounded-full ${escuro ? 'bg-white/10' : 'bg-oo-hover'}`}>
      {partes
        .filter((p) => p.valor > 0)
        .map((p) => (
          <span key={p.title} title={p.title} className={`h-full ${p.cor} [&+span]:ml-px`} style={{ width: `${(p.valor / total) * 100}%` }} />
        ))}
    </div>
  );
}
