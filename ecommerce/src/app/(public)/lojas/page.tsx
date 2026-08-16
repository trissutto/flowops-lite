import type { Metadata } from 'next';
import NossasLojasClient from './NossasLojasClient';
import { stores, site, imgSrc, SITE_URL, instagramUrl, directionsUrl, type Store } from './lib';
import { getBanners } from '@/services/banners';

// No site novo a rota é /lojas (o menu, o rodapé e a retirada em loja já
// apontam pra ela). O /nossaslojas do site antigo redireciona pra cá.
const PAGE_URL = `${SITE_URL}/lojas`;
const DESCRIPTION =
  'Conheça as 14 lojas Lurds Plus Size em São Paulo e região: moda plus size elegante, ' +
  'atendimento acolhedor e peças que valorizam o corpo de verdade. Encontre a loja mais perto de você.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Nossas Lojas | Lurds Plus Size — Moda Plus Size Elegante',
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  keywords: [
    'moda plus size',
    'loja plus size',
    'roupas plus size',
    'Lurds Plus Size',
    ...stores.map((s) => `plus size ${s.city}`),
  ],
  openGraph: {
    title: 'Encontre a Lurds mais próxima de você',
    description: DESCRIPTION,
    url: PAGE_URL,
    siteName: 'Lurds Plus Size',
    locale: 'pt_BR',
    type: 'website',
    /**
     * Sem foto oficial, o link compartilhado vai SEM imagem (16/08/2026) — o
     * card do WhatsApp/Facebook fica só com título e texto. Melhor isso do que
     * carimbar uma foto de banco de imagem como se fosse a loja. Volta sozinho
     * quando `site.heroImage` tiver foto nossa.
     */
    ...(site.heroImage
      ? {
          images: [
            {
              url: imgSrc(site.heroImage, 1200),
              width: 1200,
              height: 630,
              alt: 'Lurds Plus Size — moda plus size elegante',
            },
          ],
        }
      : {}),
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Nossas Lojas | Lurds Plus Size',
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

/** Schema.org ClothingStore (LocalBusiness) — um nó por unidade, direto do JSON. */
function storeJsonLd(s: Store) {
  return {
    '@type': 'ClothingStore',
    '@id': `${PAGE_URL}#${s.slug}`,
    name: `Lurds Plus Size ${s.unit}`,
    description: s.description,
    url: PAGE_URL,
    telephone: `+55 ${s.phone.replace(/[()]/g, '').trim()}`,
    address: {
      '@type': 'PostalAddress',
      streetAddress: `${s.address.street} – ${s.address.neighborhood}`,
      addressLocality: s.address.city,
      addressRegion: s.address.uf,
      ...(s.address.zip ? { postalCode: s.address.zip } : {}),
      addressCountry: 'BR',
    },
    geo: { '@type': 'GeoCoordinates', latitude: s.geo.lat, longitude: s.geo.lng },
    ...(s.image ? { image: imgSrc(s.image, 1200) } : {}),
    hasMap: directionsUrl(s),
    sameAs: [instagramUrl(s)],
    openingHoursSpecification: s.hours.schema.map((h) => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: h.days,
      opens: h.opens,
      closes: h.closes,
    })),
    parentOrganization: { '@type': 'Organization', name: "Lurd's Plus Size", url: SITE_URL },
  };
}

export default async function NossasLojasPage() {
  /**
   * A CAPA VEM DO CADASTRO (13/08/2026). Era uma foto do UNSPLASH chumbada no
   * `lojas.json` — banco de imagens genérico numa página que existe justamente
   * pra mostrar as lojas de verdade. Agora a retaguarda sobe a arte no slot
   * `lojas-hero` e troca quando quiser, sem deploy. Slot vazio ou backend fora
   * do ar: continua valendo a foto do JSON, então a página nunca fica sem
   * capa.
   */
  const [capa] = await getBanners('lojas-hero');
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Lurds Plus Size', item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: 'Nossas Lojas', item: PAGE_URL },
        ],
      },
      ...stores.map(storeJsonLd),
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <NossasLojasClient heroImagem={capa?.imagemUrl ?? null} />
    </>
  );
}
