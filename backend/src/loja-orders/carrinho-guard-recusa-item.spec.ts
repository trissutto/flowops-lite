import { CarrinhoGuardService } from './carrinho-guard.service';

/**
 * TODA RECUSA QUE FALA DE UMA PEÇA DIZ QUAL PEÇA É (12/09).
 *
 * O site trata sete recusas de `catalog_unavailable`, e a saída boa — o botão
 * "Tirar da sacola e continuar", dentro do checkout — só aparece quando a
 * resposta traz `item`. Sem ele a cliente cai no link pra FORA do checkout, e
 * a sacola dela continua com a peça que o guard acabou de negar.
 *
 * Medido na semana de 05 a 11/09: a REF 170359 levou 9 tentativas de pagar da
 * MESMA pessoa, nenhuma recuperada — `sku_inexistente` não mandava `item`.
 *
 * A armadilha que este arquivo tranca é a do OUTRO lado: `precoAtual` é o que
 * a sacola passa a mostrar. Nas recusas que não são de preço ele tem que ser
 * IGUAL ao informado (o site não mexe na linha, só oferece tirar); na recusa
 * por preço ele tem que ser o do CATÁLOGO, senão o conserto automático morre.
 * Mandar o preço do catálogo em `preco_zerado` carimbaria R$ 0,00 na sacola.
 */
describe('CarrinhoGuardService — recusa que diz qual peça é', () => {
  const linha = (over: any = {}) => ({
    ref: 'VLM-222',
    codigo: '8912345678901',
    cor: 'PRETO',
    tamanho: '52',
    preco: 189.9,
    estoque: 5,
    ...over,
  });

  /**
   * O guard só fala com o banco por SQL cru (catálogo e reserva) e pelo
   * `siteProduto` (publicação). Distinguimos as duas consultas cruas pelo
   * texto: quem lê `wincred_produtos` é o catálogo, o resto é reserva.
   */
  const prismaMock = (linhas: any[], over: any = {}) => ({
    $queryRawUnsafe: jest.fn(async (sql: string) =>
      String(sql).includes('wincred_produtos') ? linhas : [],
    ),
    siteProduto: {
      findMany: jest.fn().mockResolvedValue(over.despublicadas ?? []),
    },
  });

  const promoMock = () => ({
    porChaves: jest.fn().mockResolvedValue(new Map()),
    precoComDesconto: (p: number) => p / 2,
  });

  const guard = (linhas: any[], over: any = {}) =>
    new CarrinhoGuardService(prismaMock(linhas, over) as any, promoMock() as any);

  const sacola = (over: any = {}) => [
    {
      sku: 'VLM-222',
      productId: 'vlm-222',
      name: 'Vestido Midi',
      size: '52',
      color: 'PRETO',
      quantity: 1,
      unitPrice: 189.9,
      ...over,
    },
  ];

  it('sku que sumiu do catálogo diz qual linha tirar — e não mexe no preço', async () => {
    // Catálogo vazio: é a REF 170359 do incidente.
    const r: any = await guard([]).conferir(sacola({ sku: '170359', productId: '170359' }));

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('sku_inexistente');
    expect(r.item).toBeDefined();
    expect(r.item.productId).toBe('170359');
    expect(r.item.size).toBe('52');
    expect(r.item.color).toBe('PRETO');
    // Igual = o site não reescreve a linha, só oferece o botão.
    expect(r.item.precoAtual).toBe(r.item.precoInformado);
  });

  it('peça despublicada durante a compra diz qual linha tirar', async () => {
    const r: any = await guard([linha()], {
      despublicadas: [{ ref: 'VLM-222' }],
    }).conferir(sacola());

    expect(r.motivo).toBe('despublicada');
    expect(r.item?.productId).toBe('vlm-222');
    expect(r.item.precoAtual).toBe(r.item.precoInformado);
  });

  it('cor que sumiu diz qual linha tirar', async () => {
    const r: any = await guard([linha({ cor: 'MARINHO' })]).conferir(sacola());

    expect(r.motivo).toBe('sem_cor');
    expect(r.item?.color).toBe('PRETO');
  });

  it('tamanho que sumiu diz qual linha tirar', async () => {
    const r: any = await guard([linha({ tamanho: '46' })]).conferir(sacola());

    expect(r.motivo).toBe('sem_tamanho');
    expect(r.item?.size).toBe('52');
  });

  it('preço zerado no cadastro NÃO carimba R$ 0,00 na sacola', async () => {
    const r: any = await guard([linha({ preco: 0 })]).conferir(sacola());

    expect(r.motivo).toBe('preco_zerado');
    expect(r.item).toBeDefined();
    expect(r.item.precoAtual).toBe(189.9);
    expect(r.item.precoAtual).not.toBe(0);
  });

  it('esgotou continua dizendo qual peça é (não regredir)', async () => {
    const r: any = await guard([linha({ estoque: 0 })]).conferir(sacola());

    expect(r.motivo).toBe('esgotou');
    expect(r.item?.productId).toBe('vlm-222');
  });

  it('preço que SUBIU manda o preço do CATÁLOGO — é o conserto automático', async () => {
    const r: any = await guard([linha({ preco: 219.9 })]).conferir(sacola());

    expect(r.motivo).toBe('preco_subiu');
    expect(r.item.precoAtual).toBe(219.9);
    expect(r.item.precoInformado).toBe(189.9);
  });
});
