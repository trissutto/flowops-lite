import { ehItemSemEstoque } from './item-sem-estoque';

describe('ehItemSemEstoque', () => {
  test('FRETE nunca é peça (o bug do ON-000001)', () => {
    expect(ehItemSemEstoque({ sku: 'FRETE', ref: 'FRETE' })).toBe(true);
    expect(ehItemSemEstoque({ sku: 'frete' })).toBe(true);
  });

  test('linha MANUAL (vale presente, ajuste) não tem estoque', () => {
    expect(ehItemSemEstoque({ sku: 'MANUAL-1786712555032', ref: 'MANUAL' })).toBe(true);
  });

  test('peça de verdade continua sendo roteada', () => {
    expect(ehItemSemEstoque({ sku: '5355280', ref: '17485', cor: 'VERMELHO' } as any)).toBe(false);
  });

  test('produto real com desconto manual NÃO é excluído (regra de 16/07)', () => {
    // promoTag='MANUAL' com sku/ref de catálogo é peça — excluir isso deixava
    // estoque fantasma no Wincred.
    expect(ehItemSemEstoque({ sku: '700961', ref: '700961', promoTag: 'MANUAL' })).toBe(false);
  });

  test('item sem SKU não tem como ser localizado', () => {
    expect(ehItemSemEstoque({ sku: '' })).toBe(true);
  });
});
