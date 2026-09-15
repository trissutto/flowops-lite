import type { ReactNode } from 'react';

/** Título da página + linha de apoio + ações à direita. `escuro` = faixa de comando navy. */
export default function PageHeader({
  titulo,
  subtitulo,
  icone,
  acoes,
  escuro,
}: {
  titulo: ReactNode;
  subtitulo?: ReactNode;
  icone?: ReactNode;
  acoes?: ReactNode;
  escuro?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 items-center gap-4">
        {icone && (
          <span
            className={`grid h-12 w-12 shrink-0 place-items-center rounded-lg border ${
              escuro ? 'border-white/10 bg-white/[0.04] text-white' : 'border-oo-line bg-oo-surface text-oo-ink'
            }`}
          >
            {icone}
          </span>
        )}
        <div className="min-w-0">
          <h1
            className={`font-oo-display text-[28px] font-bold leading-[1.05] tracking-[-0.03em] sm:text-[34px] ${
              escuro ? 'text-white' : 'text-oo-ink'
            }`}
          >
            {titulo}
          </h1>
          {subtitulo && (
            <p className={`mt-1.5 text-[14px] font-medium ${escuro ? 'text-slate-400' : 'text-oo-ink-2'}`}>{subtitulo}</p>
          )}
        </div>
      </div>
      {acoes && <div className="flex shrink-0 items-center gap-2">{acoes}</div>}
    </div>
  );
}
