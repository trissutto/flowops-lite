import type { Metadata } from 'next';
import { Section } from '@/components/layout/Section';
import { Container } from '@/components/layout/Container';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { CategoryListing } from '@/components/commerce/CategoryListing';
import { ChipsSubcategoria } from '@/components/commerce/ChipsSubcategoria';
import { InstagramCard } from '@/components/cards/InstagramCard';
import { NewsletterBlock } from '@/components/sections/NewsletterBlock';
import { EditorialCard } from '@/components/sections/ImageGrid';
import { CATEGORY_SLUGS, categoryMeta } from '@/services/products';
import { fetchPrimeiraPagina } from '@/services/vitrine';
import { getCategorias } from '@/services/categorias-menu';
import { editorials, instagramPosts, storeInteriorImage } from '@/data/content';
import { breadcrumbSchema, buildMetadata, jsonLdGraph } from '@/lib/seo';

/**
 * PÁGINA DE CATEGORIA
 *
 * Server Component: cabeçalho, conteúdo educativo e SEO são estáticos
 * (indexáveis, rápidos); só a listagem é client (filtros e infinite scroll).
 *
 * ⚠️ SEM HERO E SEM INTERRUPÇÃO NA GRADE (dono 07/08): "retire estes banners
 * dentro das categorias, quanto mais direto for pro produto, melhor a
 * conversão". Antes a peça só aparecia depois de um hero em tela cheia +
 * texto de introdução, e a grade de produto era cortada a cada ~8 peças por
 * um card editorial, um look ou um banner de loja — três desvios do caminho
 * "entrou → viu produto → comprou". Cabeçalho agora é uma linha (breadcrumb +
 * título), e a grade não tem mais interrupção nenhuma.
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
  // NOVIDADES é a ordem padrão de toda categoria (dono 07/08): a cliente que
  // volta toda semana precisa ver o que ENTROU, não a mesma vitrine de sempre.
  // ⚠️ Tem que casar com o `ordemPadrao` do CategoryListing abaixo — se as duas
  // divergirem, a página 1 vinda do servidor (ordenada aqui) seria exibida como
  // se fosse a ordem do cliente, e a cliente veria uma lista que não pediu.
  const primeiraPagina = await fetchPrimeiraPagina({
    categoria: slug,
    perPage: 24,
    ordenar: 'novidades',
  });

  const trail = [
    { name: 'Início', path: '/' },
    { name: 'Categorias', path: '/categoria' },
    { name: meta.name, path: `/categoria/${slug}` },
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdGraph(breadcrumbSchema(trail)) }}
      />

      {/* 01 — CABEÇALHO ENXUTO (sem hero de tela cheia — direto pro produto) */}
      <Section width="wide" space="sm">
        <Breadcrumb
          items={trail.map((item, i) => ({
            label: item.name,
            href: i < trail.length - 1 ? item.path : undefined,
          }))}
        />
        <SectionTitle eyebrow={`${meta.name} do 46 ao 60`} title={meta.title} as="h1" />
      </Section>

      {/* 02 — BARRA + FILTROS + GRID, SEM INTERRUPÇÃO NENHUMA */}
      <Container width="wide">
        <CategoryListing
          category={slug}
          categoryName={meta.name}
          /* Mesma ordem do `fetchPrimeiraPagina` acima — ver comentário lá. */
          ordemPadrao="novidades"
          /* Página 1 pronta no servidor: a peça vem no HTML em vez de esperar
             o JS + duas viagens à API (perf, 07/08). */
          primeiraPagina={primeiraPagina}
        />
      </Container>

      {/* 03 — CONTEÚDO EDUCATIVO (SEO + permanência) — só DEPOIS da grade
          inteira, nunca interrompendo o caminho até o produto. */}
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
