import { AppLink as Link } from '@/components/ui/AppLink';
import { cn } from '@/lib/utils';
import type { MenuColumn } from '@/types';

/**
 * CategoryColumn — uma coluna de links do mega menu.
 * O título usa eyebrow dourado; os links têm o sublinhado animado da marca.
 *
 * Duas formas (ver `MenuColumn.layout`): lista de texto, o padrão, e grade de
 * pílulas pra numeração — mesmo desenho do `SeletorTamanho` da página de
 * tamanhos, pra cliente reconhecer o mesmo controle nos dois lugares.
 */
export function CategoryColumn({
  column,
  className,
  onNavigate,
}: {
  column: MenuColumn;
  className?: string;
  /** Fecha o painel no clique — ver o comentário em `MegaMenu`. */
  onNavigate?: () => void;
}) {
  const hasTitle = column.title.trim().length > 0;
  const pilulas = column.layout === 'pilulas';

  return (
    <div className={cn('min-w-0', className)}>
      {/* Coluna de continuação (ex: tamanhos 54-60) vem com título em branco:
          mantém o espaço reservado pro alinhamento sem repetir o rótulo. */}
      <p className={cn('eyebrow', hasTitle ? 'text-primary-strong' : 'invisible')} aria-hidden={!hasTitle}>
        {hasTitle ? column.title : '—'}
      </p>

      {pilulas ? (
        // `flex-wrap` e não grade fixa: a régua tem 9 números hoje e pode ter
        // outro amanhã — a linha quebra sozinha sem ninguém recontar coluna.
        <ul className="mt-5 flex flex-wrap gap-2">
          {column.links.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                onClick={onNavigate}
                className={cn(
                  'tabular flex h-11 min-w-[3.25rem] items-center justify-center rounded-md border px-3',
                  'border-border bg-surface text-body text-ink transition-all duration-[240ms]',
                  'hover:border-primary/60 hover:bg-champagne/40 hover:text-ink',
                )}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="mt-5 flex flex-col gap-3">
          {column.links.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                onClick={onNavigate}
                className={cn(
                  'link-underline inline-block text-body transition-colors',
                  link.highlight ? 'font-medium text-ink' : 'font-light text-ink-soft hover:text-ink',
                )}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
