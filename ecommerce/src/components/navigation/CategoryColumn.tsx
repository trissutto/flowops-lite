import { AppLink as Link } from '@/components/ui/AppLink';
import { cn } from '@/lib/utils';
import type { MenuColumn } from '@/types';

/**
 * CategoryColumn — uma coluna de links do mega menu.
 * O título usa eyebrow dourado; os links têm o sublinhado animado da marca.
 */
export function CategoryColumn({ column, className }: { column: MenuColumn; className?: string }) {
  const hasTitle = column.title.trim().length > 0;

  return (
    <div className={cn('min-w-0', className)}>
      {/* Coluna de continuação (ex: tamanhos 54-60) vem com título em branco:
          mantém o espaço reservado pro alinhamento sem repetir o rótulo. */}
      <p className={cn('eyebrow', hasTitle ? 'text-primary-strong' : 'invisible')} aria-hidden={!hasTitle}>
        {hasTitle ? column.title : '—'}
      </p>
      <ul className="mt-5 flex flex-col gap-3">
        {column.links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
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
    </div>
  );
}
