import {
  planejarNotas,
  pecasDaNota,
  textoInfCplLote,
  remessasDaNota,
  maxItensPorNota,
  RemessaDoLote,
} from './nfe-lote-transferencia';

const EMIT = '30246592000197';
const DEST = '30246592000430';

function rem(code: string, dia: number, skus: Array<[string, number]>, emit = EMIT): RemessaDoLote {
  return {
    id: 'id-' + code,
    code,
    emitenteCnpj: emit,
    destinoCnpj: DEST,
    receivedAt: new Date(Date.UTC(2026, 8, dia, 15)),
    pecas: new Map(skus),
  };
}

describe('planejarNotas', () => {
  it('junta remessas do mesmo emitente numa nota só', () => {
    const notas = planejarNotas([rem('B', 2, [['1', 1]]), rem('A', 1, [['1', 2], ['2', 1]])]);
    expect(notas).toHaveLength(1);
    expect(notas[0].remessas.map((r) => r.code)).toEqual(['A', 'B']);
    expect(Object.fromEntries(pecasDaNota(notas[0]))).toEqual({ '1': 3, '2': 1 });
  });

  it('separa por emitente', () => {
    const notas = planejarNotas([rem('A', 1, [['1', 1]]), rem('B', 2, [['1', 1]], '20104813000139')]);
    expect(notas).toHaveLength(2);
  });

  it('abre nota nova quando passaria do teto de itens distintos', () => {
    const notas = planejarNotas(
      [rem('A', 1, [['1', 1], ['2', 1]]), rem('B', 2, [['2', 5]]), rem('C', 3, [['3', 1], ['4', 1]])],
      3,
    );
    expect(notas.map((n) => n.remessas.map((r) => r.code))).toEqual([['A', 'B'], ['C']]);
  });

  it('remessa maior que o teto vira nota própria e nunca se parte', () => {
    const notas = planejarNotas([rem('A', 1, [['1', 1], ['2', 1], ['3', 1]])], 2);
    expect(notas).toHaveLength(1);
    expect(notas[0].skus.size).toBe(3);
  });

  it('remessa sem peça não gera nota', () => {
    expect(planejarNotas([rem('A', 1, [])])).toHaveLength(0);
  });
});

describe('textoInfCplLote', () => {
  it('cita período e remessas', () => {
    const [n] = planejarNotas([rem('REM-1', 1, [['1', 1]]), rem('REM-2', 20, [['2', 1]])]);
    const t = textoInfCplLote(n);
    expect(t).toContain('2 remessa(s)');
    expect(t).toContain('01/09/2026 a 20/09/2026');
    expect(t).toContain('REM-1, REM-2');
  });
});

describe('auxiliares', () => {
  it('remessasDaNota junta avulsa e lote sem repetir', () => {
    expect(remessasDaNota({ shipmentId: 'a', shipmentIds: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(remessasDaNota({ shipmentId: null, shipmentIds: null })).toEqual([]);
  });
  it('maxItensPorNota tem padrão e teto', () => {
    expect(maxItensPorNota(undefined)).toBe(300);
    expect(maxItensPorNota('abc')).toBe(300);
    expect(maxItensPorNota('5000')).toBe(900);
    expect(maxItensPorNota('50')).toBe(50);
  });
});
