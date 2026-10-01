import { ProductsEditorService } from './products-editor.service';

jest.mock('../common/avisar-vitrine', () => ({ avisarVitrine: jest.fn() }));
jest.mock('../erp/erp.service', () => ({ ErpService: class {} }));
jest.mock('../product-search/product-search.service', () => ({ ProductSearchService: class {} }));
jest.mock('../loja-catalog/loja-catalog.service', () => ({ LojaCatalogService: class {} }));

/**
 * Prisma de mentira: cada model responde count/updateMany pelo que `linhas`
 * diz, e grava tudo que foi pedido pra conferir depois. O $transaction só
 * repassa o próprio objeto (as gravações são rastreadas em `escritas`).
 */
function montar(opts: {
  nativo?: any;
  espelho?: any;
  linhas?: Record<string, number>;
  colisaoEm?: string;
}) {
  const escritas: Array<{ model: string; args: any }> = [];
  const linhas = opts.linhas || {};
  const handler: ProxyHandler<any> = {
    get(_t, model: string) {
      if (model === '$transaction') return async (fn: any) => fn(prisma);
      if (model === 'then') return undefined;
      return {
        findUnique: jest.fn(async () =>
          model === 'product' ? opts.nativo ?? null : model === 'wincredProduto' ? opts.espelho ?? null : null),
        count: jest.fn(async ({ where }: any) => {
          const valor = Object.values(where)[0];
          // a checagem de colisão pergunta pelo código NOVO
          if (valor === 'NOVO1' || valor === '5397327') return opts.colisaoEm === model ? 1 : 0;
          return linhas[model] || 0;
        }),
        updateMany: jest.fn(async (args: any) => {
          escritas.push({ model, args });
          const col = Object.keys(args.where)[0];
          const alvo = args.where[col];
          if (alvo === 'NOVO1' || alvo === '5397327') return { count: 1 };
          return { count: linhas[model] || 0 };
        }),
        update: jest.fn(async (args: any) => { escritas.push({ model, args }); return {}; }),
        create: jest.fn(async (args: any) => { escritas.push({ model, args }); return {}; }),
      };
    },
  };
  const prisma: any = new Proxy({}, handler);
  const svc = new ProductsEditorService(prisma, {} as any, {} as any, { invalidarCache: jest.fn() } as any);
  return { svc, escritas };
}

const PECA = { codigo: '7891186984207', ref: '5716', cor: 'ROSA', tamanho: 'M', descricaoCompleta: 'MEIA CALCA', ean: null };

describe('ProductsEditorService.trocarCodigo', () => {
  it('prévia conta as linhas por tabela e NÃO grava nada', async () => {
    const { svc, escritas } = montar({ nativo: PECA, linhas: { product: 1, wincredEstoque: 3, pdvSaleItem: 12 } });
    const r: any = await svc.trocarCodigo({ de: '7891186984207', para: '5397327', executar: false });
    expect(r.previa).toBe(true);
    expect(r.totalLinhas).toBe(16);
    expect(r.tabelas.map((t: any) => t.linhas)).toEqual([1, 3, 12]);
    expect(r.guardarComoEan).toBe(true);
    expect(escritas).toHaveLength(0);
  });

  it('executar reescreve todas as tabelas com linha, guarda o antigo como EAN e audita sob o código novo', async () => {
    const { svc, escritas } = montar({ nativo: PECA, linhas: { product: 1, wincredProduto: 1, gigaEstoque: 2, orderItem: 4 } });
    const r: any = await svc.trocarCodigo({ de: '7891186984207', para: '5397327', executar: true, userName: 'thiago' });
    expect(r.previa).toBe(false);
    expect(r.totalLinhas).toBe(8);

    const renomeadas = escritas.filter((e) => e.args?.where && Object.values(e.args.where)[0] === '7891186984207');
    // toda coluna da lista é tentada (a que não tem linha devolve 0 e não entra no resultado)
    expect(renomeadas.length).toBe(31);
    for (const e of renomeadas) {
      const col = Object.keys(e.args.where)[0];
      expect(e.args.data).toEqual({ [col]: '5397327' });
    }
    expect(renomeadas.find((e) => e.model === 'gigaEstoque')!.args.data).toEqual({ codigo: '5397327' });
    expect(renomeadas.find((e) => e.model === 'orderItem')!.args.data).toEqual({ sku: '5397327' });

    const ean = escritas.filter((e) => e.args?.data?.ean === '7891186984207');
    expect(ean.map((e) => e.model).sort()).toEqual(['product', 'wincredProduto']);

    const audit = escritas.find((e) => e.model === 'productEditAudit' && e.args?.data?.field)!;
    expect(audit.args.data).toMatchObject({ codigo: '5397327', field: 'CODIGO', oldValue: '7891186984207', newValue: '5397327', userName: 'thiago' });
  });

  it('código antigo curto (não é código de barras) não vira EAN', async () => {
    const { svc } = montar({ nativo: { ...PECA, codigo: '5397310' }, linhas: { product: 1 } });
    const r: any = await svc.trocarCodigo({ de: '5397310', para: 'NOVO1', executar: false });
    expect(r.guardarComoEan).toBe(false);
  });

  it('recusa código novo que já existe em qualquer tabela de cadastro/estoque', async () => {
    const { svc } = montar({ nativo: PECA, colisaoEm: 'wincredEstoque' });
    await expect(svc.trocarCodigo({ de: '7891186984207', para: '5397327', executar: true }))
      .rejects.toThrow(/já existe/);
  });

  it('recusa código que não existe, igual ao atual e formato inválido', async () => {
    const { svc } = montar({});
    await expect(svc.trocarCodigo({ de: '1', para: '2', executar: false })).rejects.toThrow(/não existe/);
    const { svc: s2 } = montar({ nativo: PECA });
    await expect(s2.trocarCodigo({ de: '7891186984207', para: '7891186984207', executar: false })).rejects.toThrow(/igual/);
    await expect(s2.trocarCodigo({ de: '7891186984207', para: 'A B', executar: false })).rejects.toThrow(/só letras/);
    await expect(s2.trocarCodigo({ de: '7891186984207', para: '123456789012345', executar: false })).rejects.toThrow(/14/);
  });
});
