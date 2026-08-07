import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Container } from '@/components/layout/Container';
import { Section } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { Accordion, AccordionItem } from '@/components/ui/Accordion';
import { ProductGallery } from '@/components/commerce/ProductGallery';
import { BuyBox } from '@/components/commerce/BuyBox';
import { ProductPageSignals } from '@/components/commerce/ProductPageSignals';
import { RecommendationRail } from '@/components/commerce/RecommendationRail';
import { NewsletterBlock } from '@/components/sections/NewsletterBlock';
import { getProduct } from '@/services/catalog';
import { fetchPeca } from '@/services/peca';
import { EscolhaDaPeca } from '@/components/commerce/EscolhaDaPeca';
import { breadcrumbSchema, buildMetadata, jsonLdGraph, productSchema } from '@/lib/seo';

/**
 * PÁGINA DE PRODUTO — dados REAIS do catálogo (backend → WooCommerce).
 *
 * Server Component: preço, estoque, fotos e SEO renderizam no servidor.
 * Só a galeria e a buy box são client (precisam de estado).
 *
 * SEM ISR de propósito: o fetch da peça é `no-store` (ver services/peca.ts),
 * porque estoque servido do cache stale deixou tamanho esgotado comprável por
 * horas (caso VOGUE VINHO 06/08). A rota é dinâmica; o dado do catálogo sai
 * do Postgres local do backend, que aguenta uma query por visita.
 */

/** Catálogo tem milhares de SKUs — geração sob demanda, sem pré-render. */
export const dynamicParams = true;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  // Mesma ordem de fontes da página — título e OG têm que descrever o que a
  // cliente vai ver, não o que o catálogo antigo tinha.
  const peca = await fetchPeca(slug);
  const result = peca ?? (await getProduct(slug));

  if (!result) {
    return buildMetadata({ title: 'Produto não encontrado', path: `/produto/${slug}`, noIndex: true });
  }

  const { product } = result;
  const shortDescription =
    'descricaoCurta' in result ? result.descricaoCurta : result.shortDescription;

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

  // CATÁLOGO NOVO primeiro (ficha do CRM: cor com foto, grade e preço por
  // cor). A vitrine antiga do WooCommerce fica como rede enquanto a migração
  // de conteúdo não termina.
  const peca = await fetchPeca(slug);
  const result = peca ?? (await getProduct(slug));

  // Produto inexistente OU catálogo fora do ar: 404 é melhor que página quebrada.
  if (!result) notFound();

  const { product } = result;
  const description = 'descricao' in result ? result.descricao : result.description;
  const shortDescription =
    'descricaoCurta' in result ? result.descricaoCurta : result.shortDescription;
  const cores = peca?.cores ?? [];

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
        {cores.length > 0 ? (
          <EscolhaDaPeca product={product} cores={cores} />
        ) : (
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-16">
            <ProductGallery images={product.images} name={product.name} />
            <div className="lg:sticky lg:top-28 lg:self-start">
              <BuyBox product={product} />
            </div>
          </div>
        )}
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
              {/* ⚠️ Dizia "Frete grátis acima de R$ 399" — número chumbado que
                  ficou errado no dia em que a régua virou config (hoje R$
                  499,90, editável na retaguarda). Prometer valor errado aqui é
                  pior que não prometer: o simulador logo acima já mostra o
                  frete REAL pro CEP dela, com a régua vigente. */}
              <p className="text-body font-light text-ink-soft">
                Calcule o frete e o prazo pelo seu CEP na caixa acima. Você também pode
                reservar e provar em uma das 14 lojas antes de levar — se não vestir, não
                leva e não paga nada.
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

      {/*
        PROVA SOCIAL · REMOVIDA DO AR EM 06/08/2026

        Mostrava depoimentos assinados por "Cliente Lurds" com ALTURA, PESO e
        TAMANHO COMPRADO inventados, sob o título "direto de quem comprou".

        Aqui era pior que na home: ficava na página do produto, ao lado da peça
        que a cliente está decidindo, e **as mesmas quatro frases apareciam em
        TODAS as peças** — a "avaliação" não tinha relação nenhuma com o produto
        que ela estava olhando.

        Volta quando houver avaliação real. O caminho já existe: todo pedido
        entregue tem CPF, peça e tamanho — dá pra pedir por e-mail/WhatsApp
        depois da entrega e amarrar a resposta à REF certa.
      */}

      {/*
        Recomendações — client-side via motor (lib/recommendations/engine).
        Cada rail se auto-remove quando não há o que mostrar, então a página
        pode empilhar os três sem medo de seção vazia. O rail de relacionados
        substituiu o antigo bloco server-side (getRelated/WooCommerce) — a
        fonte agora é o endpoint nativo /public/loja/.../relacionados.
      */}
      <RecommendationRail
        kind="voce-tambem-pode-gostar"
        seed={product}
        eyebrow="Combina com"
        title="Você também pode gostar"
        cta={{ label: `Ver tudo em ${categoryLabel}`, href: `/categoria/${product.category}` }}
        tone="alt"
      />
      <RecommendationRail
        kind="complete-seu-look"
        seed={product}
        eyebrow="Estilo completo"
        title="Complete seu look"
        description="Peças que fecham a produção com esta escolha — escolhidas pela curadoria, não pelo acaso."
      />
      <RecommendationRail
        kind="ultimos-vistos"
        seed={product}
        eyebrow="Sua navegação"
        title="Vistos por você"
        tone="alt"
      />

      {/* Sinais locais: últimos vistos + personalização (client, invisível) */}
      <ProductPageSignals product={product} />

      <NewsletterBlock tone="champagne" />
    </>
  );
}
