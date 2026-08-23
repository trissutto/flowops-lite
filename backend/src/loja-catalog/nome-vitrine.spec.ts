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

    /**
     * VLM222EST (estampado, R$ 199,90) e VLM-222 (liso, R$ 139,90) são o mesmo
     * modelo. "Estampado" é a única palavra que separa os dois cards na grade.
     */
    it('peça que só tem cor de estampa MANTÉM "Estampado" no nome', () => {
      expect(
        limparNomeVitrine('Vestido Longo Manga Curta Estampado', 'VLM222EST', [
          'ESTAMPA MARINHO', 'ESTAMPA VINHO',
        ]),
      ).toBe('Vestido Longo Manga Curta Estampado');
    });

    it('mas "Estampa" órfã de uma cor lisa continua saindo', () => {
      expect(
        limparNomeVitrine('Blusa Manga Curta Estampa Marinho', 'B9', ['MARINHO']),
      ).toBe('Blusa Manga Curta');
    });

    it('peça com estampa E cor lisa não vira "Estampado" (a palavra é de uma variação só)', () => {
      expect(
        limparNomeVitrine('Vestido Longo Estampa', 'V9', ['ESTAMPA AZUL', 'PRETO']),
      ).toBe('Vestido Longo');
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

    /**
     * PDP em 15/08: "Blusa Manga Curta — — BMM-100". A marca saiu do meio e
     * deixou os dois travessões encostados, comendo 4 caracteres de uma linha
     * que no celular já não cabe inteira.
     */
    it('travessão que sobrou da marca removida some (e o hífen de "T-Shirt" fica)', () => {
      expect(
        limparNomeVitrine('Blusa Manga Curta — MARRIE — BMM-100', 'X9', [], 'MARRIE'),
      ).toBe('Blusa Manga Curta — BMM-100');
      expect(limparNomeVitrine('T-shirt Manga Curta', 'X9', [])).toBe('T-shirt Manga Curta');
    });

    it('nunca devolve vazio: limpeza que come tudo volta o original (titulado)', () => {
      expect(limparNomeVitrine('FEMININA PLUS SIZE PRETO', 'B2', ['PRETO'])).toBe(
        'Feminina Plus Size Preto',
      );
    });
  });

  /**
   * Os dois casos que a varredura da vitrine achou em 22/08/2026 — o card
   * anunciava uma cor no TÍTULO e outra no rótulo, logo abaixo.
   */
  describe('nome que contradiz a cor do card (22/08/2026)', () => {
    it('116920: corta cor com ACENTO NA PONTA ("Café")', () => {
      // `\b` não casa depois de letra acentuada em JS sem a flag `u`: o "é"
      // não é caractere de palavra, então a cor estava na lista e mesmo assim
      // nunca era removida. Saía "Vestido Mid Manga Curta Café · Preto".
      expect(
        limparNomeVitrine('Vestido Mid Manga Curta Café', '116920', ['PRETO', 'VINHO', 'CAFE']),
      ).toBe('Vestido Mid Manga Curta');
    });

    it('116920: acento na PONTA vale nos dois sentidos', () => {
      expect(limparNomeVitrine('Vestido Cafe', '1', ['CAFÉ'])).toBe('Vestido');
      expect(limparNomeVitrine('Blusa Índigo', '1', ['INDIGO'])).toBe('Blusa');
    });

    it('900890: corta "Cor <X>" mesmo com X fora da lista de cores da peça', () => {
      // A cor que batizou o cadastro saiu de linha: a peça é Marrom e Vinho, e
      // o nome continuava dizendo "Cor Preta".
      expect(
        limparNomeVitrine('Vestido Sem Manga Cor Preta', '900890', ['MARROM', 'VINHO']),
      ).toBe('Vestido Sem Manga');
    });

    it('"Cor" só cai no FIM do nome', () => {
      // "Cor Block" no meio é nome de verdade — não pode sumir.
      expect(limparNomeVitrine('Blusa Cor Block Manga Curta', '1', ['PRETO'])).toBe(
        'Blusa Cor Block Manga Curta',
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
