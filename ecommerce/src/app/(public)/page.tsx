import { MapPin, MessageCircle } from 'lucide-react';
import { Hero } from '@/components/sections/Hero';
import { HomeBenefitsAndStores, HomeCategoryNav, type HomeCategory } from '@/components/sections/HomeDiscovery';
import { ProductCarousel } from '@/components/sections/ProductCarousel';
import { Section } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { InstagramCard } from '@/components/cards/InstagramCard';
import { StoreCard } from '@/components/cards/StoreCard';
import { NewsletterBlock } from '@/components/sections/NewsletterBlock';
import { Button } from '@/components/ui/Button';
import { PERFIL_INSTAGRAM } from '@/data/content';
import { LINK_WHATSAPP_SITE } from '@/data/contato';
import { featuredStores, stores } from '@/data/stores';
import { getHeroDaHome } from '@/services/banners';
import { getInstagram } from '@/services/instagram';
import { fetchVitrine } from '@/services/vitrine';
import { buildMetadata, itemListSchema, jsonLdGraph, storeSchema } from '@/lib/seo';
import { sanitizeCampaignParams, withCampaignParams } from '@/lib/campaign-links';
import { HOME_CATEGORY_BASE, HOME_NEWS_PATH, HOME_STORES_PATH } from '@/data/home';

export const metadata = buildMetadata({
  title: "Lurd's Plus Size — Moda plus size elegante do 44 ao 60",
  path: '/',
  keywords: ['moda plus size', 'roupas plus size', 'vestido plus size', 'loja plus size', 'plus size 44 ao 60'],
});

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams) ?? {};
  const query = new URLSearchParams();
  Object.entries(raw).forEach(([key, value]) => {
    if (typeof value === 'string') query.set(key, value);
  });
  const campaign = sanitizeCampaignParams(query);
  const href = (path: string) => withCampaignParams(path, campaign);

  // Só o que aparece na Home é buscado. Isso evita atrasar o hero com quatro
  // vitrines repetidas que a nova jornada não usa.
  const [hero, novidades, posts] = await Promise.all([
    getHeroDaHome(),
    fetchVitrine({ ordenar: 'novidades', limite: 10, soNovidade: true }),
    getInstagram(6),
  ]);

  const categories: HomeCategory[] = HOME_CATEGORY_BASE.map(({ path, ...category }) => ({
    ...category,
    href: href(path),
  }));
  const novidadesHref = href(HOME_NEWS_PATH);
  const storesHref = href(HOME_STORES_PATH);
  const jsonLd = jsonLdGraph(itemListSchema(novidades, 'Novidades da semana'), ...stores.map(storeSchema));

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />

      <Hero
        image={hero.image}
        imageMobile={hero.imageMobile}
        eyebrow={hero.eyebrow}
        title={
          hero.lead || hero.emphasis ? (
            hero.daRetaguarda ? (
              <>
                {hero.lead}
                {hero.emphasis && <><br /><span className="text-primary-soft italic">{hero.emphasis}</span></>}
              </>
            ) : <>{hero.lead}{hero.emphasis && ` ${hero.emphasis}`}</>
          ) : (
            <span className="sr-only">Lurd&apos;s Plus Size — moda elegante do 44 ao 60</span>
          )
        }
        subtitle={hero.subtitle}
        primaryAction={{ label: 'Ver novidades', href: novidadesHref, variant: 'primary' }}
        height={hero.daRetaguarda ? 'arte' : 'home'}
        align={hero.daRetaguarda ? 'center' : 'left'}
        overlay="none"
        contentTone={hero.daRetaguarda ? 'light' : 'ink'}
        priority
      />

      <HomeCategoryNav categories={categories} />

      {novidades.length > 0 && (
        <Section width="wide" aria-labelledby="novidades-titulo" className="!py-8 sm:!py-12">
          <SectionTitle
            id="novidades-titulo"
            eyebrow="Acabou de chegar"
            title="Novidades da semana"
            cta={{ label: 'Ver todas', href: novidadesHref }}
            align="left"
          />
          <div className="mt-7 sm:mt-10">
            <ProductCarousel
              products={novidades}
              ariaLabel="Novidades da semana"
              progressiveImages
              compactMobile
            />
          </div>
        </Section>
      )}

      <HomeBenefitsAndStores storesHref={storesHref} />

      <Section tone="alt" width="wide" aria-labelledby="lojas-titulo">
        <SectionTitle
          id="lojas-titulo"
          eyebrow="Nossas lojas"
          title="14 endereços, o mesmo acolhimento"
          description="Prove com calma, converse com uma consultora e leve na hora."
        />
        <div className="mt-10 grid gap-6 lg:grid-cols-3">
          {featuredStores.map((store, index) => <StoreCard key={store.slug} store={store} index={index} />)}
        </div>
        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href={storesHref} size="lg"><MapPin /> Ver todas as lojas</Button>
          <Button href={LINK_WHATSAPP_SITE} external variant="whatsapp" size="lg">
            <MessageCircle /> Falar com uma consultora
          </Button>
        </div>
      </Section>

      {posts.length > 0 && (
        <Section width="wide" aria-labelledby="instagram-titulo">
          <SectionTitle
            id="instagram-titulo"
            eyebrow="@lurdsplussize"
            title="No feed e no seu guarda-roupa"
            cta={{ label: 'Seguir no Instagram', href: PERFIL_INSTAGRAM }}
            align="left"
          />
          <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {posts.map((post) => <InstagramCard key={post.id} post={post} />)}
          </div>
        </Section>
      )}

      <NewsletterBlock tone="champagne" />
    </>
  );
}
