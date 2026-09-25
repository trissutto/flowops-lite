import { franquiaPrimeiroLigado, lojasUltimoCaso, normalizarCodigoLoja, tierDaLoja } from './prioridade-lojas';

describe('prioridade-lojas — régua das regras 1 e 2 do dono (25/09)', () => {
  it('franquia primeiro nasce LIGADA; só "0" desliga', () => {
    expect(franquiaPrimeiroLigado({} as any)).toBe(true);
    expect(franquiaPrimeiroLigado({ ROUTING_FRANQUIA_PRIMEIRO: '1' } as any)).toBe(true);
    expect(franquiaPrimeiroLigado({ ROUTING_FRANQUIA_PRIMEIRO: '0' } as any)).toBe(false);
  });

  it('último caso: default é Indaiatuba (04); env vazia desliga; lista aceita LJ e sem zero', () => {
    expect(lojasUltimoCaso({} as any)).toEqual(['04']);
    expect(lojasUltimoCaso({ ROUTING_ULTIMO_CASO_CODES: '' } as any)).toEqual([]);
    expect(lojasUltimoCaso({ ROUTING_ULTIMO_CASO_CODES: '4, LJ20 ,04' } as any)).toEqual(['04', '20']);
  });

  it('normalizarCodigoLoja: "4" → "04", "LJ07" → "07", "SITE" fica', () => {
    expect(normalizarCodigoLoja('4')).toBe('04');
    expect(normalizarCodigoLoja('LJ07')).toBe('07');
    expect(normalizarCodigoLoja(' 18 ')).toBe('18');
    expect(normalizarCodigoLoja('SITE')).toBe('SITE');
    expect(normalizarCodigoLoja(null)).toBe('');
  });

  it('tier: FILIAL = 0 (vence), REDE/sem tipo = 1; regra desligada iguala todo mundo', () => {
    expect(tierDaLoja({ tipo: 'FILIAL' }, true)).toBe(0);
    expect(tierDaLoja({ tipo: 'filial' }, true)).toBe(0);
    expect(tierDaLoja({ tipo: 'REDE' }, true)).toBe(1);
    expect(tierDaLoja({}, true)).toBe(1);
    expect(tierDaLoja({ tipo: 'FILIAL' }, false)).toBe(1);
  });
});
