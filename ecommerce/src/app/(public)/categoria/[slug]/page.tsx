import type { Metadata } from 'next';
import { Hero } from '@/components/sections/Hero';
import { Section } from '@/components/layout/Section';
import { Container } from '@/components/layout/Container';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { CategoryListing } from '@/components/commerce/CategoryListing';
import { InstagramCard } from '@/components/cards/InstagramCard';
import { NewsletterBlock } from '@/components/sections/NewsletterBlock';
import { EditorialCard } from '@/components/sections/ImageGrid';
import type { GridInterruption } from '@/components/commerce/EditorialProductGrid';
import { CATEGORY_SLUGS, categoryMeta } from '@/services/products';
import { editorials, instagramPosts, looks, storeInteriorImage } from '@/data/content';
import { breadcrumbSchema, buildMetadata, jsonLdGraph } from '@/lib/seo';

/**
 * PÁGINA DE CATEGORIA
 *
 * Server Component: hero, introdução, conteúdo educativo e SEO são estáticos
 * (indexáveis, rápidos); só a listagem é client (filtros e infinite scroll).
 *
 * ISR: `revalidate` de 1h — o catálogo muda por reposição, não por segundo.
 */

export const revalidate = 3600;

/** Pré-renderiza as categorias conhecidas; novas caem no fallback dinâmico. */
export function generateStaticParams() {
  return CATEGORY_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const meta = categoryMeta(slug);

  return buildMetadata({
    title: meta.title,
    description: meta.intro,
    path: `/categoria/${slug}`,
    image: `${meta.heroImage}?q=80&w=1200&auto=format&fit=crop`,
    keywords: [meta.title, `${meta.name} plus size`, `${meta.name} 46 ao 60`, 'moda plus size'],
  });
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const meta = categoryMeta(slug);

  const trail = [
    { name: 'Início', path: '/' },
    { name: 'Categorias', path: '/categoria' },
    { name: meta.name, path: `/categoria/${slug}` },
  ];

  /**
   * Blocos que quebram o ritmo da grade. As posições (6, 14, 22) foram
   * escolhidas pra cair depois de uma fileira completa em qualquer breakpoint.
   */
  const interruptions: GridInterruption[] = [
    {
      at: 6,
      kind: 'image',
      image: { src: `${meta.heroImage}?q=80&w=1400&auto=format&fit=crop`, alt: `Editorial ${meta.name}` },
      caption: `${meta.name} da coleção atual`,
      href: '/colecoes/atual',
    },
    { at: 14, kind: 'look', look: looks[0] },
    {
      at: 22,
      kind: 'banner',
      eyebrow: 'Comprar e retirar',
      title: 'Prove antes de levar',
      description:
        'Reserve a peça e experimente na loja mais perto de você. Se não vestir, você não leva — e não paga nada.',
      href: '/lojas/comprar-e-retirar',
      cta: 'Como funciona',
    },
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdGraph(breadcrumbSchema(trail)) }}
      />

      {/* 01 — HERO EDITORIAL */}
      <Hero
        image={{
          src: `${meta.heroImage}?q=85&w=2000&auto=format&fit=crop`,
          alt: `${meta.title} — editorial Lurds`,
        }}
        eyebrow="Coleção"
        title={meta.name}
        subtitle={meta.intro}
        height="medium"
        align="left"
        overlay="medium"
        parallax={false}
        priority
        above={
          <Breadcrumb
            tone="light"
            items={trail.map((item, i) => ({
              label: item.name,
              href: i < trail.length - 1 ? item.path : undefined,
            }))}
          />
        }
      />

      {/* 02 — INTRODUÇÃO */}
      <Section width="text" space="sm">
        <SectionTitle
          eyebrow={`${meta.name} do 46 ao 60`}
          title={meta.title}
          description={meta.intro}
          as="h2"
        />
      </Section>

      {/* 03 a 08 — BARRA + FILTROS + GRID EDITORIAL + INTERRUPÇÕES */}
      <Container width="wide">
        <CategoryListing
          category={slug}
          categoryName={meta.name}
          interruptions={interruptions}
        />
      </Container>

      {/* 09 — CONTEÚDO EDUCATIVO (SEO + permanência) */}
      <Section tone="alt" width="text" aria-labelledby="guia-titulo">
        <SectionTitle
          id="guia-titulo"
          eyebrow="Guia Lurds"
          title={meta.guide.title}
          align="left"
          hideRule
        />
        <div className="mt-8 flex flex-col gap-5">
          {meta.guide.paragraphs.map((paragraph) => (
            <p key={paragraph.slice(0, 24)} className="text-body-lg font-light text-ink-soft">
              {paragraph}
            </p>
          ))}
        </div>

        <div className="mt-16 grid gap-10 sm:grid-cols-2">
          {editorials.slice(0, 2).map((article, index) => (
            <EditorialCard key={article.slug} article={article} index={index} />
          ))}
        </div>
      </Section>

      {/* 10 — INSTAGRAM */}
      <Section width="wide" aria-labelledby="ig-categoria">
        <SectionTitle
          id="ig-categoria"
          eyebrow="@lurdsplussize"
          title={`${meta.name} nas clientes reais`}
          cta={{ label: 'Ver no Instagram', href: 'https://www.instagram.com/lurdsplussize' }}
          align="left"
        />
        <div className="mt-14 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {instagramPosts.map((post) => (
            <InstagramCard key={post.id} post={post} />
          ))}
        </div>
      </Section>

      {/* 11 — NEWSLETTER */}
      <NewsletterBlock
        tone="champagne"
        title={
          <>
            Avise quando chegar
            <br />
            <span className="italic">{meta.name.toLowerCase()} novo</span>
          </>
        }
        description={`Uma mensagem por semana com as novidades de ${meta.name.toLowerCase()} e o que entrou na loja mais perto de você.`}
      />

      {/* Imagem institucional de fechamento (evita o corte seco pro footer) */}
      <div className="relative aspect-21/9 w-full overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element -- decorativa, sem LCP */}
        <img
          src={`${storeInteriorImage.src}?q=80&w=2000&auto=format&fit=crop`}
          alt={storeInteriorImage.alt}
          loading="lazy"
          className="size-full object-cover"
        />
      </div>
    </>
  );
}
