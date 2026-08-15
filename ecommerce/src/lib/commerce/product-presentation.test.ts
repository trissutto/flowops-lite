import { describe, expect, it } from 'vitest';
import { nomeComReferencia, ofertaProduto } from './product-presentation';

describe('apresentação comercial do produto', () => {
  it('mostra promoção somente com preço anterior maior', () => {
    expect(ofertaProduto(199.9, 249.9, true)).toEqual({ compareAtPrice: 249.9, badge: 'promocao' });
  });

  it('renomeia seleção comercial sem economia comprovável', () => {
    expect(ofertaProduto(199.9, null, true)).toEqual({ badge: 'preco-especial' });
    expect(ofertaProduto(199.9, 199.9, true)).toEqual({ badge: 'preco-especial' });
  });

  it('não inventa oferta quando não há marcação comercial', () => {
    expect(ofertaProduto(199.9, 149.9, false)).toEqual({});
  });

  it('combina nome curto e referência sem duplicar o código', () => {
    expect(nomeComReferencia('Blusa Marrie Manga Curta', 'BMM-100'))
      .toBe('Blusa Marrie Manga Curta — BMM-100');
    expect(nomeComReferencia('Blusa Marrie — BMM-100', 'BMM-100'))
      .toBe('Blusa Marrie — BMM-100');
  });
});
