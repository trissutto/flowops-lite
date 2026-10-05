import { describe, expect, it } from 'vitest';
import { LOJAS_COM_FICHA, linhasDeInventarioLocal, type EstoqueLoja } from './inventario-local';
import { variantes, type PecaFeed } from './variantes';

/** Peça mínima do feed. Cada cor com foto e estoque vira uma variante. */
function peca(ref: string, cores: Array<{ nome: string; estoque: number }>, extra: Partial<PecaFeed> = {}): PecaFeed {
  return {
    ref,
    slug: `peca-${ref.toLowerCase()}`,
    nome: `Peça ${ref}`,
    preco: 199.9,
    precoPromocional: null,
    disponivel: true,
    imagens: ['https://exemplo.test/a.jpg'],
    tamanhos: ['G1', 'G2'],
    cores: cores.map((c) => c.nome),
    coresDetalhe: cores.map((c) => ({
      nome: c.nome,
      estoque: c.estoque,
      preco: 199.9,
      fotos: [`https://exemplo.test/${c.nome}.jpg`],
      tamanhos: ['G1', 'G2'],
    })),
    ...extra,
  } as PecaFeed;
}

const est = (loja: string, ref: string, cor: string | null, estoque: number): EstoqueLoja => ({ loja, ref, cor, estoque });

describe('inventário local — a prateleira da loja manda (05/10/2026)', () => {
  it('só declara a peça na loja que TEM, com a quantidade DELA', () => {
    const linhas = linhasDeInventarioLocal(
      [peca('8493', [{ nome: 'PRETO', estoque: 9 }])],
      [est('01', '8493', 'PRETO', 2), est('10', '8493', 'PRETO', 7)],
    );
    expect(linhas).toEqual([
      { loja: '01', id: '8493', quantidade: 2, preco: 199.9 },
      { loja: '10', id: '8493', quantidade: 7, preco: 199.9 },
    ]);
  });

  it('o caso que reprovou a verificação: peça só em Jundiaí não aparece em Itanhaém', () => {
    const linhas = linhasDeInventarioLocal(
      [peca('140488', [{ nome: 'AZUL', estoque: 5 }])],
      [est('10', '140488', 'AZUL', 5)],
    );
    expect(linhas.map((l) => l.loja)).toEqual(['10']);
  });

  it('casa cor a cor quando a peça é explodida por cor', () => {
    const p = peca('1320', [
      { nome: 'VINHO', estoque: 8 },
      { nome: 'PRETO', estoque: 3 },
    ]);
    const ids = variantes(p).map((v) => v.id);
    expect(ids).toHaveLength(2);

    const linhas = linhasDeInventarioLocal(
      [p],
      [est('01', '1320', 'VINHO', 4), est('02', '1320', 'PRETO', 3), est('02', '1320', 'VINHO', 4)],
    );
    const daLoja = (n: string) => linhas.filter((l) => l.loja === n).map((l) => l.id).sort();
    // Itanhaém só tem a vinho — a preta NÃO pode sair declarada lá.
    expect(daLoja('01')).toHaveLength(1);
    expect(daLoja('02')).toHaveLength(2);
    expect(new Set(linhas.map((l) => l.id))).toEqual(new Set(ids));
  });

  it('acento e caixa da cor não derrubam o casamento', () => {
    const p = peca('700991', [
      { nome: 'CAFÉ', estoque: 6 },
      { nome: 'PRETO', estoque: 2 },
    ]);
    const linhas = linhasDeInventarioLocal([p], [est('05', '700991', 'cafe', 6), est('05', '700991', 'Preto', 2)]);
    expect(linhas.filter((l) => l.loja === '05')).toHaveLength(2);
  });

  it('peça de cor única soma todas as cores do estoque daquela loja', () => {
    const linhas = linhasDeInventarioLocal(
      [peca('VLM-222', [{ nome: 'PRETO', estoque: 5 }])],
      [est('03', 'VLM-222', 'PRETO', 2), est('03', 'VLM-222', null, 1)],
    );
    expect(linhas).toEqual([{ loja: '03', id: 'VLM-222', quantidade: 3, preco: 199.9 }]);
  });

  it('loja sem ficha (13/SITE, depósito, matriz, Itu) nunca sai — nem empresta estoque', () => {
    const linhas = linhasDeInventarioLocal(
      [peca('8493', [{ nome: 'PRETO', estoque: 40 }])],
      [est('13', '8493', 'PRETO', 30), est('20', '8493', 'PRETO', 5), est('09', '8493', 'PRETO', 3), est('19', '8493', 'PRETO', 2)],
    );
    expect(linhas).toEqual([]);
  });

  it('código da loja sem zero à esquerda casa com a ficha', () => {
    const linhas = linhasDeInventarioLocal(
      [peca('8493', [{ nome: 'PRETO', estoque: 4 }])],
      [est('1', '8493', 'PRETO', 1), est(' 7 ', '8493', 'PRETO', 3)],
    );
    expect(linhas.map((l) => `${l.loja}:${l.quantidade}`)).toEqual(['01:1', '07:3']);
  });

  it('manda o preço promocional quando existe — é o que o caixa cobra', () => {
    const linhas = linhasDeInventarioLocal(
      [peca('VLM-222', [{ nome: 'PRETO', estoque: 5 }], { preco: 239.9, precoPromocional: 139.9 })],
      [est('01', 'VLM-222', 'PRETO', 5)],
    );
    expect(linhas[0].preco).toBe(139.9);
  });

  it('estoque zerado ou negativo não vira linha', () => {
    const linhas = linhasDeInventarioLocal(
      [peca('8493', [{ nome: 'PRETO', estoque: 4 }])],
      [est('01', '8493', 'PRETO', 0), est('02', '8493', 'PRETO', -2), est('03', '8493', 'PRETO', 4)],
    );
    expect(linhas.map((l) => l.loja)).toEqual(['03']);
  });

  it('peça sem preço, sem slug ou sem ref fica de fora', () => {
    const boa = peca('8493', [{ nome: 'PRETO', estoque: 4 }]);
    const linhas = linhasDeInventarioLocal(
      [{ ...boa, preco: 0 }, { ...boa, slug: '' }, { ...boa, ref: '' }],
      [est('01', '8493', 'PRETO', 4)],
    );
    expect(linhas).toEqual([]);
  });
});

