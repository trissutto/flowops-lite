import type { ReactNode } from 'react';

/** Título da página + linha de apoio + ações à direita. */
export default function PageHeader({
  titulo,
  subtitulo,
  icone,
  acoes,
}: {
  titulo: ReactNode;
  subtitulo?: ReactNode;
  icone?: ReactNode;
  acoes?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 items-center gap-4">
        {icone && (
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-oo-line bg-oo-surface text-oo-ink">
            {icone}
          </span>
        )}
        <div className="min-w-0">
          <h1 className="font-oo-display text-[26px] font-bold leading-[1.1] tracking-[-0.025em] text-oo-ink sm:text-[30px]">
            {titulo}
          </h1>
          {subtitulo && <p className="mt-1 text-[14px] font-medium text-oo-ink-2">{subtitulo}</p>}
        </div>
      </div>
      {acoes && <div className="flex shrink-0 items-center gap-2">{acoes}</div>}
    </div>
  );
}
