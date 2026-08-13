import { limparNomeVitrine, nomeDaDescricaoErp, titularSeCaixaAlta } from './nome-vitrine';

/**
 * O caso que criou o módulo: primeira peça nascida no sistema (407012, 13/08)
 * estreou na PDP como "CAMISA MANGA LONGA POÁ MARROM 46" — cor com acento que
 * a limpeza não casava, tamanho da variação no título e caixa alta de
 * etiqueta.
 */
describe('nome-vitrine', () => {
  describe('limparNomeVitrine', () => {
    it('caso 407012: tira cor acentuada, tamanho e caixa alta', () => {
      expect(
        limparNomeVitrine('CAMISA MANGA LONGA POÁ MARROM 46', '407012', ['POÁ MARROM'], 'RERY'),
      ).toBe('Camisa Manga Longa');
    });

    it('cor gravada SEM acento sai de um nome escrito COM acento (e vice-versa)', () => {
      expect(
        limparNomeVitrine('BLUSA POÁ MARROM', 'X1', ['POA MARROM']),
      ).toBe('Blusa');
      expect(
        limparNomeVitrine('BLUSA POA MARROM', 'X1', ['POÁ MARROM']),
      ).toBe('Blusa');
    });

    it('tamanho no fim sai mesmo sem cor na frente — inclusive dupla', () => {
      expect(limparNomeVitrine('VESTIDO LONGO 46/48', 'V1', [])).toBe('Vestido Longo');
      expect(limparNomeVitrine('VESTIDO LONGO TAM 54', 'V1', [])).toBe('Vestido Longo');
    });

    it('número que não é da grade fica ("Jeans 501" não é tamanho)', () => {
      expect(limparNomeVitrine('CALCA JEANS 501', 'J1', [])).toBe('Calca Jeans 501');
    });

    it('nome digitado por gente (com minúscula) não muda de caixa', () => {
      expect(
        limparNomeVitrine('T-shirt com Bordado Especial', 'T1', []),
      ).toBe('T-shirt com Bordado Especial');
    });

    it('conectivo fica minúsculo no Title Case', () => {
      expect(limparNomeVitrine('BLUSA DE ALCA COM BABADO', 'B1', [])).toBe(
        'Blusa de Alca com Babado',
      );
    });

    it('segue tirando ruído, REF, marca e o rabo depois da cor', () => {
      expect(
        limparNomeVitrine(
          'T-shirt Feminina Plus Size Manga Curta Ref VOGUE Preto LENE',
          'VOGUE',
          ['PRETO', 'VINHO'],
          'MARRIE',
        ),
      ).toBe('T-shirt Manga Curta');
    });

    it('nunca devolve vazio: limpeza que come tudo volta o original (titulado)', () => {
      expect(limparNomeVitrine('FEMININA PLUS SIZE PRETO', 'B2', ['PRETO'])).toBe(
        'Feminina Plus Size Preto',
      );
    });
  });

  describe('nomeDaDescricaoErp', () => {
    it('tira a cor da variação e o tamanho, sem cortar o resto', () => {
      expect(
        nomeDaDescricaoErp('CAMISA MANGA LONGA POÁ MARROM 46', '407012', ['POÁ MARROM'], 'RERY'),
      ).toBe('CAMISA MANGA LONGA');
    });
  });

  describe('titularSeCaixaAlta', () => {
    it('caixa alta vira Title Case; misto passa intacto', () => {
      expect(titularSeCaixaAlta('CAMISA MANGA LONGA')).toBe('Camisa Manga Longa');
      expect(titularSeCaixaAlta('T-SHIRT ESTAMPADA')).toBe('T-Shirt Estampada');
      expect(titularSeCaixaAlta('Vestido Midi Amarração')).toBe('Vestido Midi Amarração');
    });
  });
});