describe('inventário local — chave FEED_LOCAL_ESTOQUE_REDE (a regra de 13/09)', () => {
  it('declara o total da rede nas 14 fichas', () => {
    const linhas = linhasDeInventarioLocal(
      [peca('8493', [{ nome: 'PRETO', estoque: 9 }])],
      [est('01', '8493', 'PRETO', 2), est('10', '8493', 'PRETO', 7), est('13', '8493', 'PRETO', 50)],
      { estoqueDaRede: true },
    );
    expect(linhas).toHaveLength(LOJAS_COM_FICHA.size);
    // A 13/SITE continua fora da soma: 2 + 7, nunca 59.
    expect(new Set(linhas.map((l) => l.quantidade))).toEqual(new Set([9]));
  });

  it('peça que a rede não tem não entra em ficha nenhuma, nem com a chave ligada', () => {
    const linhas = linhasDeInventarioLocal(
      [peca('8493', [{ nome: 'PRETO', estoque: 9 }])],
      [est('13', '8493', 'PRETO', 50)],
      { estoqueDaRede: true },
    );
    expect(linhas).toEqual([]);
  });
});

describe('inventário local — margem de segurança (FEED_LOCAL_MIN_ESTOQUE)', () => {
  const p = [peca('8493', [{ nome: 'PRETO', estoque: 9 }])];
  const e = [est('01', '8493', 'PRETO', 1), est('02', '8493', 'PRETO', 2), est('10', '8493', 'PRETO', 6)];

  it('com mínimo 2, a loja com 1 unidade não declara a peça', () => {
    const linhas = linhasDeInventarioLocal(p, e, { estoqueMinimo: 2 });
    expect(linhas.map((l) => `${l.loja}:${l.quantidade}`)).toEqual(['02:2', '10:6']);
  });

  it('sem a opção (ou com 1) vale qualquer unidade', () => {
    expect(linhasDeInventarioLocal(p, e)).toHaveLength(3);
    expect(linhasDeInventarioLocal(p, e, { estoqueMinimo: 1 })).toHaveLength(3);
  });

  it('valor torto não derruba o feed: 0, negativo e fração caem pra 1 ou pro inteiro', () => {
    expect(linhasDeInventarioLocal(p, e, { estoqueMinimo: 0 })).toHaveLength(3);
    expect(linhasDeInventarioLocal(p, e, { estoqueMinimo: -5 })).toHaveLength(3);
    expect(linhasDeInventarioLocal(p, e, { estoqueMinimo: 2.9 })).toHaveLength(2);
  });

  it('a margem não se aplica à regra da rede', () => {
    const linhas = linhasDeInventarioLocal(p, e, { estoqueDaRede: true, estoqueMinimo: 50 });
    expect(linhas).toHaveLength(LOJAS_COM_FICHA.size);
  });
});
