import { FotoProdutoService } from './foto-produto.service';

/**
 * A MINIATURA DO CARRINHO DO PDV SEM WOOCOMMERCE (14/09/2026).
 *
 * `GET /pdv/product-images` pedia a foto por SKU pro WordPress
 * (`WC_URL/wp-json/wc/v3/products?sku=X`). Ele foi apagado em 27/08/2026 e o
 * endereço hoje responde 403 pela Vercel — e o método antigo ENGOLIA o erro,
 * cacheava `null` por 1h e devolvia "sem foto". Em produção toda peça do
 * carrinho virou a bolinha com a inicial da REF, calada.
 *
 * A foto agora sai de `product_photos` (Postgres + R2), a mesma fonte da
 * Consulta, da Separação, do Realinhamento e do site. Este teste trava as
 * quatro coisas que não podem regredir: a foto volta, a COR manda, a
 * REF-BASE é procurada, e miss ≠ erro.
 */
describe('Miniatura do carrinho do PDV — foto do Postgres', () => {
  /** Cadastro: dois números da MESMA peça em cores diferentes + uma sem foto. */
  const PRODUTOS = [
    { codigo: '5395316', ref: 'VMS-223 MA', cor: 'MARINHO' },
    { codigo: '5395317', ref: 'VMS-223 P', cor: 'PRETO' },
    { codigo: '7777777', ref: '9001', cor: 'BEGE' },
    // Peça sem cor no cadastro — só ela aceita foto genérica da família.
    { codigo: '8888888', ref: '9002', cor: null },
  ];

  /** Acervo: a galeria ficou gravada na REF-BASE ("VMS-223"), como hoje. */
  const FOTOS = [
    { ref: 'VMS-223', cor: 'MARINHO', ordem: 0, url: 'https://r2/vms223-marinho-capa.jpg' },
    { ref: 'VMS-223', cor: 'MARINHO', ordem: 1, url: 'https://r2/vms223-marinho-2.jpg' },
    { ref: 'VMS-223', cor: 'PRETO', ordem: 0, url: 'https://r2/vms223-preto-capa.jpg' },
    { ref: '9002', cor: 'VERDE', ordem: 0, url: 'https://r2/9002-verde.jpg' },
  ];

  const fakePrisma = () => ({
    product: {
      findMany: jest.fn(async ({ where }: any) =>
        PRODUTOS.filter((p) => where.codigo.in.includes(p.codigo)),
      ),
    },
    // O espelho concorda com a nativa neste cenário (o serviço lê os dois e a
    // nativa ganha) — o que importa aqui é que nenhuma chamada seja HTTP.
    wincredProduto: {
      findMany: jest.fn(async ({ where }: any) =>
        PRODUTOS.filter((p) => where.codigo.in.includes(p.codigo)),
      ),
    },
    productPhoto: {
      findMany: jest.fn(async ({ where }: any) =>
        FOTOS.filter((f) => where.ref.in.includes(f.ref)).sort((a, b) => a.ordem - b.ordem),
      ),
    },
  });

  const servico = (prisma: any = fakePrisma()) => new FotoProdutoService(prisma as any);

  it('devolve a capa da COR de cada peça do carrinho — sem tocar em HTTP', async () => {
    const prisma = fakePrisma();
    const urls = await servico(prisma).capaPorSku(['5395316', '5395317']);
    expect(urls['5395316']).toBe('https://r2/vms223-marinho-capa.jpg');
    expect(urls['5395317']).toBe('https://r2/vms223-preto-capa.jpg');
    // Uma consulta só de fotos pro carrinho inteiro (era 1 request por peça).
    expect(prisma.productPhoto.findMany).toHaveBeenCalledTimes(1);
  });

  it('acha a foto gravada na REF-BASE quando o cadastro tem REF com sufixo de cor', async () => {
    const prisma = fakePrisma();
    await servico(prisma).capaPorSku(['5395316']);
    const refsBuscadas = prisma.productPhoto.findMany.mock.calls[0][0].where.ref.in;
    expect(refsBuscadas).toContain('VMS-223'); // a base
    expect(refsBuscadas).toContain('VMS-223 MA'); // e a REF como veio
  });

  it('peça com COR conhecida NUNCA herda a foto de outra cor', async () => {
    // 9001/BEGE não tem foto nenhuma. Se a cascata caísse pra "qualquer foto
    // da família", a vendedora conferiria a peça pela imagem errada.
    const urls = await servico().capaPorSku(['7777777']);
    expect(urls['7777777']).toBeNull();
  });

  it('peça SEM cor no cadastro aceita qualquer foto da família', async () => {
    const urls = await servico().capaPorSku(['8888888']);
    expect(urls['8888888']).toBe('https://r2/9002-verde.jpg');
  });

  it('SKU com zeros à esquerda resolve (normalização do espelho)', async () => {
    const urls = await servico().capaPorSku(['0005395316']);
    expect(urls['0005395316']).toBe('https://r2/vms223-marinho-capa.jpg');
  });

  it('miss é RESPOSTA: o SKU pedido volta com null explícito, nunca chave faltando', async () => {
    const urls = await servico().capaPorSku(['5395316', '9999999', 'abc']);
    expect(Object.keys(urls).sort()).toEqual(['5395316', '9999999', 'abc']);
    expect(urls['9999999']).toBeNull();
    expect(urls['abc']).toBeNull();
  });

  it('erro do banco SOBE — nada de catch devolvendo mapa vazio', async () => {
    const prisma: any = fakePrisma();
    prisma.productPhoto.findMany = jest.fn(async () => {
      throw new Error('connection terminated');
    });
    await expect(servico(prisma).capaPorSku(['5395316'])).rejects.toThrow(
      'connection terminated',
    );
  });
});
