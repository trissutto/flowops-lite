import { describe, expect, it } from 'vitest';
import { compactarProdutoDaHome } from '@/lib/home-product';
import type { Product } from '@/types';

const produto: Product = {
  id: 'ref-1',
  slug: 'vestido-preto',
  name: 'Vestido preto',
  description: 'Descrição longa que só pertence à ficha.',
  category: 'vestidos',
  subcategory: 'longos',
  price: 139.9,
  compareAtPrice: 239.9,
  pixPrice: 132.91,
  priceRanges: [{ from: 46, to: 60, price: 139.9 }],
  installments: { times: 6, value: 23.32 },
  images: [
    { src: '/1.webp', alt: 'frente' },
    { src: '/2.webp', alt: 'costas' },
    { src: '/3.webp', alt: 'detalhe' },
  ],
  colors: [{ name: 'Preto', hex: '#000000' }],
  sizes: [{ label: '46', available: true }],
  vitrineCor: { nome: 'Preto', rotulo: 'PRETO' },
  sku: 'VLM-222',
  badges: ['promocao'],
  fabric: 'Viscolycra',
  fit: 'regular',
  occasions: ['festa'],
  collection: 'Conforto',
  rating: { average: 5, count: 10 },
  sold: 99,
  availability: { online: true, stores: ['santos'], pickup: true },
};

describe('compactarProdutoDaHome', () => {
  it('preserva tudo que o card usa e limita as fotos ao hover', () => {
    const compacto = compactarProdutoDaHome(produto);

    expect(compacto).toMatchObject({
      id: 'ref-1',
      slug: 'vestido-preto',
      price: 139.9,
      compareAtPrice: 239.9,
      pixPrice: 132.91,
      installments: { times: 6, value: 23.32 },
      vitrineCor: { nome: 'Preto', rotulo: 'PRETO' },
      availability: { online: true, stores: ['santos'], pickup: true },
    });
    expect(compacto.images).toHaveLength(2);
  });

  it('remove campos exclusivos da ficha e do SEO', () => {
    const compacto = compactarProdutoDaHome(produto) as Product & Record<string, unknown>;

    expect(compacto.description).toBeUndefined();
    expect(compacto.subcategory).toBeUndefined();
    expect(compacto.priceRanges).toBeUndefined();
    expect(compacto.sku).toBeUndefined();
    expect(compacto.fit).toBeUndefined();
    expect(compacto.occasions).toBeUndefined();
    expect(compacto.collection).toBeUndefined();
    expect(compacto.rating).toBeUndefined();
    expect(compacto.sold).toBeUndefined();
  });
});
