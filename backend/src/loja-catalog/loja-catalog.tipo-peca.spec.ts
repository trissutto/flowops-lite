import { LojaCatalogService } from './loja-catalog.service';

/**
 * REF RECICLADA NÃO PODE VIRAR "COR" (Limeira, 13/08/2026).
 *
 * A página "Regata Estampa Mostarda" (REF 132908) mostrava duas bolinhas: a
 * regata e uma CAMISA LISTRADA, com outra grade. A cliente escolhia a cor e
 * recebia outra roupa.
 *
 * A separação por REF reciclada olhava a PRIMEIRA PALAVRA da descrição, e no
 * ERP as duas eram "BLUSA ..." — regata é blusa, camisa é blusa. Agora o que
 * separa é o TIPO da peça.
 *
 * Os dois lados são testados de propósito: separar demais é tão caro quanto
 * separar de menos. Rachar uma peça boa some com cores que vendem
 * (392 peças invisíveis foi o custo da regra de foto, em 13/08).
 */

// Métodos privados por desenho — o teste exercita a REGRA, e a regra não
// merece virar API pública só pra ser testada.
const svc = new LojaCatalogService({} as any, {} as any) as any;
const tipo = (d: string) => svc.tipoDePeca(d);
const chave = (d: string) => svc.chaveDeProduto(d);

describe('tipoDePeca', () => {
  it('separa os dois produtos que a REF 132908 juntou', () => {
    expect(tipo('BLUSA REGATA FEMININA PLUS SIZE ESTAMPA MOSTARDA')).toBe('regata');
    expect(tipo('BLUSA FEMININA PLUS SIZE MANGA CURTA LISTRADA')).toBe('blusa');
    expect(tipo('CAMISA FEMININA PLUS SIZE LISTRADA')).toBe('camisa');
  });

  it('o mais específico ganha do genérico na mesma frase', () => {
    // "BLUSA REGATA" é regata: sem a prioridade, "blusa" venceria por vir
    // antes na frase — que é exatamente o caso que quebrou.
    expect(tipo('BLUSA REGATA ALCA LARGA')).toBe('regata');
    expect(tipo('BLUSA MANGA CURTA')).toBe('blusa');
  });

  it('sinônimos caem no MESMO balde — rachar peça boa também custa venda', () => {
    const mesmo = [
      'BLUSA FEMININA MANGA CURTA PLUS SIZE',
      'CAMISETA FEMININA PLUS SIZE',
      'T-SHIRT FEMININA PLUS SIZE',
      'CROPPED FEMININO PLUS SIZE',
    ].map(tipo);
    expect(new Set(mesmo).size).toBe(1);
    expect(mesmo[0]).toBe('blusa');
  });

  it('não confunde acento, caixa nem pontuação', () => {
    expect(tipo('calça pantalona')).toBe('calca');
    expect(tipo('CALÇA JEANS PLUS SIZE')).toBe('calca');
    expect(tipo('Macacão Feminino')).toBe('macacao');
  });

  it('devolve vazio pro que está fora do vocabulário', () => {
    expect(tipo('CINTO DOURADO')).toBe('');
    expect(tipo('')).toBe('');
  });
});

describe('chaveDeProduto', () => {
  it('cai na família quando não reconhece o tipo — vazio agruparia tudo', () => {
    // Sem o fallback, CINTO e BOLSA teriam a mesma chave ('') e virariam
    // "o mesmo produto" — o bug que este arquivo existe pra impedir.
    expect(chave('CINTO DOURADO')).not.toBe(chave('BOLSA TIRACOLO'));
  });

  it('casa o nome do site com a descrição do ERP', () => {
    // O nome publicado é "Regata Estampa Mostarda" e o ERP diz "BLUSA REGATA
    // ...". Pela primeira palavra ('regata' vs 'blusa') nunca casava, e a
    // escolha caía no desempate por estoque: ia pro ar a peça com mais peça na
    // arara, não a que a loja publicou.
    expect(chave('Regata Estampa Mostarda')).toBe(chave('BLUSA REGATA FEMININA PLUS SIZE'));
  });

  it('mantém junto o que já estava junto (T-shirt VOGUE)', () => {
    expect(chave('T-shirt Manga Curta')).toBe(chave('BLUSA FEMININA MANGA CURTA PLUS SIZE'));
  });
});
