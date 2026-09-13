import { coresDoFeed, tamanhosDoFeed } from './atributos-do-feed';

/**
 * As duas pontas que não podem regredir:
 *
 *  - peça À VENDA anuncia só o que entrega (senão promete tamanho que acabou);
 *  - peça ESGOTADA anuncia a grade inteira (senão vira item sem atributo, que
 *    foi o que gerou "Cor ausente 145 / Tamanho ausente 94" no diagnóstico).
 */
describe('atributos do feed — o que a peça É x o que dá pra comprar', () => {
  const grade = [
    { label: '46', disponivel: true },
    { label: '48', disponivel: false },
    { label: '50', disponivel: true },
  ];

  it('peça à venda publica só os tamanhos compráveis', () => {
    expect(tamanhosDoFeed(grade)).toEqual(['46', '50']);
  });

  it('peça inteira zerada publica a grade inteira em vez de nada', () => {
    const zerada = grade.map((t) => ({ ...t, disponivel: false }));
    expect(tamanhosDoFeed(zerada)).toEqual(['46', '48', '50']);
  });

  it('grade vazia continua vazia — não inventa tamanho', () => {
    expect(tamanhosDoFeed([])).toEqual([]);
    expect(tamanhosDoFeed(null)).toEqual([]);
    expect(tamanhosDoFeed([{ label: '  ' }])).toEqual([]);
  });

  it('label sem a flag conta como comprável (payload antigo não quebra)', () => {
    expect(tamanhosDoFeed([{ label: '52', disponivel: true }, { label: '54' }])).toEqual(['52']);
    expect(tamanhosDoFeed([{ label: '54' }])).toEqual(['54']);
  });

  it('cor vendável ganha da cor da grade, e a ORDEM da vitrine é preservada', () => {
    expect(coresDoFeed(['PRETO', 'MARINHO'], ['AMARELO', 'MARINHO', 'PRETO'])).toEqual([
      'PRETO',
      'MARINHO',
    ]);
  });

  it('sem cor vendável, cai na grade — é o caso das 145 esgotadas', () => {
    expect(coresDoFeed([], ['AMARELO', 'ROSE'])).toEqual(['AMARELO', 'ROSE']);
    expect(coresDoFeed(null, ['PRETO'])).toEqual(['PRETO']);
  });

  it('sem cor em lugar nenhum devolve vazio — o feed omite a tag, não inventa', () => {
    expect(coresDoFeed([], [])).toEqual([]);
    expect(coresDoFeed(null, null)).toEqual([]);
    expect(coresDoFeed([''], ['  '])).toEqual([]);
  });

  it('não repete nome de cor duplicado na grade', () => {
    expect(coresDoFeed([], ['PRETO', 'PRETO', 'ROSE'])).toEqual(['PRETO', 'ROSE']);
  });
});
