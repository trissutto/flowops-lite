import { cn } from '@/lib/utils';

/**
 * Indicador de carregamento — anel dourado fino. Usado em botões e em
 * carregamentos curtos; para conteúdo estruturado prefira Skeleton.
 */
export function Spinner({
  className,
  label = 'Carregando',
}: {
  className?: string;
  label?: string;
}) {
  return (
    <span role="status" aria-label={label} className={cn('inline-flex', className)}>
      <svg viewBox="0 0 24 24" className="size-full animate-spin" aria-hidden>
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth="2"
        />
        <path
          d="M22 12a10 10 0 0 0-10-10"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

/** Barra de progresso indeterminada — topo da página em transições. */
export function LoadingBar() {
  return (
    <div
      role="status"
      aria-label="Carregando"
      className="fixed inset-x-0 top-0 z-[var(--z-toast)] h-0.5 overflow-hidden bg-transparent"
    >
      <div className="h-full w-1/3 animate-[loading-slide_1.4s_ease-in-out_infinite] bg-primary" />
      <style>{`@keyframes loading-slide{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}`}</style>
    </div>
  );
}
