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

  /**
   * PIRACICABA SEPAROU ERRADO (09/09/2026) — o nome anunciava uma cor que a
   * peça não vende, e a loja separa pelo que dá pra ler.
   *
   * O vocabulário destes testes é o do cadastro real (valores do campo COR),
   * não uma lista inventada: é assim que a função é chamada em produção.
   */
  describe('cor que a peça NÃO tem (09/09/2026)', () => {
    const CORES_DA_REDE = [
      'PRETO', 'VERDE', 'MARROM', 'BEGE', 'JEANS', 'OFF WHITE', 'MARINHO',
      'VERMELHO', 'ESTAMPA PRETO', 'AZUL', 'VINHO', 'AMARELO', 'LARANJA',
      'MOSTARDA', 'ESTAMPA MOSTARD', 'FUCSIA', 'CINZA', 'TELHA', 'MUSGO',
      'CREME', 'AREIA', 'ESTAMPA OFF WHI', 'LISTRA CINZA', 'ROSE', 'GELO',
    ];
    const limpar = (nome: string, ref: string, cores: string[]) =>
      limparNomeVitrine(nome, ref, cores, null, CORES_DA_REDE);

    it('132908: a regata que só vende BEGE perde o "Mostarda" do título', () => {
      expect(limpar('Regata Estampa Mostarda', '132908', ['BEGE'])).toBe('Regata');
    });

    it('os outros casos que a varredura da vitrine achou no mesmo dia', () => {
      expect(limpar('Calça Preto', 'CAL-061', ['VERDE'])).toBe('Calça');
      expect(limpar('Regata Fucsia', 'REG-066', ['VERDE'])).toBe('Regata');
      expect(limpar('Biquini com Bojo Laranja', '17431', ['PRETO'])).toBe('Biquini com Bojo');
      expect(limpar('Calça Alfaiataria Areia', '800229', ['MARROM', 'PRETO', 'TELHA'])).toBe(
        'Calça Alfaiataria',
      );
      // O rabo depois da cor sai junto, como no laço das cores da própria peça.
      expect(limpar('Calça Pantalona Creme 46 Plus', '69010', ['PRETO', 'VINHO'])).toBe(
        'Calça Pantalona',
      );
    });

    it('cor que a peça TEM continua no nome — inclusive com o corte de 15 caracteres do cadastro', () => {
      // 900910: a cor é gravada "ESTAMPA OFF WHI" e o nome diz "Off White".
      // É a MESMA cor: cortar aqui estragaria um título que estava certo.
      expect(
        limpar('Vestido Mid sem Manga Estampa Off White', '900910', ['ESTAMPA OFF WHI']),
      ).toBe('Vestido Mid sem Manga Estampa Off White');
      expect(limpar('Blusa Manga Curta Vinho', 'B1', ['VINHO'])).toBe('Blusa Manga Curta');
    });

    it('estampa e tecido gravados como "cor" não derrubam nome legítimo', () => {
      // JEANS é cor em 36 REFs do cadastro. "Calça Jeans" de uma peça preta
      // continua sendo uma calça jeans.
      expect(limpar('Calça Jeans', 'J9', ['PRETO'])).toBe('Calça Jeans');
      expect(limpar('Camisa Listrada', 'L9', ['PRETO'])).toBe('Camisa Listrada');
    });

    it('sem vocabulário, nada muda (é o comportamento de antes)', () => {
      expect(limparNomeVitrine('Regata Estampa Mostarda', '132908', ['BEGE'])).toBe(
        'Regata Estampa Mostarda',
      );
      expect(limparNomeVitrine('Regata Estampa Mostarda', '132908', ['BEGE'], null, [])).toBe(
        'Regata Estampa Mostarda',
      );
    });

    it('limpeza que comeria o nome inteiro devolve o original', () => {
      expect(limpar('Preto', 'X1', ['VERDE'])).toBe('Preto');
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
