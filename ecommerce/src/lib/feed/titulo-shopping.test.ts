/**
 * O TÍTULO É O SINAL DE RELEVÂNCIA DO SHOPPING.
 *
 * Medido em 27/08/2026: 561 dos 977 itens do feed saíam com título que era só
 * a categoria — 73 peças chamadas "Blusa Manga Curta". Estes testes fixam o
 * que precisa aparecer e, principalmente, o que NÃO pode aparecer duas vezes:
 * título repetitivo é motivo de reprovação, e caixa alta em excesso também.
 */

import { describe, expect, it } from 'vitest';

import { tituloShopping, type PecaFeed, type Variante } from './variantes';

const peca = (over: Partial<PecaFeed> = {}): PecaFeed => ({
  ref: '207372',
  slug: 'blusa-manga-curta',
  nome: 'Blusa Manga Curta',
  descricao: null,
  marca: 'MALWEE',
  categoria: 'blusas',
  subcategoria: 'manga-curta',
  preco: 129.9,
  precoPromocional: null,
  disponivel: true,
  imagens: [],
  tamanhos: ['46', '48'],
  cores: ['PRETO'],
  ...over,
});

const variante = (over: Partial<Variante> = {}): Variante => ({
  id: '207372',
  cor: 'PRETO',
  fotos: ['a.jpg'],
  tamanhos: ['46', '48'],
  grupo: '207372',
  ...over,
});

describe('tituloShopping', () => {
  it('monta tipo + plus size + cor + Ref + marca', () => {
    expect(tituloShopping(peca(), variante())).toBe('Blusa Manga Curta Plus Size Preto Ref 207372 MALWEE');
  });

  it('capitaliza a cor — o ERP entrega em caixa alta e o Google reprova exagero', () => {
    expect(tituloShopping(peca(), variante({ cor: 'AZUL MARINHO' }))).toContain('Azul Marinho');
  });

  it('não repete "plus size" quando o nome já traz', () => {
    const t = tituloShopping(peca({ nome: 'Vestido Plus Size Longo' }), variante({ cor: 'VINHO' }));
    expect(t.toLowerCase().match(/plus size/g)).toHaveLength(1);
  });

  it('não repete a Ref quando o nome já traz', () => {
    const t = tituloShopping(peca({ nome: 'Blusa Ref 207372' }), variante({ cor: '' }));
    expect(t.match(/207372/g)).toHaveLength(1);
  });

  it('não repete a marca quando o nome já traz', () => {
    const t = tituloShopping(peca({ nome: 'Blusa MALWEE Manga Curta' }), variante({ cor: '' }));
    expect(t.match(/MALWEE/g)).toHaveLength(1);
  });

  it('peça de cor única sai sem cor, e ainda assim identificável', () => {
    expect(tituloShopping(peca(), variante({ cor: '', grupo: null }))).toBe('Blusa Manga Curta Plus Size Ref 207372 MALWEE');
  });

  it('sem marca no cadastro, o título não fica com sobra de espaço', () => {
    const t = tituloShopping(peca({ marca: null }), variante({ cor: 'PRETO' }));
    expect(t).toBe('Blusa Manga Curta Plus Size Preto Ref 207372');
    expect(t).not.toMatch(/\s{2}/);
  });

  it('respeita o teto de 150 caracteres do Google', () => {
    const t = tituloShopping(peca({ nome: 'Vestido '.repeat(40).trim() }), variante());
    expect(t.length).toBeLessThanOrEqual(150);
  });

  it('duas cores da mesma peça geram títulos DIFERENTES', () => {
    const a = tituloShopping(peca(), variante({ cor: 'PRETO' }));
    const b = tituloShopping(peca(), variante({ cor: 'BEGE' }));
    expect(a).not.toBe(b);
  });
});
