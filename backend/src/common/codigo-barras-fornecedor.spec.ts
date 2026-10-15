import {
  conferirCodigosDeBarras,
  descreverProblemasDosCodigos,
  mesmaPeca,
  motivoCodigoBarrasInvalido,
  normalizarCodigoBarras,
} from './codigo-barras-fornecedor';

describe('codigo-barras-fornecedor — o que o leitor mandou na conferência', () => {
  describe('normalizarCodigoBarras', () => {
    it('tira espaço (inclusive no meio) e põe em maiúsculas', () => {
      expect(normalizarCodigoBarras('  7891 234 567895 ')).toBe('7891234567895');
      expect(normalizarCodigoBarras('abc-123456')).toBe('ABC-123456');
    });

    it('MANTÉM o zero à esquerda — a etiqueta imprime com ele e o bipe procura o texto cru', () => {
      expect(normalizarCodigoBarras('0123456789012')).toBe('0123456789012');
    });

    it('vazio e nulo viram string vazia', () => {
      expect(normalizarCodigoBarras(null)).toBe('');
      expect(normalizarCodigoBarras(undefined)).toBe('');
      expect(normalizarCodigoBarras('   ')).toBe('');
    });
  });

  describe('motivoCodigoBarrasInvalido', () => {
    it('EAN-13 do fornecedor serve', () => {
      expect(motivoCodigoBarrasInvalido('7891234567895')).toBeNull();
    });

    // O bipe do PDV só procura na coluna `ean` termos com 8+ caracteres:
    // gravar menos que isso é gravar uma peça que nunca vai ser achada.
    it('menos de 8 caracteres é recusado', () => {
      expect(motivoCodigoBarrasInvalido('1234567')).toMatch(/curto/);
      expect(motivoCodigoBarrasInvalido('12345678')).toBeNull();
    });

    it('acima de 20 (teto da coluna) é recusado', () => {
      expect(motivoCodigoBarrasInvalido('1'.repeat(21))).toMatch(/longo/);
      expect(motivoCodigoBarrasInvalido('1'.repeat(20))).toBeNull();
    });

    it('caractere fora de letra/número/hífen é recusado', () => {
      expect(motivoCodigoBarrasInvalido('7891234.567895')).toMatch(/letras, números e hífen/);
    });
  });

  describe('conferirCodigosDeBarras', () => {
    it('todos os tamanhos com peça lidos = ok, mapa normalizado', () => {
      const r = conferirCodigosDeBarras(['P', 'M'], { P: ' 7891234567895', M: '7891234567901' });
      expect(r.ok).toBe(true);
      expect(r.porTamanho).toEqual({ P: '7891234567895', M: '7891234567901' });
      expect(r.faltando).toEqual([]);
    });

    it('tamanho com peça sem código = recusa, e diz qual', () => {
      const r = conferirCodigosDeBarras(['P', 'M', 'G'], { P: '7891234567895' });
      expect(r.ok).toBe(false);
      expect(r.faltando).toEqual(['M', 'G']);
      expect(descreverProblemasDosCodigos(r)).toContain('sem código de barras no tamanho M, G');
    });

    it('tamanho SEM peça não pede código, e código a mais é ignorado', () => {
      const r = conferirCodigosDeBarras(['P'], { P: '7891234567895', GG: '7891234567999' });
      expect(r.ok).toBe(true);
      expect(r.porTamanho).toEqual({ P: '7891234567895' });
    });

    it('código inválido aponta o tamanho e o motivo', () => {
      const r = conferirCodigosDeBarras(['P'], { P: '123' });
      expect(r.ok).toBe(false);
      expect(r.invalidos).toEqual([{ tamanho: 'P', valor: '123', motivo: expect.stringMatching(/curto/) }]);
      expect(descreverProblemasDosCodigos(r)).toContain('tamanho P');
    });

    // O leitor bipou a mesma etiqueta duas vezes (ou a pessoa não trocou a
    // peça): dois tamanhos com o mesmo EAN deixariam o bipe do caixa no escuro.
    it('mesmo código em dois tamanhos é recusado', () => {
      const r = conferirCodigosDeBarras(['P', 'M'], { P: '7891234567895', M: '7891234567895' });
      expect(r.ok).toBe(false);
      expect(r.repetidos).toEqual([{ codigo: '7891234567895', tamanhos: ['P', 'M'] }]);
      expect(descreverProblemasDosCodigos(r)).toContain('lido em mais de um tamanho');
    });

    it('nada lido (null) = todos faltando', () => {
      const r = conferirCodigosDeBarras(['46', '48'], null);
      expect(r.faltando).toEqual(['46', '48']);
    });
  });

  describe('mesmaPeca — o código de barras já existe no catálogo', () => {
    const item = { ref: '7031', cor: 'AZUL', tamanho: 'P' };

    it('mesma REF, cor e tamanho = a mesma peça (segunda compra reaproveita o código)', () => {
      expect(mesmaPeca({ ref: '7031', cor: 'Azul ', tamanho: 'p' }, item)).toBe(true);
    });

    it('outra cor ou outro tamanho = outra peça', () => {
      expect(mesmaPeca({ ref: '7031', cor: 'PRETO', tamanho: 'P' }, item)).toBe(false);
      expect(mesmaPeca({ ref: '7031', cor: 'AZUL', tamanho: 'M' }, item)).toBe(false);
    });

    it('outra REF = outra peça, mesmo com cor e tamanho iguais', () => {
      expect(mesmaPeca({ ref: '7032', cor: 'AZUL', tamanho: 'P' }, item)).toBe(false);
    });

    it('cadastro sem REF nunca é "a mesma" — não dá pra afirmar', () => {
      expect(mesmaPeca({ ref: null, cor: 'AZUL', tamanho: 'P' }, item)).toBe(false);
    });

    // As colunas do cadastro são cortadas (ref 10, cor 15): a comparação
    // corta igual, senão REF longa nunca bateria consigo mesma.
    it('compara com o corte das colunas do cadastro', () => {
      expect(
        mesmaPeca(
          { ref: 'ABCDEFGHIJ', cor: 'VERDE MUSGO CLA', tamanho: 'P' },
          { ref: 'ABCDEFGHIJKL', cor: 'VERDE MUSGO CLARO', tamanho: 'P' },
        ),
      ).toBe(true);
    });
  });
});
