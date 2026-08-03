import { MapPin, MessageCircle } from 'lucide-react';
import { Hero } from '@/components/sections/Hero';
import { Manifesto } from '@/components/sections/Manifesto';
import { Section } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { ProductCarousel } from '@/components/sections/ProductCarousel';
import { LookShowcase } from '@/components/sections/LookShowcase';
import { TestimonialCarousel } from '@/components/sections/TestimonialCarousel';
import { VideoBlock } from '@/components/sections/VideoBlock';
import { CTABanner } from '@/components/sections/CTABanner';
import { EditorialCard, ImageGrid } from '@/components/sections/ImageGrid';
import { NewsletterBlock } from '@/components/sections/NewsletterBlock';
import { OccasionCard, FitCard } from '@/components/cards/TaxonomyCard';
import { FabricCard } from '@/components/cards/FabricCard';
import { StoreCard } from '@/components/cards/StoreCard';
import { InstagramCard } from '@/components/cards/InstagramCard';
import { Button } from '@/components/ui/Button';
import {
  bestSellers,
  editorialGridItems,
  editorials,
  fabrics,
  fits,
  instagramPosts,
  institutionalVideo,
  looks,
  manifesto,
  newArrivals,
  occasions,
  testimonials,
} from '@/data/content';
import { featuredStores, stores } from '@/data/stores';
import { getHeroDaHome } from '@/services/banners';
import { buildMetadata, itemListSchema, jsonLdGraph, storeSchema } from '@/lib/seo';

/**
 * HOME — a jornada da cliente em 15 movimentos.
 *
 * A ordem não é decorativa: abre com desejo (hero), explica quem somos
 * (manifesto), mostra o novo, ensina a escolher (ocasião → tecido →
 * modelagem), prova com best sellers e depoimentos, inspira (editorial,
 * vídeo, Instagram) e fecha convidando pra loja física — que é onde a
 * conversão da Lurds acontece de verdade.
 *
 * Server Component: só as seções interativas (carrosséis, cards com hover)
 * são client. Ver docs/home.md.
 */

export const metadata = buildMetadata({
  title: "Lurd's Plus Size — Moda plus size elegante do 46 ao 60",
  path: '/',
  keywords: [
    'moda plus size',
    'roupas plus size',
    'vestido plus size',
    'loja plus size',
    'plus size 46 ao 60',
  ],
});

