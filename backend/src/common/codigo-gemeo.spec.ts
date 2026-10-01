import { acharGemeoNoPedido, chaveDaPeca } from './codigo-gemeo';

describe('código gêmeo — mesma peça com dois códigos no cadastro', () => {
  const pedido = [
    { codigo: '5391111', ref: '207333', cor: 'PRETO', tamanho: '56' },
    { codigo: '5392222', ref: '207333', cor: 'PRETO', tamanho: '58' },
  ];

  it('aceita o código bipado quando REF+COR+TAMANHO batem com um item do pedido', () => {
    const bipada = { codigo: '5238927', ref: '207333', cor: 'Preto ', tamanho: '56' };
    expect(acharGemeoNoPedido(bipada, pedido)).toBe('5391111');
  });

  it('acento e caixa não separam gêmeos', () => {
    expect(chaveDaPeca({ codigo: '1', ref: 'a1', cor: 'Açaí', tamanho: 'gg' })).toBe('A1|ACAI|GG');
  });

  it('recusa tamanho ou cor diferente', () => {
    expect(acharGemeoNoPedido({ codigo: 'X', ref: '207333', cor: 'PRETO', tamanho: '54' }, pedido)).toBeNull();
    expect(acharGemeoNoPedido({ codigo: 'X', ref: '207333', cor: 'BEGE', tamanho: '56' }, pedido)).toBeNull();
  });

  it('recusa quando falta REF, cor ou tamanho no cadastro — sem palpite', () => {
    expect(acharGemeoNoPedido({ codigo: 'X', ref: '207333', cor: '', tamanho: '56' }, pedido)).toBeNull();
    expect(
      acharGemeoNoPedido({ codigo: 'X', ref: '', cor: '', tamanho: '' }, [{ codigo: 'Y', ref: '', cor: '', tamanho: '' }]),
    ).toBeNull();
    expect(acharGemeoNoPedido(null, pedido)).toBeNull();
  });

  it('recusa quando dois SKUs do card têm a mesma chave (não dá pra saber qual)', () => {
    const ambiguo = [...pedido, { codigo: '5399999', ref: '207333', cor: 'PRETO', tamanho: '56' }];
    expect(acharGemeoNoPedido({ codigo: 'X', ref: '207333', cor: 'PRETO', tamanho: '56' }, ambiguo)).toBeNull();
  });
});
