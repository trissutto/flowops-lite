import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';

/**
 * Estado vazio elegante — nunca uma frase seca no meio da tela.
 * Sempre: um ícone discreto, um título serif, uma orientação e uma saída.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: { label: string; href?: string; onClick?: () => void };
  secondaryAction?: { label: string; href: string };
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-20 text-center', className)}>
      {icon && (
        <div className="mb-7 flex size-14 items-center justify-center rounded-pill border border-primary/40 bg-surface text-primary-strong [&_svg]:size-6">
          {icon}
        </div>
      )}
      <h3 className="font-display text-h3">{title}</h3>
      {description && (
        <p className="mt-3 max-w-md text-body font-light text-ink-soft">{description}</p>
      )}
      {(action || secondaryAction) && (
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          {action &&
            (action.href ? (
              <Button href={action.href}>{action.label}</Button>
            ) : (
              <Button onClick={action.onClick}>{action.label}</Button>
            ))}
          {secondaryAction && (
            <Button href={secondaryAction.href} variant="secondary">
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
