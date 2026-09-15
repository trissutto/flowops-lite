import type { ReactNode } from 'react';
import { Check, X } from 'lucide-react';

/* ───────────────────────── StatusIndicator ─────────────────────────
   Ponto + texto. Cheio = em uso; vazado = fora de operação. */
export type TomStatus = 'success' | 'info' | 'warning' | 'neutral' | 'muted';

const PONTO: Record<TomStatus, string> = {
  success: 'bg-oo-success',
  info: 'bg-oo-info',
  warning: 'bg-oo-warning',
  neutral: 'bg-oo-ink',
  muted: 'border-[1.5px] border-oo-muted bg-transparent',
};

export function StatusIndicator({ tom, children }: { tom: TomStatus; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-[13px] font-medium text-oo-ink">
      <span className={`h-2 w-2 shrink-0 rounded-full ${PONTO[tom]}`} aria-hidden="true" />
      {children}
    </span>
  );
}

/* ───────────────────────── RiskBar ─────────────────────────
   Faixa lateral de 3px. Forma além de cor: a posição já informa. */
export type Risco = 'critico' | 'atencao' | null;

export function RiskBar({ risco }: { risco: Risco }) {
  if (!risco) return null;
  return (
    <span
      aria-hidden="true"
      className={`absolute bottom-2 left-0 top-2 w-[3px] rounded-r ${risco === 'critico' ? 'bg-oo-danger' : 'bg-oo-warning'}`}
    />
  );
}

/* ───────────────────────── DocumentStatus ─────────────────────────
   Um marcador por documento; tooltip no hover/foco diz o que é. */
export type EstadoDoc = 'ok' | 'pendente' | 'vencido';

const MARCA: Record<EstadoDoc, string> = {
  ok: 'border-oo-line bg-oo-surface text-oo-success',
  pendente: 'border-oo-warning/40 bg-oo-warning-soft text-oo-warning',
  vencido: 'border-oo-danger/40 bg-oo-danger-soft text-oo-danger',
};

const FRASE: Record<EstadoDoc, string> = {
  ok: 'cadastrado',
  pendente: 'pendente',
  vencido: 'vencido',
};

export function DocumentStatus({ docs }: { docs: { nome: string; estado: EstadoDoc; nota?: string }[] }) {
  return (
    <ul className="flex items-center gap-1" aria-label="Documentos">
      {docs.map((d) => (
        <li key={d.nome} className="group/doc relative">
          <span
            tabIndex={0}
            aria-label={`${d.nome}: ${d.nota || FRASE[d.estado]}`}
            className={`grid h-6 w-6 place-items-center rounded-[5px] border text-[11px] font-bold outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-oo-primary ${MARCA[d.estado]}`}
          >
            {d.estado === 'ok' ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : d.estado === 'vencido' ? <X className="h-3.5 w-3.5" strokeWidth={2.5} /> : '!'}
          </span>
          <span
            role="tooltip"
            className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-oo-nav px-2 py-1 text-[12px] font-medium text-white opacity-0 shadow-oo-pop transition-opacity duration-150 group-hover/doc:opacity-100 group-focus-within/doc:opacity-100"
          >
            <span className="font-semibold">{d.nome}</span> · {d.nota || FRASE[d.estado]}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ───────────────────────── EmptyState ───────────────────────── */
export function EmptyState({
  icone,
  titulo,
  texto,
  acoes,
}: {
  icone: ReactNode;
  titulo: ReactNode;
  texto?: ReactNode;
  acoes?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-lg border border-oo-line bg-oo-subtle text-oo-ink-2">{icone}</span>
      <div className="mt-4 font-oo-display text-[17px] font-semibold text-oo-ink">{titulo}</div>
      {texto && <div className="mt-1 max-w-sm text-[14px] text-oo-ink-2">{texto}</div>}
      {acoes && <div className="mt-5 flex flex-wrap justify-center gap-2">{acoes}</div>}
    </div>
  );
}
