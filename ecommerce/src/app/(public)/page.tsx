import { HomeBenefitsAndStores, HomeCategoryNav, HomeSizeNav, HomeStoreCta, type HomeCategory } from '@/components/sections/HomeDiscovery';
import { HomeVlm222Hero } from '@/components/sections/HomeVlm222Hero';
import { VitrineGrid } from '@/components/sections/VitrineGrid';
import { Section } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { InstagramCard } from '@/components/cards/InstagramCard';
import { NewsletterBlock } from '@/components/sections/NewsletterBlock';
import { PERFIL_INSTAGRAM } from '@/data/content';
import { stores } from '@/data/stores';
import { getInstagram } from '@/services/instagram';
import { getBlocosDaHome } from '@/services/vitrines-home';
import { buildMetadata, itemListSchema, jsonLdGraph, storeSchema } from '@/lib/seo';
import { sanitizeCampaignParams, withCampaignParams } from '@/lib/campaign-links';
// HOME_CATEGORY_BASE saiu daqui: os atalhos agora vêm da retaguarda. A
// constante continua sendo a ARTE aprovada de cada card — quem casa foto com
// destino é `services/vitrines-home.ts`.
import { HOME_STORES_PATH } from '@/data/home';

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
  const [blocos, posts] = await Promise.all([
    getBlocosDaHome(),
    getInstagram(6),
  ]);

  const categories: HomeCategory[] = blocos.atalhos.map((atalho) => ({
    ...atalho,
    href: href(atalho.href),
  }));
  const storesHref = href(HOME_STORES_PATH);
  const sizeLinks = ['46', '48', '50', '52', '54', '56', '58', '60'].map((size) => ({
    size,
    href: href(`/tamanhos/${size}`),
  }));
  // As peças de TODAS as vitrines que saírem — o Google lê a lista da página
  // que existe, não a de uma seção fixa que pode nem estar mais na home.
  const jsonLd = jsonLdGraph(
    itemListSchema(blocos.carrosseis.flatMap((v) => v.produtos), 'Destaques da home'),
    ...stores.map(storeSchema),
  );

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />

      <HomeVlm222Hero href={href('/produto/ref-vlm-222')} />

      <HomeCategoryNav categories={categories} />

      <div className="bg-surface px-4 pb-5 sm:hidden">
        <HomeStoreCta storesHref={storesHref} className="flex" />
      </div>

      {/* AS VITRINES, NA ORDEM DA RETAGUARDA — hoje Mais Top da semana e
          Novidades, que antes eram duas seções escritas à mão aqui. Vitrine
          sem peça não chega até aqui (o backend já tira): carrossel vazio é
          pior que uma seção a menos.

          EM GRADE, NÃO CARROSSEL (dono, 18/08): 6 colunas x 3 linhas no
          desktop, 2 x 9 no celular. O carrossel mostrava 2,5 peças e exigia
          arrastar pra ver o resto — a vitrine virava enfeite. QUANTAS peças
          cada uma mostra continua sendo o `limite` da própria vitrine em
          /retaguarda/vitrines-home (teto 24); a grade corta em 18 pra fechar
          3 linhas exatas. */}
      {blocos.carrosseis.map((vitrine) => (
        <Section
          key={vitrine.id}
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
                ? { label: vitrine.ctaLabel ?? 'Ver todas', href: href(vitrine.ctaHref) }
                : undefined
            }
            align="left"
            compactMobile
          />
          <div className="mt-3 sm:mt-10">
            <VitrineGrid products={vitrine.produtos} listName={vitrine.titulo} />
          </div>
        </Section>
      ))}

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
