import { LojaCatalogService } from './loja-catalog.service';
import { eventLoopStub } from './event-loop.stub';

/**
 * GRADE FURADA NA VITRINE (ordem do dono, 13/09/2026).
 *
 * "Mais do que 2 numerações zeradas sai do site, e volta quando a reposição
 * chegar." Aqui se prova o encaixe com as regras vizinhas, que é onde dá
 * errado: a cor furada some como as outras escondidas, mas NÃO pode virar
 * `foraDoSite` — esse carimbo é só pro que uma pessoa mandou sair, e é ele
 * que impediria a peça de voltar sozinha.
 */

const svc = new LojaCatalogService({} as any, {} as any, eventLoopStub) as any;

const GRADE = [46, 48, 50, 52, 54, 56, 58, 60];

/** Uma cor inteira: 8 linhas, uma por número, com o estoque de cada. */
const cor = (nome: string, estoques: number[]) =>
  GRADE.map((tam, i) => ({
    ref: '206922', codigo: `${nome}-${tam}`, cor: nome, tamanho: String(tam),
    marca: 'MARRIE', categoria: 'BLUSAS', descricao: 'BLUSA MANGA CURTA',
    preco: 89.9, custo: null, ean: null, ncm: null, cst: null,
    estoque: estoques[i], dataAlt: new Date('2026-09-01'),
  }));

const foto = (c: string) => ({ ref: '206922', cor: c, url: `${c}.jpg`, ordem: 0 });

const montar = (linhas: any[], fotos: any[]) =>
  svc.montarPeca('206922', linhas, null, null, fotos, undefined, 0, [], null);

const CHEIA = [5, 3, 8, 2, 9, 4, 6, 7];        // 44 peças, grade cheia
const DOIS_BURACOS = [5, 0, 8, 2, 0, 4, 6, 7]; // 32 peças, falta 48 e 54
const TRES_BURACOS = [0, 0, 0, 2, 12, 15, 23, 25]; // o caso real: sem 46/48/50

describe('grade furada — mais de 2 numerações zeradas tira a cor da vitrine', () => {
  afterEach(() => {
    delete process.env.SITE_GRADE_FURADA;
    delete process.env.SITE_MAX_TAM_ZERADOS;
  });

  it('2 buracos NÃO tiram a cor — o limite é "mais do que 2"', () => {
    const p = montar(cor('PRETO', DOIS_BURACOS), [foto('PRETO')]);
    expect(p.cores.map((c: any) => c.nome)).toEqual(['PRETO']);
    expect(p.disponivel).toBe(true);
  });

  it('3 buracos escondem a cor e dizem quais números faltam', () => {
    const p = montar(cor('PRETO', TRES_BURACOS), [foto('PRETO')]);
    expect(p.cores).toEqual([]);
    expect(p.coresOcultas).toEqual([
      expect.objectContaining({
        nome: 'PRETO', motivo: 'grade_furada', faltando: ['46', '48', '50'],
      }),
    ]);
  });

  it('peça de cor única furada SAI da vitrine — sem virar "fora do site"', () => {
    const p = montar(cor('PRETO', TRES_BURACOS), [foto('PRETO')]);
    // `disponivel:false` é o que `catalogoDaVitrine` corta — o MESMO caminho do
    // esgotado, que devolve a peça sozinha quando a reposição entrar.
    expect(p.disponivel).toBe(false);
    expect(p.estoqueTotal).toBe(0);
    // 🚨 `foraDoSite` é carimbo de decisão HUMANA. Se a grade furada o ligasse,
    // a peça precisaria de republicação manual pra voltar — o oposto do pedido.
    expect(p.foraDoSite).toBe(false);
  });

  it('a cor de grade cheia segura a peça no ar, e a grade exibida é só dela', () => {
    const p = montar(
      [...cor('PRETO', TRES_BURACOS), ...cor('VERMELHO', CHEIA)],
      [foto('PRETO'), foto('VERMELHO')],
    );
    expect(p.cores.map((c: any) => c.nome)).toEqual(['VERMELHO']);
    expect(p.disponivel).toBe(true);
    // O total e a grade mostrados têm que ser o que dá pra COMPRAR: contar a
    // cor escondida é a mentira da VOGUE (570 anunciadas, 178 compráveis).
    expect(p.estoqueTotal).toBe(44);
    expect(p.tamanhos.every((t: any) => t.disponivel)).toBe(true);
  });

  it('cor ZERADA inteira continua saindo como esgotada, não como grade furada', () => {
    const p = montar(
      [...cor('PRETO', [0, 0, 0, 0, 0, 0, 0, 0]), ...cor('VERMELHO', CHEIA)],
      [foto('PRETO'), foto('VERMELHO')],
    );
    expect(p.cores.map((c: any) => c.nome)).toEqual(['VERMELHO']);
    expect(p.coresOcultas.find((c: any) => c.nome === 'PRETO')).toBeUndefined();
  });

  it('o piso de 10 peças por cor decide ANTES — o motivo tem que ser o certo', () => {
    // 9 peças espalhadas e 3 buracos: as duas regras pegariam. Quem responde é
    // o piso, senão a tela de cores mandaria repor número numa cor que sai de
    // qualquer jeito por estoque.
    const p = montar(cor('PRETO', [0, 0, 0, 2, 2, 2, 2, 1]), [foto('PRETO')]);
    expect(p.coresOcultas).toEqual([
      expect.objectContaining({ nome: 'PRETO', motivo: 'estoque_baixo' }),
    ]);
  });

  it('SITE_GRADE_FURADA=0 devolve a cor ao ar sem deploy', () => {
    process.env.SITE_GRADE_FURADA = '0';
    const p = montar(cor('PRETO', TRES_BURACOS), [foto('PRETO')]);
    expect(p.cores.map((c: any) => c.nome)).toEqual(['PRETO']);
    expect(p.disponivel).toBe(true);
  });
});
