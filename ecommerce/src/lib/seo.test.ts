import { describe, expect, it } from 'vitest';
import type { Product } from '@/types';
import {
  buildMetadata,
  itemListSchema,
  organizationSchema,
  productSchema,
  SITE,
} from './seo';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: '123',
    sku: 'REF-123',
    slug: 'vestido-ref-123',
    name: 'Vestido Midi — REF-123',
    description: '<p>Vestido com caimento leve &amp; confortável.</p>',
    category: 'vestidos',
    price: 259.9,
    images: [{ src: 'https://cdn.example.com/vestido.jpg', alt: 'Vestido midi preto' }],
    colors: [
      { name: 'Preto', hex: '#000000' },
      { name: 'Preto', hex: '#000000' },
      { name: 'Vinho', hex: '#722F37' },
    ],
    sizes: [{ label: '48', available: true }],
    fabric: 'Viscolycra',
    ...overrides,
  };
}

describe('SEO metadata', () => {
  it('mantém busca noindex, follow e com canonical próprio', () => {
    const metadata = buildMetadata({
      title: 'Busca: vestido',
      path: '/busca',
      noIndex: true,
      follow: true,
    });

    expect(metadata.alternates?.canonical).toBe(`${SITE.url}/busca`);
    expect(metadata.robots).toMatchObject({ index: false, follow: true });
  });
});

describe('Organization schema', () => {
  it('publica identidade e política de devolução verificáveis', () => {
    const schema = organizationSchema();

    expect(schema).toMatchObject({
      '@type': 'Organization',
      taxID: '20.104.813/0001-39',
      email: 'atendimento@lurdsplussize.com.br',
      hasMerchantReturnPolicy: {
        '@type': 'MerchantReturnPolicy',
        merchantReturnDays: 7,
      },
    });
  });
});

describe('Product schema', () => {
  it('expõe somente dados comerciais reais e limpa HTML da descrição', () => {
    const schema = productSchema(product());

    expect(schema).toMatchObject({
      '@type': 'Product',
      sku: 'REF-123',
      description: 'Vestido com caimento leve & confortável.',
      material: 'Viscolycra',
      color: 'Preto, Vinho',
      offers: {
        '@type': 'Offer',
        price: '259.90',
        priceCurrency: 'BRL',
        itemCondition: 'https://schema.org/NewCondition',
        seller: { '@id': `${SITE.url}#organization` },
      },
    });
  });

  it('omite descrição, material e cor quando ausentes', () => {
    const schema = productSchema(product({ description: undefined, fabric: undefined, colors: undefined }));

    expect(schema).not.toHaveProperty('description');
    expect(schema).not.toHaveProperty('material');
    expect(schema).not.toHaveProperty('color');
  });
});

describe('ItemList schema', () => {
  it('deduplica pela URL canônica, preserva ordem e limita a lista', () => {
    const products = [
      product({ slug: 'a', name: 'A preto' }),
      product({ slug: 'a', name: 'A vinho' }),
      product({ slug: 'b', name: 'B' }),
      product({ slug: 'c', name: 'C' }),
    ];
    const schema = itemListSchema(products, 'Destaques', 2);

    expect(schema.numberOfItems).toBe(2);
    expect(schema.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, url: `${SITE.url}/produto/a`, name: 'A preto' },
      { '@type': 'ListItem', position: 2, url: `${SITE.url}/produto/b`, name: 'B' },
    ]);
  });
});
