import { classificarPorNome } from './classificacao-por-nome';

/**
 * Regras do lote de 10/08 (classificar-em-massa) valendo em leitura.
 * O caso de origem: 407012 "Camisa Manga Longa" publicada sem categoria —
 * na PDP mas em nenhum menu.
 */
describe('classificarPorNome', () => {
  it('caso 407012: camisa manga longa → Blusas › Manga longa', () => {
    expect(classificarPorNome('Camisa Manga Longa')).toEqual({
      categoria: 'blusas',
      subcategoria: 'manga-longa',
    });
  });

  it('cada família aponta pro slug de subcategoria DELA', () => {
    expect(classificarPorNome('Vestido Midi Manga Curta')).toEqual({
      categoria: 'vestidos',
      subcategoria: 'vestido-manga-curta',
    });
    expect(classificarPorNome('Macacão Pantalona Alcinha')).toEqual({
      categoria: 'macacoes',
      subcategoria: 'macacao-sem-manga',
    });
    expect(classificarPorNome('Blusa Regata Canelada')).toEqual({
      categoria: 'blusas',
      subcategoria: 'regata',
    });
  });

  it('praia divide por tipo de peça e vence as outras famílias', () => {
    expect(classificarPorNome('Saída de Praia com Manga Longa')).toEqual({
      categoria: 'moda-praia',
      subcategoria: 'saida-de-praia',
    });
    expect(classificarPorNome('Maiô Plus')).toEqual({
      categoria: 'moda-praia',
      subcategoria: 'maio',
    });
    // "maio" só com borda de palavra: "maior" não é maiô
    expect(classificarPorNome('Blusa Maior Conforto Manga Curta')?.categoria).toBe('blusas');
  });

  it('nome que não diz a família fica sem categoria (não inventa)', () => {
    expect(classificarPorNome('Calça Cigarrete')).toBeNull();
    expect(classificarPorNome('Kimono Fluido')).toBeNull();
  });

  it('NÃO MEXER: conjunto/pijama/lingerie não entram nem parecendo blusa', () => {
    expect(classificarPorNome('Conjunto Blusa Manga Curta + Calça')).toBeNull();
    expect(classificarPorNome('Pijama Camisa Manga Longa')).toBeNull();
  });

  it('família certa mas manga indefinida: categoria vale, sub fica nula', () => {
    expect(classificarPorNome('Camisa Social Poá')).toEqual({
      categoria: 'blusas',
      subcategoria: null,
    });
  });
});
