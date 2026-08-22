import { LojaCatalogService } from './loja-catalog.service';
import { eventLoopStub } from './event-loop.stub';

/**
 * "FORA DO SITE" TEM QUE SAIR DO SITE (19/08/2026).
 *
 * Dois furos que faziam o dono marcar a cor, salvar, olhar a vitrine e ver a
 * peça no ar:
 *
 * 1. A MESMA COR com DUAS linhas de ficha (REF com duas fichas — o caso de
 *    peça sem marca no ERP, gravada como marca vazia pelo importador e como
 *    "SEM MARCA" pela tela). O primeiro-ganha lia a que dizia `publicado`.
 *    Medido na produção: 350842/CHOCOLATE escondida em 18/08, à venda em 19/08.
 * 2. Escondida a ÚNICA cor, o CARD continuava na vitrine — sem bolinha e sem
 *    grade, mas lá — porque a galeria cai no acervo cru quando não sobra foto
 *    vendável, e a listagem só corta peça sem imagem.
 */

const svc = new LojaCatalogService({} as any, {} as any, eventLoopStub) as any;

const linha = (over: Partial<any> = {}) => ({
  ref: '350842', codigo: '1001', cor: 'CHOCOLATE', tamanho: '46', marca: null,
  categoria: 'LINGERIE', descricao: 'CINTA MODELADORA MACAQUINHO COM BOJO',
  preco: 199.9, custo: null, ean: null, ncm: null, cst: null,
  // Acima do piso por cor (10) — senão a cor sai por estoque, não pela ficha.
  estoque: 45, dataAlt: new Date('2026-08-14'),
  ...over,
});

const foto = (cor: string | null, url: string) => ({ ref: '350842', cor, url, ordem: 0 });

const montar = (linhas: any[], fotos: any[], fichas: any[] = []) =>
  svc.montarPeca('350842', linhas, null, null, fotos, fichas[0], 0, fichas, null);

describe('montarPeca — "fora do site" é veto, não empate', () => {
  const escondida = { cor: 'CHOCOLATE', statusPublicacao: 'nao_publicar' };
  const publicada = { cor: 'CHOCOLATE', statusPublicacao: 'publicado' };

  it('esconde a cor mesmo quando a OUTRA ficha da REF diz "publicado"', () => {
    const p = montar(
      [linha(), linha({ codigo: '1002', cor: 'PRETO', estoque: 49 })],
      [foto('CHOCOLATE', 'chocolate.jpg'), foto('PRETO', 'preto.jpg')],
      // A ficha da marca vazia (a escolhida) publica; a "SEM MARCA", onde a
      // retaguarda clicou, esconde.
      [{ marca: '', cores: [publicada] }, { marca: 'SEM MARCA', cores: [escondida] }],
    );
    expect(p.cores.map((c: any) => c.nome)).toEqual(['PRETO']);
    expect(p.coresOcultas).toEqual([
      expect.objectContaining({ nome: 'CHOCOLATE', motivo: 'nao_publicar' }),
    ]);
  });

  it('vale nos dois sentidos — a ordem das fichas não decide', () => {
    const p = montar(
      [linha(), linha({ codigo: '1002', cor: 'PRETO', estoque: 49 })],
      [foto('CHOCOLATE', 'chocolate.jpg'), foto('PRETO', 'preto.jpg')],
      [{ marca: 'SEM MARCA', cores: [escondida] }, { marca: '', cores: [publicada] }],
    );
    expect(p.cores.map((c: any) => c.nome)).toEqual(['PRETO']);
  });

  it('o conteúdo das duas fichas se completa — título de uma, bolinha da outra', () => {
    const p = montar(
      [linha()],
      [foto('CHOCOLATE', 'chocolate.jpg')],
      [
        { marca: '', cores: [{ cor: 'CHOCOLATE', statusPublicacao: 'publicado', corHex: '#5B3A29' }] },
        { marca: 'SEM MARCA', cores: [{ cor: 'CHOCOLATE', statusPublicacao: 'publicado', tituloComercial: 'Macaquinho Chocolate' }] },
      ],
    );
    const cor = p.cores[0];
    expect(cor.swatch.hex).toBe('#5B3A29');
    expect(cor.nomeAmigavel).toBe('Macaquinho Chocolate');
  });

  it('bolinha não se mistura: o hex de uma não entra no recorte da outra', () => {
    const p = montar(
      [linha()],
      [foto('CHOCOLATE', 'chocolate.jpg')],
      [
        { marca: '', cores: [{ cor: 'CHOCOLATE', statusPublicacao: 'publicado' }] },
        {
          marca: 'SEM MARCA',
          cores: [{
            cor: 'CHOCOLATE', statusPublicacao: 'publicado',
            swatchTipo: 'foto', swatchFocoX: 0.4, swatchFocoY: 0.6,
          }],
        },
      ],
    );
    expect(p.cores[0].swatch).toMatchObject({ tipo: 'foto', hex: null, focoX: 0.4, focoY: 0.6 });
  });
});