export default async function HomePage() {
  // O hero vem do cadastro de banners da retaguarda; se não houver campanha
  // no ar (ou o backend estiver fora), volta pro estático sem quebrar a home.
  const hero = await getHeroDaHome();

  const jsonLd = jsonLdGraph(
    itemListSchema([...newArrivals, ...bestSellers], 'Destaques da home'),
    ...stores.map(storeSchema),
  );

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />

      {/* 01 — HERO EDITORIAL */}
      <Hero
        image={hero.image}
        imageMobile={hero.imageMobile}
        eyebrow={hero.eyebrow}
        title={
          <>
            {hero.lead}
            {hero.emphasis && (
              <>
                <br />
                <span className="text-primary-soft italic">{hero.emphasis}</span>
              </>
            )}
          </>
        }
        subtitle={hero.subtitle}
        primaryAction={hero.primaria}
        secondaryAction={hero.secundaria}
        height="fullscreen"
        align="center"
        overlay="medium"
        showScrollHint
        priority
      />

      {/* 02 — MANIFESTO */}
      <Manifesto
        eyebrow={manifesto.eyebrow}
        title={manifesto.title}
        paragraphs={manifesto.paragraphs}
        stats={manifesto.stats}
      />

      {/* 03 — NOVIDADES */}
      <Section tone="alt" width="wide" aria-labelledby="novidades-titulo">
        <SectionTitle
          id="novidades-titulo"
          eyebrow="Acabou de chegar"
          title="Novidades da semana"
          description="Peças novas toda semana — nas lojas e aqui, ao mesmo tempo."
          cta={{ label: 'Ver todos os lançamentos', href: '/novidades' }}
          align="left"
        />
        <div className="mt-14">
          <ProductCarousel products={newArrivals} ariaLabel="Novidades da semana" />
        </div>
      </Section>

      {/* 04 — SHOP THE LOOK */}
      <Section width="wide" aria-labelledby="looks-titulo">
        <SectionTitle
          id="looks-titulo"
          eyebrow="Shop the look"
          title="O look inteiro, resolvido"
          description="Composições prontas pelas nossas consultoras. Leve completo ou escolha peça por peça."
          cta={{ label: 'Ver todos os looks', href: '/looks' }}
          align="left"
        />
        <div className="mt-14">
          <LookShowcase looks={looks} />
        </div>
      </Section>

      {/* 05 — COMPRE POR OCASIÃO */}
      <Section tone="alt" width="wide" aria-labelledby="ocasioes-titulo">
        <SectionTitle
          id="ocasioes-titulo"
          eyebrow="Para onde você vai"
          title="Compre por ocasião"
          description="Você não busca “vestido tamanho 52”. Busca o que vestir no casamento de sábado."
        />
        <div className="mt-14 grid grid-cols-2 gap-4 lg:grid-cols-4 lg:gap-6">
          {occasions.map((occasion, index) => (
            <OccasionCard key={occasion.slug} data={occasion} index={index} />
          ))}
        </div>
      </Section>

      {/* 06 — MODA POR TECIDO */}
      <Section width="wide" aria-labelledby="tecidos-titulo">
        <SectionTitle
          id="tecidos-titulo"
          eyebrow="O caimento começa aqui"
          title="Moda por tecido"
          description="Cada material veste de um jeito. Escolher pelo tecido é o atalho pro caimento certo."
          cta={{ label: 'Guia completo de tecidos', href: '/tecidos' }}
          align="left"
        />
        <div className="mt-14 grid grid-cols-2 gap-4 lg:grid-cols-3 lg:gap-6 xl:grid-cols-6">
          {fabrics.map((fabric, index) => (
            <FabricCard key={fabric.slug} data={fabric} index={index} />
          ))}
        </div>
      </Section>

      {/* 07 — MODA POR MODELAGEM */}
      <Section tone="champagne" width="page" aria-labelledby="modelagem-titulo">
        <SectionTitle
          id="modelagem-titulo"
          eyebrow="Consultoria de estilo"
          title="Moda por modelagem"
          description="O que você quer valorizar hoje? A gente organiza a vitrine por isso."
        />
        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
          {fits.map((fit, index) => (
            <FitCard key={fit.slug} data={fit} index={index} />
          ))}
        </div>
      </Section>

      {/* 08 — BEST SELLERS */}
      <Section width="wide" aria-labelledby="best-sellers-titulo">
        <SectionTitle
          id="best-sellers-titulo"
          eyebrow="Aprovadas pelas clientes"
          title="As mais amadas"
          description="As peças que mais voltam pra sacola — e que a gente repõe sem parar."
          cta={{ label: 'Ver mais vendidos', href: '/novidades/mais-vendidos' }}
          align="left"
        />
        <div className="mt-14">
          <ProductCarousel products={bestSellers} ariaLabel="Produtos mais vendidos" />
        </div>
      </Section>

      {/* 09 — EDITORIAL DA SEMANA */}
      <Section tone="alt" width="wide" aria-labelledby="editorial-titulo">
        <SectionTitle
          id="editorial-titulo"
          eyebrow="Editorial"
          title="A semana em imagens"
          description="Bastidores, provador e o que a gente aprendeu vestindo mulheres reais."
        />
        <div className="mt-14">
          <ImageGrid items={editorialGridItems} layout="feature" />
        </div>
        <div className="mt-16 grid gap-10 lg:grid-cols-3 lg:gap-8">
          {editorials.map((article, index) => (
            <EditorialCard key={article.slug} article={article} index={index} />
          ))}
        </div>
      </Section>

      {/* 10 — VÍDEO INSTITUCIONAL */}
      <Section width="wide" space="sm">
        <VideoBlock
          video={institutionalVideo}
          eyebrow="Por dentro da Lurds"
          title="Um provador sem pressa, um atendimento que acolhe"
          aspect="21/9"
          caption="Nossas consultoras são treinadas em caimento e modelagem plus size."
        />
      </Section>

      {/* 11 — DEPOIMENTOS */}
      <Section tone="alt" width="wide" aria-labelledby="depoimentos-titulo">
        <SectionTitle
          id="depoimentos-titulo"
          eyebrow="Quem já vestiu"
          title="Altura, peso e o tamanho que ela levou"
          description="A informação que ninguém mostra — e que resolve a dúvida de tamanho."
        />
        <div className="mt-14">
          <TestimonialCarousel testimonials={testimonials} />
        </div>
      </Section>

      {/* 12 — INSTAGRAM */}
      <Section width="wide" aria-labelledby="instagram-titulo">
        <SectionTitle
          id="instagram-titulo"
          eyebrow="@lurdsplussize"
          title="No feed e no seu guarda-roupa"
          cta={{ label: 'Seguir no Instagram', href: 'https://www.instagram.com/lurdsplussize' }}
          align="left"
        />
        <div className="mt-14 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {instagramPosts.map((post) => (
            <InstagramCard key={post.id} post={post} />
          ))}
        </div>
      </Section>

      {/* 13 — NOSSAS LOJAS */}
      <Section tone="alt" width="wide" aria-labelledby="lojas-titulo">
        <SectionTitle
          id="lojas-titulo"
          eyebrow="Visite a Lurds"
          title="14 endereços, o mesmo acolhimento"
          description="Prove com calma, converse com uma consultora e leve na hora."
        />
        <div className="mt-14 grid gap-6 lg:grid-cols-3">
          {featuredStores.map((store, index) => (
            <StoreCard key={store.slug} store={store} index={index} />
          ))}
        </div>
        <div className="mt-12 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href="/lojas" size="lg">
            <MapPin /> Ver todas as lojas
          </Button>
          <Button
            href="https://api.whatsapp.com/send?phone=5513996050174"
            external
            variant="whatsapp"
            size="lg"
          >
            <MessageCircle /> Falar com uma consultora
          </Button>
        </div>
      </Section>

      {/* 14 — CTA FINAL + NEWSLETTER */}
      <CTABanner
        eyebrow="Sua próxima peça favorita"
        title="Está esperando você em uma das nossas lojas"
        description="Atendimento sem pressa, provador confortável e alguém que entende do seu corpo."
        primaryAction={{ label: 'Encontrar minha loja', href: '/lojas' }}
        secondaryAction={{
          label: 'Falar no WhatsApp',
          href: 'https://api.whatsapp.com/send?phone=5513996050174',
          external: true,
        }}
        height="md"
      />

      <NewsletterBlock tone="champagne" />

      {/* 15 — FOOTER vive no layout do grupo (public) */}
    </>
  );
}
