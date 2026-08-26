import { describe, expect, it } from 'vitest';
import type { Product } from '@/types';
import lojasData from '@/data/lojas.json';
import {
  selectStoreLaunches,
  storeLaunchHeroTitle,
  storeLaunchProductHref,
} from './store-launches';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'BMM-100',
    sku: 'BMM-100',
    slug: 'blusa-bmm-100',
    name: 'Blusa BMM-100',
    category: 'Blusas',
    price: 99.9,
    images: [{ src: '/produto.webp', alt: 'Blusa' }],
    sizes: [{ label: '48', available: true }],
    colors: [],
    availability: { online: true, stores: [], pickup: true },
    ...overrides,
  };
}

describe('vitrine de lançamentos da loja', () => {
  it('gera um hero de novidades para todas as 14 unidades', () => {
    const titles = lojasData.stores.map((store) => storeLaunchHeroTitle(store.unit));

    expect(titles).toHaveLength(14);
    expect(titles).toContain("Novidades Lurd's em Anália Franco");
    expect(titles).toContain("Novidades Lurd's em Limeira");
    expect(titles).toContain("Novidades Lurd's em Vinhedo");
    expect(new Set(titles)).toHaveLength(14);
  });

  it('limita a seis produtos elegíveis', () => {
    const products = Array.from({ length: 8 }, (_, index) => product({ id: String(index) }));
    expect(selectStoreLaunches(products)).toHaveLength(6);
  });

  it('ignora produtos sem foto ou indisponíveis', () => {
    const products = [
      product({ id: 'ok' }),
      product({ id: 'sem-foto', images: [] }),
      product({ id: 'esgotado', availability: { online: false, stores: [], pickup: false } }),
    ];
    expect(selectStoreLaunches(products).map((item) => item.id)).toEqual(['ok']);
  });

  it('preserva a cor escolhida no link da peça', () => {
    expect(storeLaunchProductHref(product({ vitrineCor: { nome: 'AZUL MARINHO', rotulo: 'Azul-marinho' } })))
      .toBe('/produto/blusa-bmm-100?cor=AZUL%20MARINHO');
  });
});
