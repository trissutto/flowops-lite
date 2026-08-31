import { HomeBenefitsAndStores, HomeCategoryNav, HomeSizeNav, HomeStoreCta, type HomeCategory } from '@/components/sections/HomeDiscovery';
import { Hero } from '@/components/sections/Hero';
import { HomeShelf } from '@/components/sections/HomeShelf';
import { DeferredHomeShelves } from '@/components/sections/DeferredHomeShelves';
import { Section } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { InstagramCard } from '@/components/cards/InstagramCard';
import { NewsletterBlock } from '@/components/sections/NewsletterBlock';
import { PERFIL_INSTAGRAM } from '@/data/content';
import { stores } from '@/data/stores';
import { getInstagram } from '@/services/instagram';
import { getHeroDaHome } from '@/services/banners';
import { getBlocosDaHome } from '@/services/vitrines-home';
import { buildMetadata, itemListSchema, jsonLdGraph, storeSchema } from '@/lib/seo';
// HOME_CATEGORY_BASE saiu daqui: os atalhos agora vêm da retaguarda. A
// constante continua sendo a ARTE aprovada de cada card — quem casa foto com
// destino é `services/vitrines-home.ts`.
import { HOME_STORES_PATH } from '@/data/home';

/**
 * A Home não depende da requisição individual da visitante. As vitrines são
 * renovadas a cada cinco minutos e o HTML pode ser entregue pronto pela CDN.
 * A atribuição de campanhas continua sendo capturada no navegador pelo
 * TrackingProvider, sem transformar esta rota em renderização dinâmica.
 */
export const revalidate = 300;

export const metadata = buildMetadata({
  title: "Lurd's Plus Size — Moda plus size elegante do 44 ao 60",
  path: '/',
  keywords: ['moda plus size', 'roupas plus size', 'vestido plus size', 'loja plus size', 'plus size 44 ao 60'],
});

export default async function HomePage() {
  /**
   * OS BLOCOS DA HOME VÊM DA RETAGUARDA (17/08/2026) — atalhos e vitrines,
   * na ordem que `/retaguarda/vitrines-home` definir. Uma requisição só, e
   * ela já traz as peças de cada carrossel (antes era uma por carrossel:
   * Mais Top + Novidades); backend fora do ar cai na home que está no ar
   * hoje. Ver `services/vitrines-home.ts`.
   *
   * Continua tudo JUNTO com o hero: a cascata "hero → vitrine" atrasava o
   * HTML que revela a imagem LCP.
   */
  const [hero, blocos, posts] = await Promise.all([
    getHeroDaHome(),
    getBlocosDaHome(),
    getInstagram(6),
  ]);

  const categories: HomeCategory[] = blocos.atalhos.map((atalho) => ({
    ...atalho,
    href: atalho.href,
  }));
  const storesHref = HOME_STORES_PATH;
  const sizeLinks = ['46', '48', '50', '52', '54', '56', '58', '60'].map((size) => ({
    size,
    href: `/tamanhos/${size}`,
  }));
  // As peças de TODAS as vitrines que saírem — o Google lê a lista da página
  // que existe, não a de uma seção fixa que pode nem estar mais na home.
  const jsonLd = jsonLdGraph(
    itemListSchema(blocos.carrosseis.flatMap((v) => v.produtos), 'Destaques da home', 24),
    ...stores.map(storeSchema),
  );

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />

      <Hero
        image={hero.image}
        imageMobile={hero.imageMobile}
        imageMobileInline={hero.imageMobileInline}
        eyebrow={hero.eyebrow}
        title={
          <>
            {hero.lead}{' '}
            <span className="text-primary-strong">{hero.emphasis}</span>
          </>
        }
        subtitle={hero.subtitle}
        primaryAction={hero.primaria}
        secondaryAction={hero.secundaria}
        height={hero.daRetaguarda ? 'arte' : 'home'}
        align="left"
        overlay="none"
        contentTone="ink"
        priority
      />

      <HomeCategoryNav categories={categories} />

      <div className="bg-surface px-4 pb-5 sm:hidden">
        <HomeStoreCta storesHref={storesHref} className="flex" />
      </div>

      {/* A primeira prateleira continua no HTML para SEO e para a primeira
          jornada. As demais chegam quando a visitante se aproxima delas: a
          home deixa de serializar dezenas de cards antes de pintar o hero. */}
      {blocos.carrosseis[0] && <HomeShelf vitrine={blocos.carrosseis[0]} />}
      {blocos.carrosseis.length > 1 && <DeferredHomeShelves />}

      <HomeSizeNav sizes={sizeLinks} />

      <HomeBenefitsAndStores storesHref={storesHref} />

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
