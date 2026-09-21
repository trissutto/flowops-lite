import {
  ORIGEM_PEDIDO_VITALICIOS,
  codigoSemZeros,
  contaDaCompra,
  itemAindaAChegar,
  ordenarTamanhos,
  pendenteDoItem,
  piorSituacao,
} from './compra-vitalicios';

describe('compra de vitalícios — a conta de um tamanho', () => {
  it('TENHO = rede + trânsito + já pedido; COMPRAR completa até o IDEAL', () => {
    const r = contaDaCompra({ estoque: 3, transito: 1, emPedido: 2, minimo: 4, ideal: 10 });
    expect(r.tenho).toBe(6);
    expect(r.comprar).toBe(4);
    expect(r.situacao).toBe('abaixo_ideal');
  });

  it('abaixo do MÍNIMO fica vermelho, e mesmo assim completa até o IDEAL', () => {
    const r = contaDaCompra({ estoque: 1, transito: 0, emPedido: 0, minimo: 3, ideal: 8 });
    expect(r.situacao).toBe('abaixo_minimo');
    expect(r.comprar).toBe(7);
  });

  it('entre o mínimo e o ideal TAMBÉM entra no pedido (decisão do dono: tudo abaixo do ideal)', () => {
    const r = contaDaCompra({ estoque: 5, transito: 0, emPedido: 0, minimo: 3, ideal: 8 });
    expect(r.situacao).toBe('abaixo_ideal');
    expect(r.comprar).toBe(3);
  });

  it('sem IDEAL o COMPRAR é VAZIO, não zero — ninguém configurou', () => {
    const r = contaDaCompra({ estoque: 0, transito: 0, emPedido: 0, minimo: 2, ideal: null });
    expect(r.comprar).toBeNull();
    expect(r.situacao).toBe('sem_ideal');
  });

  it('sobra não vira pedido negativo', () => {
    const r = contaDaCompra({ estoque: 15, transito: 0, emPedido: 0, minimo: 2, ideal: 8 });
    expect(r.comprar).toBe(0);
    expect(r.situacao).toBe('ok');
  });

  it('IDEAL zero com peça na rede é encalhe, não ok', () => {
    expect(contaDaCompra({ estoque: 2, transito: 0, emPedido: 0, minimo: 0, ideal: 0 }).situacao).toBe('encalhe');
    expect(contaDaCompra({ estoque: 0, transito: 0, emPedido: 0, minimo: 0, ideal: 0 }).situacao).toBe('ok');
  });

  it('estoque negativo de loja (contagem errada) não desconta das outras', () => {
    expect(contaDaCompra({ estoque: -3, transito: 0, emPedido: 0, minimo: null, ideal: 4 }).comprar).toBe(4);
  });

  it('a pior situação manda na linha da cor', () => {
    expect(piorSituacao(['ok', 'abaixo_ideal', 'abaixo_minimo'])).toBe('abaixo_minimo');
    expect(piorSituacao(['ok', 'sem_ideal'])).toBe('ok');
    expect(piorSituacao([])).toBe('sem_ideal');
  });
});

describe('o que um pedido de compra ainda deve', () => {
  it('pendente = pedido − recebido, nunca negativo, aceita JSON em texto', () => {
    expect(pendenteDoItem('{"46":5,"48":3}', '{"46":2,"48":4}')).toEqual({ '46': 3 });
    expect(pendenteDoItem({ '50': 2 }, null)).toEqual({ '50': 2 });
    expect(pendenteDoItem('lixo', null)).toEqual({});
  });

  it('só conta item a caminho: nem cancelado, nem recebido', () => {
    expect(itemAindaAChegar('enviado', null, 'pendente')).toBe(true);
    expect(itemAindaAChegar('aguardando', null, 'parcial')).toBe(true);
    expect(itemAindaAChegar('recebido_parcial', null, 'pendente')).toBe(true);
    expect(itemAindaAChegar('cancelado', null, 'pendente')).toBe(false);
    expect(itemAindaAChegar('enviado', null, 'recebido')).toBe(false);
  });

  it('rascunho só segura compra se foi gerado pela aba (evita pedido em dobro, ignora rascunho esquecido)', () => {
    expect(itemAindaAChegar('rascunho', ORIGEM_PEDIDO_VITALICIOS, 'pendente')).toBe(true);
    expect(itemAindaAChegar('rascunho', null, 'pendente')).toBe(false);
  });
});

describe('miudezas', () => {
  it('grade da casa primeiro, em ordem; o resto depois', () => {
    expect(ordenarTamanhos(['60', 'G', '46', '44', '50', 'gg', '50'])).toEqual(['46', '50', '60', '44', 'G', 'GG']);
  });

  it('código sem zeros à esquerda', () => {
    expect(codigoSemZeros('0008000000003614')).toBe('8000000003614');
  });
});