describe('montarPeca — peça sem cor nenhuma no ar sai da vitrine', () => {
  it('escondida a ÚNICA cor, a peça inteira fica fora do site', () => {
    const p = montar(
      [linha()],
      [foto('CHOCOLATE', 'chocolate.jpg')],
      [{ marca: 'SEM MARCA', cores: [{ cor: 'CHOCOLATE', statusPublicacao: 'nao_publicar' }] }],
    );
    expect(p.cores).toHaveLength(0);
    expect(p.foraDoSite).toBe(true);
  });

  it('sobrando uma cor à venda, a peça continua no site', () => {
    const p = montar(
      [linha(), linha({ codigo: '1002', cor: 'PRETO', estoque: 49 })],
      [foto('CHOCOLATE', 'chocolate.jpg'), foto('PRETO', 'preto.jpg')],
      [{ marca: 'SEM MARCA', cores: [{ cor: 'CHOCOLATE', statusPublicacao: 'nao_publicar' }] }],
    );
    expect(p.foraDoSite).toBe(false);
  });

  it('ESGOTADO não vira "fora do site" na montagem — quem corta é a vitrine', () => {
    // `foraDoSite` continua reservado pra decisão HUMANA: esgotado sai da
    // vitrine pelo filtro de `disponivel` (dono, 19/08) e volta sozinho quando
    // repõe — sem precisar de republicação.
    const p = montar([linha({ estoque: 4 })], [foto('CHOCOLATE', 'chocolate.jpg')]);
    expect(p.cores).toHaveLength(0);
    expect(p.disponivel).toBe(false);
    expect(p.foraDoSite).toBe(false);
  });
});

describe('catalogoDaVitrine — esgotado sai da vitrine (dono, 19/08)', () => {
  const pecas = [
    { ref: 'A1', disponivel: true, foraDoSite: false },
    { ref: 'B2', disponivel: false, foraDoSite: false }, // esgotada
    { ref: 'C3', disponivel: true, foraDoSite: true },   // tirada à mão
  ];

  beforeEach(() => {
    svc.cacheCatalogo = { at: Date.now(), pecas };
    delete process.env.SITE_MOSTRA_ESGOTADO;
  });

  it('corta esgotado E fora-do-site da vitrine', async () => {
    const v = await svc.catalogoDaVitrine();
    expect(v.map((p: any) => p.ref)).toEqual(['A1']);
  });

  it('o feed do Meta continua vendo o esgotado (incluirEsgotado)', async () => {
    const v = await svc.catalogoDaVitrine({ incluirEsgotado: true });
    expect(v.map((p: any) => p.ref)).toEqual(['A1', 'B2']);
  });

  it('SITE_MOSTRA_ESGOTADO=1 volta o comportamento antigo sem deploy', async () => {
    process.env.SITE_MOSTRA_ESGOTADO = '1';
    const v = await svc.catalogoDaVitrine();
    expect(v.map((p: any) => p.ref)).toEqual(['A1', 'B2']);
    delete process.env.SITE_MOSTRA_ESGOTADO;
  });
});
