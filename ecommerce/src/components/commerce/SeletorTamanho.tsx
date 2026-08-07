import { Check } from 'lucide-react';
import { AppLink as Link } from '@/components/ui/AppLink';
import { cn } from '@/lib/utils';

/**
 * SELETOR DE NUMERAÇÃO — a régua de tamanhos como botão.
 *
 * Desenho definido pelo dono (07/08, mockup com os três estados): pílula
 * grande, contorno fino; hover ganha fundo champagne e borda dourada;
 * selecionado inverte pro dourado sólido com o check no canto.
 *
 * São LINKS, não botões: cada número é uma URL própria (/tamanhos/52), então
 * a cliente pode salvar, mandar no WhatsApp e o Google indexa. Alvo de 44px
 * de altura — o mínimo confortável no celular.
 */
export function SeletorTamanho({
  atual, numeros, className,
}: { atual?: number; numeros: number[]; className?: string }) {
  return (
    <div className={className}>
      <p className="eyebrow text-ink-soft">Escolha sua numeração</p>
      <div className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-6 lg:flex lg:flex-wrap lg:gap-3">
        {numeros.map((n) => {
          const selecionado = n === atual;
          return (
            <Link
              key={n}
              href={`/tamanhos/${n}`}
              aria-current={selecionado ? 'page' : undefined}
              className={cn(
                'tabular relative flex h-11 items-center justify-center rounded-md border text-body transition-all duration-[240ms] lg:min-w-[4.5rem]',
                selecionado
                  ? 'border-primary bg-primary font-medium text-light shadow-gold'
                  : 'border-border bg-surface text-ink hover:border-primary/60 hover:bg-champagne/40',
              )}
            >
              {n}
              {selecionado && (
                <span
                  className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-light"
                  aria-hidden
                >
                  <Check className="size-2.5" strokeWidth={3} />
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
