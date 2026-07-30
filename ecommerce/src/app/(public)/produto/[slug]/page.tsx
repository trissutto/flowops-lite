import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Container } from '@/components/layout/Container';
import { Section } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { Accordion, AccordionItem } from '@/components/ui/Accordion';
import { ProductGallery } from '@/components/commerce/ProductGallery';
import { BuyBox } from '@/components/commerce/BuyBox';
import { ProductCarousel } from '@/components/sections/ProductCarousel';
import { NewsletterBlock } from '@/components/sections/NewsletterBlock';
import { TestimonialCarousel } from '@/components/sections/TestimonialCarousel';
import { getProduct, getRelated } from '@/services/catalog';
import { testimonials } from '@/data/content';
import { breadcrumbSchema, buildMetadata, jsonLdGraph, productSchema } from '@/lib/seo';

/**
 * PÁGINA DE PRODUTO — dados REAIS do catálogo (backend → WooCommerce).
 *
 * Server Component: preço, estoque, fotos e SEO renderizam no servidor.
 * Só a galeria e a buy box são client (precisam de estado).
 *
 * ISR de 2 minutos: preço e estoque mudam com venda de loja física, então a
 * janela é curta — mas não zero, senão toda visita bate no ERP.
 */

export const revalidate = 120;
/** Catálogo tem milhares de SKUs — geração sob demanda, sem pré-render. */
export const dynamicParams = true;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const result = await getProduct(slug);

  if (!result) {
    return buildMetadata({ title: 'Produto não encontrado', path: `/produto/${slug}`, noIndex: true });
  }

  const { product, shortDescription } = result;

  return buildMetadata({
    title: product.name,
    description:
      shortDescription ||
      `${product.name} — moda plus size do 46 ao 60 na Lurd's. Caimento que valoriza, tecido que abraça.`,
    path: `/produto/${product.slug}`,
    image: product.images[0]?.src,
    keywords: [product.name, `${product.name} plus size`, product.fabric ?? '', 'plus size 46 ao 60'].filter(
      Boolean,
    ),
  });
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await getProduct(slug);

  // Produto inexistente OU catálogo fora do ar: 404 é melhor que página quebrada.
  if (!result) notFound();

  const { product, description, shortDescription } = result;
  const related = await getRelated(slug);

  const categoryLabel = product.category
    .replace(/-/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

  const trail = [
    { name: 'Início', path: '/' },
    { name: categoryLabel, path: `/categoria/${product.category}` },
    { name: product.name, path: `/produto/${product.slug}` },
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdGraph(productSchema(product), breadcrumbSchema(trail)),
        }}
      />

      <Container width="wide" className="pt-8 pb-4">
        <Breadcrumb
          items={trail.map((item, i) => ({
            label: item.name,
            href: i < trail.length - 1 ? item.path : undefined,
          }))}
        />
      </Container>

      {/* Galeria + decisão de compra */}
      <Container width="wide" className="pb-16">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-16">
          <ProductGallery images={product.images} name={product.name} />
          <div className="lg:sticky lg:top-28 lg:self-start">
            <BuyBox product={product} />
          </div>
        </div>
      </Container>

      {/* Detalhes */}
      <Section tone="alt" width="page" space="sm" aria-labelledby="detalhes-titulo">
        <SectionTitle
          id="detalhes-titulo"
          eyebrow="Sobre a peça"
          title="Detalhes e composição"
          align="left"
          hideRule
        />
        <div className="mt-8 grid gap-10 lg:grid-cols-2 lg:gap-16">
          <div>
            {shortDescription && (
              <p className="text-body-lg font-light text-ink-soft">{shortDescription}</p>
            )}
            {description && description !== shortDescription && (
              <p className="mt-5 text-body font-light text-ink-soft">{description}</p>
            )}
            {!description && !shortDescription && (
              <p className="text-body font-light text-ink-soft">
                Peça da curadoria Lurd&apos;s. Para detalhes de composição e caimento, fale com
                uma consultora — ela conhece a peça na mão.
              </p>
            )}
          </div>

          <Accordion>
            <AccordionItem title="Tamanhos disponíveis" defaultOpen>
              <p className="text-body font-light text-ink-soft">
                Do 46 ao 60.{' '}
                {product.sizes.filter((s) => s.available).length > 0
                  ? `Disponível agora nos tamanhos ${product.sizes
                      .filter((s) => s.available)
                      .map((s) => s.label)
                      .join(', ')}.`
                  : 'Esgotado no site — consulte as lojas.'}
              </p>
            </AccordionItem>
            <AccordionItem title="Entrega e retirada">
              <p className="text-body font-light text-ink-soft">
                Frete grátis acima de R$ 399. Você também pode reservar e provar em uma das 14
                lojas antes de levar — se não vestir, não leva e não paga nada.
              </p>
            </AccordionItem>
            <AccordionItem title="Trocas e devoluções">
              <p className="text-body font-light text-ink-soft">
                30 dias para trocar, na loja ou pelo portal de trocas. Sem burocracia.
              </p>
            </AccordionItem>
            <AccordionItem title="Formas de pagamento">
              <p className="text-body font-light text-ink-soft">
                Pix com 5% de desconto, cartão em até 12x sem juros, ou crediário próprio nas
                lojas físicas.
              </p>
            </AccordionItem>
          </Accordion>
        </div>
      </Section>

      {/* Prova social */}
      <Section width="wide" aria-labelledby="avaliacoes-titulo">
        <SectionTitle
          id="avaliacoes-titulo"
          eyebrow="Quem já vestiu"
          title="Altura, peso e o tamanho que ela levou"
          description="A informação que resolve a dúvida de numeração — direto de quem comprou."
        />
        <div className="mt-14">
          <TestimonialCarousel testimonials={testimonials} />
        </div>
      </Section>

      {/* Relacionados */}
      {related.length > 0 && (
        <Section tone="alt" width="wide" aria-labelledby="relacionados-titulo">
          <SectionTitle
            id="relacionados-titulo"
            eyebrow="Combina com"
            title="Você também vai amar"
            cta={{ label: `Ver tudo em ${categoryLabel}`, href: `/categoria/${product.category}` }}
            align="left"
          />
          <div className="mt-14">
            <ProductCarousel products={related} ariaLabel="Produtos relacionados" />
          </div>
        </Section>
      )}

      <NewsletterBlock tone="champagne" />
    </>
  );
}
