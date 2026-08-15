import { AppLink as Link } from '@/components/ui/AppLink';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Breadcrumb — trilha discreta. O JSON-LD correspondente é responsabilidade
 * da página (breadcrumbSchema em lib/seo.ts), não deste componente.
 */

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumb({
  items,
  /** Sobre foto escura (hero) usa a variante clara. */
  tone = 'default',
  className,
  colapsarNoMobile = false,
}: {
  items: Crumb[];
  tone?: 'default' | 'light';
  className?: string;
  /**
   * Esconde a ÚLTIMA migalha no celular — a que nomeia a página atual.
   *
   * Existe pra PDP (dono, 15/08: "temos a descrição duas vezes"): o nome da
   * peça aparecia aqui, em 13px de navegação, e de novo como título acima do
   * preço. Some daqui, não do título: ali ele é caminho, no `<h1>` é a
   * manchete da peça — e no desktop é o único nome da coluna de compra.
   *
   * O JSON-LD do BreadcrumbList é montado pela página, com a trilha
   * COMPLETA, então o rich snippet do Google não perde o degrau.
   */
  colapsarNoMobile?: boolean;
}) {
  return (
    <nav aria-label="Você está em" className={className}>
      <ol
        className={cn(
          'flex flex-wrap items-center gap-2 text-small',
          tone === 'light' ? 'text-light/75' : 'text-ink-muted',
        )}
      >
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          /* A seta mora no item ANTERIOR: escondendo só a última migalha, o
             penúltimo ficaria com um "›" apontando pro nada. */
          const somenteDesktop = colapsarNoMobile && items.length > 1 && isLast;
          const setaSomenteDesktop = colapsarNoMobile && i === items.length - 2;
          return (
            <li
              key={`${item.label}-${i}`}
              className={cn('flex items-center gap-2', somenteDesktop && 'hidden sm:flex')}
            >
              {item.href && !isLast ? (
                <Link
                  href={item.href}
                  className={cn(
                    'transition-colors',
                    tone === 'light' ? 'hover:text-light' : 'hover:text-ink',
                  )}
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={isLast ? 'page' : undefined}
                  className={tone === 'light' ? 'text-light' : 'text-ink'}
                >
                  {item.label}
                </span>
              )}
              {!isLast && (
                <ChevronRight
                  className={cn(
                    'size-3 opacity-50',
                    setaSomenteDesktop && 'hidden sm:block',
                  )}
                  aria-hidden
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
