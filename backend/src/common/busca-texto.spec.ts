import { casaBusca, normalizarBusca, termoCasa } from './busca-texto';

/**
 * Os casos são os TERMOS REAIS que voltaram vazios em 31/08/2026, no primeiro
 * dia em que a busca gravou quantos resultados devolveu (25 de 75 vazias).
 */
describe('busca-texto', () => {
  it('ignora acento — "sutia" acha "Sutiã Sem Bojo"', () => {
    expect(casaBusca('Sutiã Sem Bojo — 813103', 'sutia')).toBe(true);
    expect(casaBusca('Sutiã Sem Bojo', 'SUTIÃ')).toBe(true);
    expect(casaBusca('Macacão Longo', 'macacao')).toBe(true);
    expect(casaBusca('Calça Pantalona', 'calca')).toBe(true);
  });

  it('tolera plural — "regatas" acha "Regata"', () => {
    // Medido em produção: busca=regatas devolvia 0; busca=regata, 37.
    expect(casaBusca('Regata — C5113 · Off White', 'regatas')).toBe(true);
    expect(casaBusca('Vestido Longo Manga Curta', 'vestidos')).toBe(true);
    // Um plural no meio não pode zerar a frase inteira.
    expect(casaBusca('Vestido Curto Manga Curta', 'vestidos curtos')).toBe(true);
  });

  it('não corta o S de termo curto', () => {
    // Sem o piso de 3 letras, "as"/"os" casariam com meio catálogo.
    expect(termoCasa('VESTIDO LONGO', 'AS')).toBe(false);
    expect(termoCasa('VESTIDO LONGO', 'OS')).toBe(false);
    // "MAIS" tem 4 letras: vira "MAI", que não está no alvo. Segue falso.
    expect(termoCasa('VESTIDO LONGO', 'MAIS')).toBe(false);
  });

  it('continua exigindo TODOS os termos', () => {
    expect(casaBusca('Vestido Longo Manga Curta', 'vestido longo')).toBe(true);
    expect(casaBusca('Vestido Longo Manga Curta', 'vestido jeans')).toBe(false);
    expect(casaBusca('Blusa Manga Curta', 'vestido')).toBe(false);
  });

  it('busca vazia não filtra nada', () => {
    expect(casaBusca('qualquer coisa', '')).toBe(true);
    expect(casaBusca('qualquer coisa', '   ')).toBe(true);
  });

  it('normaliza dos dois lados', () => {
    expect(normalizarBusca(' Sutiã ')).toBe('SUTIA');
    expect(normalizarBusca(null)).toBe('');
    expect(normalizarBusca('Calção Ação')).toBe('CALCAO ACAO');
  });
});
