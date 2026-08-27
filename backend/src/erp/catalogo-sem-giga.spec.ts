import { ErpService } from './erp.service';

/**
 * CATÁLOGO SEM O ERP LEGADO (27/08/2026).
 *
 * A KingHost encerra o servidor do Giga. `searchProductsLike` e `searchByRef`
 * devolviam `[]` quando o MySQL falhava — a vendedora lia isso como "essa peça
 * não existe". As 354.309 peças estão na `product` do Postgres; a busca passa
 * a sair de lá, com o MESMO shape (chaves em MAIÚSCULA) que as telas esperam.
 */
describe('Busca de catálogo com o Giga fora', () => {
  const PECAS = [
    { codigo: '5395316', ref: '7032', cor: 'PRETO', tamanho: '50', descricaoCompleta: 'BLUSA FEMININA MANGA CURTA PLUS SIZE 7032 PRETO 50', vendaUn: 79.9, ean: null },
    { codigo: '5383085', ref: '900892', cor: 'MARINHO', tamanho: '46', descricaoCompleta: 'VESTIDO MANGA CURTA PLUS SIZE 900892 MARINHO 46', vendaUn: 119.9, ean: null },
    { codigo: '8000000010711', ref: '138818', cor: 'LISTRA MARINHO', tamanho: '50', descricaoCompleta: 'BLUSA FEMININA MANGA CURTA PLUS SIZE 138818 LISTRA MARINHO 50', vendaUn: 89.9, ean: '8000000010711' },
  ];

  /** Prisma de mentira que entende o `where` que o serviço monta. */
  const fakePrisma = () => ({
    product: {
      findMany: jest.fn(async ({ where }: any) => {
        return PECAS.filter((p) => {
          if (where.ref?.startsWith) return String(p.ref).startsWith(where.ref.startsWith);
          if (typeof where.ref === 'string') return p.ref === where.ref;
          if (where.codigo?.in) return where.codigo.in.includes(p.codigo);
          if (where.OR) {
            return where.OR.some((o: any) =>
              (o.codigo?.in && o.codigo.in.includes(p.codigo)) ||
              (typeof o.ref === 'string' && p.ref === o.ref) ||
              (o.ref?.startsWith && String(p.ref).startsWith(o.ref.startsWith)),
            );
          }
          if (where.AND) {
            return where.AND.every((a: any) =>
              String(p.descricaoCompleta).toUpperCase().includes(String(a.descricaoCompleta.contains).toUpperCase()),
            );
          }
          return false;
        });
      }),
    },
  });

  /** Serviço com o MySQL FORA — o estado real a partir de amanhã. */
  const semGiga = () => {
    const prismaFlow: any = fakePrisma();
    const svc: any = new ErpService(prismaFlow, {} as any, {} as any);
    svc.prismaFlow = prismaFlow;
    svc.pool = null;
    svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return svc;
  };

  it('busca por REF traz a peça do Postgres, com as chaves que a tela espera', async () => {
    const svc = semGiga();
    const r = await svc.searchByRef('7032');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ CODIGO: '5395316', REF: '7032', COR: 'PRETO', TAMANHO: '50' });
    expect(r[0].DESCRICAOCOMPLETA).toContain('PLUS SIZE');
  });

  it('busca por texto acha com as palavras em qualquer ordem', async () => {
    const svc = semGiga();
    const r = await svc.searchProductsLike('vestido plus marinho');
    expect(r.map((x: any) => x.CODIGO)).toEqual(['5383085']);
  });

  it('busca numérica casa CÓDIGO da etiqueta, não só REF', async () => {
    const svc = semGiga();
    const r = await svc.searchProductsLike('5395316');
    expect(r[0].CODIGO).toBe('5395316');
  });

  it('não acha nada = lista vazia, sem estourar', async () => {
    const svc = semGiga();
    await expect(svc.searchProductsLike('xyzabc')).resolves.toEqual([]);
    await expect(svc.searchByRef('000000')).resolves.toEqual([]);
  });

  it('EAN das peças: o próprio código, resolvido no Flow', async () => {
    const svc = semGiga();
    const mapa = await svc.getEansBySkus(['5395316', '5383085', '8000000010711']);
    // prefixo 8 resolve sozinho; os outros dois vêm do catálogo do Flow.
    expect(mapa['8000000010711']).toBe('8000000010711');
    expect(mapa['5395316']).toBe('5395316');
    expect(mapa['5383085']).toBe('5383085');
  });

  it('SKU que não existe no catálogo NÃO vira EAN inventado', async () => {
    const svc = semGiga();
    const mapa = await svc.getEansBySkus(['9999999']);
    expect(mapa['9999999']).toBeUndefined();
  });
});
