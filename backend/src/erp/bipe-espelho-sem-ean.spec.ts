import { ErpService } from './erp.service';

/**
 * BIPE DA LOJA SEM O GIGA (27/08/2026).
 *
 * A guarda `mirrorEanReady()` (>100 linhas com EAN no espelho) protegia o
 * caminho INTEIRO do espelho. Como a coluna `ean` de `wincred_produtos` está
 * vazia — 0 de 354.309 peças —, todo bipe ia pro MySQL do Giga, inclusive o
 * que o espelho resolveria pelo CODIGO (que é o que a etiqueta da casa
 * carrega). Com a KingHost recusando o IP do Railway, a loja bipava e o
 * sistema dizia que a peça não existe.
 */
describe('findSkuByAnyEan — espelho resolve pelo CODIGO mesmo sem EAN', () => {
  const montar = (opts: { produtos: any[]; comEan: number; gigaVivo?: boolean }) => {
    const prismaFlow: any = {
      wincredProduto: {
        findFirst: jest.fn(async ({ where }: any) => {
          if (where.codigo?.in) {
            return opts.produtos.find((p) => where.codigo.in.includes(p.codigo)) ?? null;
          }
          if (where.ean?.in) {
            return opts.produtos.find((p) => p.ean && where.ean.in.includes(p.ean)) ?? null;
          }
          return null;
        }),
        count: jest.fn(async () => opts.comEan),
      },
    };
    const svc: any = new ErpService(prismaFlow, {} as any, {} as any);
    svc.prismaFlow = prismaFlow;
    // Espelho ligado; Giga fora (é o estado real de hoje) salvo indicação.
    Object.defineProperty(svc, 'mirrorReadsEnabled', { get: () => true });
    svc.pool = opts.gigaVivo
      ? { query: jest.fn(async () => [[{ CODIGO: 'DO-GIGA' }]]) }
      : null;
    svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return svc;
  };

  it('bipe do CODIGO da etiqueta resolve no espelho com a coluna ean VAZIA', async () => {
    const svc = montar({ produtos: [{ codigo: '5395316', ean: null }], comEan: 0 });
    await expect(svc.findSkuByAnyEan('5395316')).resolves.toBe('5395316');
    // Não perguntou "o espelho tem EAN?" — a busca por código não depende disso.
    expect(svc.prismaFlow.wincredProduto.count).not.toHaveBeenCalled();
  });

  it('código com zeros à esquerda na etiqueta também resolve', async () => {
    const svc = montar({ produtos: [{ codigo: '5395316', ean: null }], comEan: 0 });
    await expect(svc.findSkuByAnyEan('0005395316')).resolves.toBe('5395316');
  });

  it('EAN gerado pelo Flow (prefixo 8) resolve sem banco nenhum', async () => {
    const svc = montar({ produtos: [], comEan: 0 });
    await expect(svc.findSkuByAnyEan('8000000003652')).resolves.toBe('8000000003652');
  });

  it('sem achar no espelho e com o Giga FORA, devolve null em vez de estourar', async () => {
    const svc = montar({ produtos: [], comEan: 0 });
    await expect(svc.findSkuByAnyEan('9999999')).resolves.toBeNull();
  });

  it('quando o espelho TIVER EAN, a coluna ean volta a ser consultada', async () => {
    const svc = montar({ produtos: [{ codigo: '7788', ean: '7891234567895' }], comEan: 5000 });
    await expect(svc.findSkuByAnyEan('7891234567895')).resolves.toBe('7788');
    expect(svc.prismaFlow.wincredProduto.count).toHaveBeenCalled();
  });
});
