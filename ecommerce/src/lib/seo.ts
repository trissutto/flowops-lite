import type { Metadata } from 'next';
import type { Product, Store } from '@/types';

/**
 * CAMADA DE SEO — helpers de metadata e JSON-LD.
 * Toda página pública DEVE exportar `metadata` construído por `buildMetadata`
 * e injetar o JSON-LD pertinente. Ver docs/seo.md.
 */

/**
 * URL canônica do site.
 *
 * Vem de `NEXT_PUBLIC_SITE_URL` (Vercel → Settings → Environment Variables).
 * Sem ela, a Vercel injeta `VERCEL_URL` com o endereço do deploy — assim
 * canonical e Open Graph apontam pro lugar certo em qualquer preview, sem
 * ninguém editar código.
 *
 * O domínio de produção deste site é **www.lurdsplussize.com.br**. Ele já foi
 * do FlowOps (PDV/retaguarda/Live) — por isso o aviso antigo aqui mandava não
 * usar — mas o FlowOps mudou pra `crm.lurdsplussize.com.br` em 10/07/2026 e
 * liberou o `www`.
 *
 * ⚠️ Continua valendo NÃO apontar pra `crm.lurdsplussize.com.br`: lá roda o
 * sistema interno, e o ecommerce se anunciaria com a URL da retaguarda.
 */
function resolveSiteUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  if (process.env.NEXT_PUBLIC_VERCEL_URL) return `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`;
  return 'http://localhost:3100';
}

export const SITE = {
  name: "Lurd's Plus Size",
  shortName: 'Lurds',
  url: resolveSiteUrl(),
  description:
    'Moda plus size elegante do 44 ao 60. Curadoria de peças que vestem super bem, atendimento acolhedor e 14 lojas em São Paulo e região.',
  locale: 'pt_BR',
  twitter: '@lurdsplussize',
  ogImage: '/og/default.jpg',
} as const;

interface BuildMetadataInput {
  title: string;
  description?: string;
  /** Caminho relativo, sempre com barra inicial. */
  path?: string;
  image?: string;
  keywords?: string[];
  noIndex?: boolean;
  type?: 'website' | 'article';
}

export function buildMetadata({
  title,
  description = SITE.description,
  path = '/',
  image = SITE.ogImage,
  keywords,
  noIndex = false,
  type = 'website',
}: BuildMetadataInput): Metadata {
  const url = `${SITE.url}${path}`;
  const fullTitle = path === '/' ? title : `${title} | ${SITE.name}`;

  return {
    metadataBase: new URL(SITE.url),
    title: fullTitle,
    description,
    keywords,
    alternates: { canonical: url },
    openGraph: {
      title: fullTitle,
      description,
      url,
      siteName: SITE.name,
      locale: SITE.locale,
      type,
      images: [{ url: image, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: 'summary_large_image',
      title: fullTitle,
      description,
      images: [image],
      site: SITE.twitter,
    },
    robots: noIndex
      ? { index: false, follow: false }
      : { index: true, follow: true, 'max-image-preview': 'large' },
  };
}

/* --------------------------------------------------------------- JSON-LD */

type JsonLd = Record<string, unknown>;

export function organizationSchema(): JsonLd {
  return {
    '@type': 'Organization',
    '@id': `${SITE.url}#organization`,
    name: SITE.name,
    url: SITE.url,
    description: SITE.description,
    logo: `${SITE.url}/logo.svg`,
  };
}

export function websiteSchema(): JsonLd {
  return {
    '@type': 'WebSite',
    '@id': `${SITE.url}#website`,
    url: SITE.url,
    name: SITE.name,
    inLanguage: 'pt-BR',
    publisher: { '@id': `${SITE.url}#organization` },
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${SITE.url}/busca?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
  };
}

export function breadcrumbSchema(trail: { name: string; path: string }[]): JsonLd {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: `${SITE.url}${item.path}`,
    })),
  };
}

export function productSchema(product: Product): JsonLd {
  return {
    '@type': 'Product',
    '@id': `${SITE.url}/produto/${product.slug}#product`,
    name: product.name,
    image: product.images.map((i) => i.src),
    sku: product.id,
    brand: { '@type': 'Brand', name: SITE.shortName },
    ...(product.rating
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: product.rating.average,
            reviewCount: product.rating.count,
          },
        }
      : {}),
    offers: {
      '@type': 'Offer',
      url: `${SITE.url}/produto/${product.slug}`,
      priceCurrency: 'BRL',
      price: product.price.toFixed(2),
      availability: product.sizes.some((s) => s.available)
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
    },
  };
}

export function itemListSchema(products: Product[], listName: string): JsonLd {
  return {
    '@type': 'ItemList',
    name: listName,
    numberOfItems: products.length,
    itemListElement: products.map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${SITE.url}/produto/${p.slug}`,
      name: p.name,
    })),
  };
}

/** SEO local — um nó por unidade física. */
export function storeSchema(store: Store): JsonLd {
  return {
    '@type': 'ClothingStore',
    '@id': `${SITE.url}/lojas#${store.slug}`,
    name: `${SITE.shortName} ${store.unit}`,
    description: store.description,
    telephone: `+55${store.whatsapp.slice(2)}`,
    address: {
      '@type': 'PostalAddress',
      streetAddress: `${store.address.street} – ${store.address.neighborhood}`,
      addressLocality: store.address.city,
      addressRegion: store.address.uf,
      ...(store.address.zip ? { postalCode: store.address.zip } : {}),
      addressCountry: 'BR',
    },
    geo: { '@type': 'GeoCoordinates', latitude: store.geo.lat, longitude: store.geo.lng },
    openingHoursSpecification: store.hours.schema.map((h) => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: h.days,
      opens: h.opens,
      closes: h.closes,
    })),
    parentOrganization: { '@id': `${SITE.url}#organization` },
  };
}

/** Empacota nós num @graph único — 1 script por página. */
export function jsonLdGraph(...nodes: JsonLd[]): string {
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes });
}
