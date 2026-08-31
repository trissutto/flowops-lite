import { Section } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { VitrineGrid } from '@/components/sections/VitrineGrid';
import type { VitrineHome } from '@/services/vitrines-home';

/** Prateleira da home compartilhada pelo HTML inicial e pela carga adiada. */
export function HomeShelf({ vitrine }: { vitrine: VitrineHome }) {
  return (
    <Section
      width="wide"
      aria-labelledby={`vitrine-${vitrine.id}`}
      className="!py-5 sm:!py-12"
    >
      <SectionTitle
        id={`vitrine-${vitrine.id}`}
        eyebrow={vitrine.eyebrow ?? undefined}
        title={vitrine.titulo}
        mobileTitle={vitrine.tituloMobile ?? undefined}
        description={vitrine.descricao ?? undefined}
        cta={
          vitrine.ctaHref
            ? { label: vitrine.ctaLabel ?? 'Ver todas', href: vitrine.ctaHref }
            : undefined
        }
        align="left"
        compactMobile
        titleFont="editorial"
      />
      <div className="mt-3 sm:mt-10">
        <VitrineGrid products={vitrine.produtos} listName={vitrine.titulo} />
      </div>

      {vitrine.ctaHref && (
        <div className="mt-5 sm:hidden">
          <a
            href={vitrine.ctaHref}
            className="flex h-12 w-full items-center justify-center rounded-pill border border-border-strong bg-surface text-[0.6875rem] font-medium tracking-[0.16em] text-ink uppercase transition-colors hover:border-primary hover:text-primary-strong"
          >
            {vitrine.ctaLabel ?? `Ver tudo em ${vitrine.titulo}`}
          </a>
        </div>
      )}
    </Section>
  );
}
