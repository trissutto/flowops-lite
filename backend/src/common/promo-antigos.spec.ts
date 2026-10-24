import {
  ANTIGOS_CADASTRO_ATE,
  decidirAntigos,
  diaDoCadastro,
  precoDaFaixa,
  rotuloAntigos,
  totalDoItemAntigos,
} from './promo-antigos';

/**
 * A promoção dos antigos (dono, 23/10/2026): cadastro até 31/12/2023, MODA,
 * R$ 49,90 até 149,90 e R$ 99,90 de 149,91 pra cima. O que este arquivo
 * tranca é a fronteira — de data e de preço — e que a "promoção" nunca sobe
 * o preço de ninguém.
 */
describe('promo-antigos — faixa de preço', () => {
  it('até 149,90 vira 49,90; de 149,91 pra cima vira 99,90', () => {
    expect(precoDaFaixa(59.9)).toBe(49.9);
    expect(precoDaFaixa(149.9)).toBe(49.9);
    expect(precoDaFaixa(149.91)).toBe(99.9);
    expect(precoDaFaixa(399)).toBe(99.9);
  });

  it('fronteira em centavos — float de 149,9 não escapa pra faixa de cima', () => {
    expect(precoDaFaixa(0.1 + 149.8)).toBe(49.9);
  });
});

describe('promo-antigos — quem entra', () => {
  const basicos = new Set(['REF-BASICA', '#8009']);
  const peca = (over: any = {}) => ({ ref: '700979', codigo: '8001', dataCadastro: '2021-05-10', preco: 129.9, ...over });

  it('peça antiga de MODA entra pelo preço da faixa', () => {
    const d = decidirAntigos(peca(), basicos);
    expect(d).toMatchObject({ entra: true, criterio: 'faixa', precoFaixa: 49.9 });
    expect(decidirAntigos(peca({ preco: 219.9 }), basicos).precoFaixa).toBe(99.9);
  });

  it('31/12/2023 entra; 01/01/2024 não', () => {
    expect(decidirAntigos(peca({ dataCadastro: ANTIGOS_CADASTRO_ATE }), basicos).entra).toBe(true);
    expect(decidirAntigos(peca({ dataCadastro: new Date('2023-12-31T00:00:00.000Z') }), basicos).entra).toBe(true);
    const d = decidirAntigos(peca({ dataCadastro: '2024-01-01' }), basicos);
    expect(d).toMatchObject({ entra: false, criterio: 'nova', precoFaixa: null });
  });

  it('sem data de cadastro fica fora', () => {
    expect(decidirAntigos(peca({ dataCadastro: null }), basicos).criterio).toBe('sem_data');
    expect(decidirAntigos(peca({ dataCadastro: 'lixo' }), basicos).criterio).toBe('sem_data');
  });

  it('BÁSICO fica fora — pela REF, e pelo código quando não há REF', () => {
    expect(decidirAntigos(peca({ ref: ' ref-basica ' }), basicos).criterio).toBe('basico');
    expect(decidirAntigos(peca({ ref: null, codigo: '8009' }), basicos).criterio).toBe('basico');
  });

  it('peça que já custa a faixa ou menos fica fora — a promoção não sobe preço', () => {
    expect(decidirAntigos(peca({ preco: 49.9 }), basicos)).toMatchObject({ entra: false, criterio: 'ja_barata' });
    expect(decidirAntigos(peca({ preco: 9.9 }), basicos).entra).toBe(false);
    // nem posta na mão
    expect(decidirAntigos(peca({ preco: 29.9 }), basicos, true).entra).toBe(false);
  });

  it('a vendedora põe na mão a nova, a sem data e a básica', () => {
    for (const over of [{ dataCadastro: '2024-03-01' }, { dataCadastro: null }, { ref: 'REF-BASICA' }]) {
      const d = decidirAntigos(peca(over), basicos, true);
      expect(d.entra).toBe(true);
      expect(d.precoFaixa).toBe(49.9);
    }
  });
});

describe('promo-antigos — linha do PDV', () => {
  it('total = preço da faixa × quantidade, desconto = o que sobra', () => {
    expect(totalDoItemAntigos(129.9, 2, 49.9)).toEqual({ bruto: 259.8, total: 99.8, desconto: 160 });
    expect(totalDoItemAntigos(199.95, 1, 99.9)).toEqual({ bruto: 199.95, total: 99.9, desconto: 100.05 });
  });

  it('etiqueta começa com PROMO', () => {
    expect(rotuloAntigos(49.9)).toBe('PROMO R$ 49,90 · antigos');
    expect(rotuloAntigos(99.9, true)).toBe('PROMO R$ 99,90 · antigos · na mão');
  });

  it('dia do cadastro aceita Date e texto', () => {
    expect(diaDoCadastro(new Date('2020-02-03T00:00:00.000Z'))).toBe('2020-02-03');
    expect(diaDoCadastro('2020-02-03T10:00:00')).toBe('2020-02-03');
    expect(diaDoCadastro('')).toBeNull();
  });
});
