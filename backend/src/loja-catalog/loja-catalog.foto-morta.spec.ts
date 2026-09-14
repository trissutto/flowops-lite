import { LojaCatalogService } from './loja-catalog.service';
import { eventLoopStub } from './event-loop.stub';

/**
 * FOTO DO WORDPRESS APAGADO NÃO É FOTO (14/09/2026).
 *
 * `montarPeca` cai no acervo que veio do WooCommerce (`site_produto.imagens`)
 * quando a peça não tem foto própria no R2. Esse acervo virou link morto em
 * 27/08, quando a KingHost apagou o WordPress — a Vercel responde 403 em
 * `/wp-content/` antes de chegar em rota nenhuma.
 *
 * Resultado medido na produção antes do conserto: **48 peças publicadas** com
 * a galeria inteira quebrada, servida nos dois lugares que importam — os 48
 * `<g:image_link>` do feed do Google e do Meta (mais 152 fotos extras) e o
 * HTML da PDP, que entregava a mesma URL pra cliente.
 *
 * O que estes testes travam:
 *  - a foto morta sai, e a próxima VÁLIDA vira capa;
 *  - galeria 100% morta deixa a peça SEM `imagens` — é assim que ela sai da
 *    vitrine e do feed (`montarCatalogo` corta peça sem foto);
 *  - o descarte é CONTADO (`fotosMortasDescartadas`), pra o aviso do catálogo
 *    saber diferenciar "nunca foi fotografada" de "perdeu o servidor".
 */

const svc = new LojaCatalogService({} as any, {} as any, eventLoopStub) as any;

const WP = 'https://lurds.com.br/wp-content/uploads/2026/03/700906-CHUMBO-4-1.avif';
const WP2 = 'https://lurds.com.br/wp-content/uploads/2026/03/700906-CHUMBO-5-1.avif';
const R2 = 'https://pub-84da472609374e0ab161fd54571b5f38.r2.dev/produtos/700906/CHUMBO/1.jpg';

const linha = (over: Partial<any> = {}) => ({
  ref: '700906', codigo: '1001', cor: 'CHUMBO', tamanho: '46', marca: 'MARRIE',
  categoria: 'BLUSAS', descricao: 'BLUSA MANGA CURTA',
  preco: 129.9, custo: null, ean: null, ncm: null, cst: null,
  estoque: 30, dataAlt: new Date('2026-08-14'),
  ...over,
});

const foto = (cor: string | null, url: string) => ({ ref: '700906', cor, url, ordem: 0 });

const montar = (fotos: any[], site: any = null) =>
  svc.montarPeca('700906', [linha()], site, null, fotos, undefined, 0, [], null);

const srcs = (p: any) => p.imagens.map((i: any) => i.src);

describe('montarPeca — a galeria do WordPress apagado', () => {
  it('acervo do WC 100% morto deixa a peça SEM foto — é o caso das 48', () => {
    const p = montar([], { nome: 'Blusa', imagens: [{ src: WP }, { src: WP2 }] });
    expect(srcs(p)).toEqual([]);
    // O número é o que o aviso do catálogo usa pra dizer que FALTA FOTO NOVA.
    expect(p.fotosMortasDescartadas).toBe(2);
  });

  it('descarta a capa morta e PROMOVE a próxima válida do acervo', () => {
    const viva = 'https://pub-84da472609374e0ab161fd54571b5f38.r2.dev/legado/700906.jpg';
    const p = montar([], { nome: 'Blusa', imagens: [{ src: WP }, { src: viva }] });
    expect(srcs(p)).toEqual([viva]);
    expect(p.fotosMortasDescartadas).toBe(1);
  });

  it('foto do R2 no `product_photos` continua intacta — é o acervo VIVO', () => {
    const p = montar([foto('CHUMBO', R2)]);
    expect(srcs(p)).toEqual([R2]);
    expect(p.fotosMortasDescartadas).toBe(0);
  });

  it('linha morta dentro do R2 também sai, e não leva a cor com ela', () => {
    // Guarda: hoje `product_photos` não tem nenhuma linha de /wp-content/,
    // mas se um import antigo gravasse uma, ela mandaria na bolinha e na capa.
    const p = montar([foto('CHUMBO', WP), foto('CHUMBO', R2)]);
    expect(srcs(p)).toEqual([R2]);
    expect(p.cores.map((c: any) => c.nome)).toEqual(['CHUMBO']);
    expect(p.fotosMortasDescartadas).toBe(1);
  });

  it('cor cuja galeria era toda do WP perde a bolinha — não abre galeria vazia', () => {
    const p = svc.montarPeca(
      '700906',
      [linha(), linha({ codigo: '1002', cor: 'VINHO', estoque: 40 })],
      null, null,
      [foto('CHUMBO', R2), foto('VINHO', WP)],
      undefined, 0, [], null,
    );
    expect(p.cores.map((c: any) => c.nome)).toEqual(['CHUMBO']);
    expect(srcs(p)).toEqual([R2]);
  });

  it('peça sem foto em lugar nenhum não é reportada como acervo morto', () => {
    const p = montar([], { nome: 'Blusa', imagens: [] });
    expect(srcs(p)).toEqual([]);
    // Zero = nunca foi fotografada. O aviso do catálogo não pede foto NOVA
    // pra ela pelo motivo errado.
    expect(p.fotosMortasDescartadas).toBe(0);
  });
});
