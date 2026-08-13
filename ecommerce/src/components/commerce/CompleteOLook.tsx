import Link from 'next/link';
import Image from 'next/image';
import { Container } from '@/components/layout/Container';
import { Section } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { formatPrice } from '@/lib/utils';
import type { PecaApi } from '@/services/products';

/**
 * COMPLETE O LOOK — as peças que saem na MESMA foto (dono, 13/08/2026).
 *
 * A Regata Alcinha e a Calça Aladdin são fotografadas juntas; quem abre uma
 * tem que ver a outra. O look é curadoria da retaguarda (/retaguarda/looks) —
 * nada aqui é algoritmo. Fase 2 combinada: botão "Comprar o look" que joga
 * todas as peças na sacola de uma vez, quando houver mais fotos de conjunto.
 *
 * Server component: o dado já chega no payload da peça (`peca.look`), zero
 * fetch extra. A própria peça da página vem marcada com `atual` e fica de
 * fora — o bloco só existe se sobrar pelo menos UMA irmã.
 */
export function CompleteOLook({ look }: { look: PecaApi['look'] }) {
  const irmas = (look?.pecas ?? []).filter((p) => !p.atual);
  if (!look || !irmas.length) return null;

  return (
    <Section tone="alt">
      <Container>
        <SectionTitle eyebrow="Sai na mesma foto" title="Complete o look" />
        <div className="mt-8 grid grid-cols-2 gap-4 sm:gap-6 md:grid-cols-3 lg:grid-cols-4">
          {irmas.map((p) => (
            <Link
              key={p.ref}
              href={`/produto/${p.slug}`}
              className="group block min-w-0"
              aria-label={`${p.nome} — parte do look ${look.nome}`}
            >
              <div className="relative aspect-3/4 overflow-hidden rounded-lg bg-surface-alt">
                {p.imagem ? (
                  <Image
                    src={p.imagem}
                    alt={p.nome}
                    fill
                    sizes="(max-width: 768px) 50vw, 25vw"
                    className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-small text-ink-muted">
                    {p.nome}
                  </div>
                )}
              </div>
              <div className="mt-3">
                <p className="truncate text-body text-ink">{p.nome}</p>
                <p className="text-body font-medium text-ink">
                  {formatPrice(p.preco)}
                  {!p.disponivel && (
                    <span className="ml-2 text-small font-light text-ink-muted">esgotada</span>
                  )}
                </p>
              </div>
            </Link>
          ))}
        </div>
      </Container>
    </Section>
  );
}
