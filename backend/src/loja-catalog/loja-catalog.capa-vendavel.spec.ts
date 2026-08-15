import { LojaCatalogService } from './loja-catalog.service';

/**
 * A CAPA DO CARD É DA COR QUE DÁ PRA COMPRAR (15/08/2026).
 *
 * A galeria chega ordenada por COR e a capa era a primeira — alfabética. Cor
 * escondida que abre o alfabeto virava a vitrine inteira: a VLM-222 (lisa,
 * R$ 139,90) anunciava o vestido ESTAMPADO, que é outra REF (`VLM222EST`,
 * R$ 199,90) e nem sequer é vendido nessa página. 35 dos 721 cards no ar
 * estavam assim no dia da medição.
 */

const svc = new LojaCatalogService({} as any, {} as any) as any;

const linha = (over: Partial<any> = {}) => ({
  ref: 'VLM-222', codigo: '1001', cor: 'PRETO', tamanho: '46', marca: 'MARRIE',
  categoria: 'VESTIDOS', descricao: 'VESTIDO LONGO MANGA CURTA',
  preco: 139.9, custo: null, ean: null, ncm: null, cst: null,
  // Acima do piso por cor (10) — senão a cor some da peça.
  estoque: 30, dataAlt: new Date('2026-08-14'),
  ...over,
});

const foto = (cor: string | null, url: string) => ({ ref: 'VLM-222', cor, url, ordem: 0 });

const montar = (linhas: any[], fotos: any[], fichas: any[] = []) =>
  svc.montarPeca('VLM-222', linhas, null, null, fotos, fichas[0], 0, fichas, null);

const capa = (p: any) => p.imagens[0]?.src ?? null;

describe('montarPeca — capa e galeria só das cores à venda', () => {
  it('a foto da cor que não existe no ERP não vira capa (o caso VLM-222)', () => {
    const p = montar(
      [linha()],
      // Alfabeticamente ESTAMPA vem antes de PRETO — era ela que virava capa.
      [foto('ESTAMPA MARINHO', 'estampado.jpg'), foto('PRETO', 'preto.jpg')],
    );
    expect(capa(p)).toBe('preto.jpg');
    expect(p.imagens.map((i: any) => i.src)).not.toContain('estampado.jpg');
  });

  it('cor marcada "não publicar" também não aparece na galeria', () => {
    const p = montar(
      [linha(), linha({ codigo: '1002', cor: 'MARINHO', estoque: 180 })],
      [foto('MARINHO', 'marinho.jpg'), foto('PRETO', 'preto.jpg')],
      [{ cores: [{ cor: 'MARINHO', statusPublicacao: 'nao_publicar' }] }],
    );
    expect(capa(p)).toBe('preto.jpg');
    expect(p.imagens).toHaveLength(1);
  });

  it('cor abaixo do piso de estoque some da galeria junto com a bolinha', () => {
    const p = montar(
      [linha(), linha({ codigo: '1002', cor: 'LARANJA', estoque: 4 })],
      [foto('LARANJA', 'laranja.jpg'), foto('PRETO', 'preto.jpg')],
    );
    expect(p.cores.map((c: any) => c.nome)).toEqual(['PRETO']);
    expect(capa(p)).toBe('preto.jpg');
  });

  it('foto sem cor fica: ela não promete cor nenhuma', () => {
    const p = montar([linha()], [foto(null, 'detalhe.jpg'), foto('PRETO', 'preto.jpg')]);
    expect(p.imagens.map((i: any) => i.src)).toEqual(['detalhe.jpg', 'preto.jpg']);
  });

  it('galeria inteira de cor escondida mantém o acervo — card sem imagem some da vitrine', () => {
    const p = montar([linha()], [foto('ESTAMPA MARINHO', 'estampado.jpg')]);
    expect(capa(p)).toBe('estampado.jpg');
  });

  it('peça sem cor cadastrada no ERP não perde foto nenhuma', () => {
    const p = montar([linha({ cor: null })], [foto('QUALQUER', 'a.jpg')]);
    expect(capa(p)).toBe('a.jpg');
  });
});
