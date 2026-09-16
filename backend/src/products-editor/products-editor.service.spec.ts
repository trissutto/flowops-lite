import { ProductsEditorService } from './products-editor.service';

jest.mock('../common/avisar-vitrine', () => ({ avisarVitrine: jest.fn() }));
// Os três só entram como token de injeção: carregar os módulos reais arrastaria
// o ErpService inteiro (mysql2 incluso) pra dentro do teste.
jest.mock('../erp/erp.service', () => ({ ErpService: class {} }));
jest.mock('../product-search/product-search.service', () => ({ ProductSearchService: class {} }));
jest.mock('../loja-catalog/loja-catalog.service', () => ({ LojaCatalogService: class {} }));

function montar() {
  const prisma = {
    gigaProduto: {
      findMany: jest.fn().mockResolvedValue([
        { codigo: '5190430', ref: '207282', descricao: 'SAIA MID PLUS SIZE COURO 207282 MARRIE ESTAMPA PRETO 56', cor: 'ESTAMPA PRETO', tamanho: '56', vendaUn: 219.9 },
      ]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    product: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    wincredProduto: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    productEditAudit: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const erp = { updateProdutosCampos: jest.fn().mockResolvedValue({ atualizados: 0 }) };
  const catalogo = { invalidarCache: jest.fn() };
  const svc = new ProductsEditorService(prisma as any, erp as any, {} as any, catalogo as any);
  return { svc, prisma };
}

const dadosDoEspelho = (prisma: ReturnType<typeof montar>['prisma']) =>
  prisma.gigaProduto.updateMany.mock.calls.map((c: any[]) => c[0].data);

describe('ProductsEditorService.apply — REF renomeada leva a REF-BASE junto', () => {
  const envOriginal = process.env;
  beforeEach(() => {
    process.env = { ...envOriginal };
    delete process.env.EDITOR_PRODUTOS_WRITE;
    delete process.env.PRODUCT_NATIVE_WRITES;
  });
  afterAll(() => {
    process.env = envOriginal;
  });

  it('grava ref_base no giga_produto: a grade da live abre a família por ela', async () => {
    const { svc, prisma } = montar();
    await svc.apply({ edits: [{ codigo: '5190430', changes: { ref: '207279', cor: 'PRETO' } }], userName: 'teste' });

    expect(prisma.gigaProduto.updateMany).toHaveBeenCalledWith({
      where: { codigo: { in: ['5190430'] } },
      data: expect.objectContaining({ ref: '207279', refBase: '207279', cor: 'PRETO' }),
    });
  });

  it('REF com sufixo de cor grava a base sem o sufixo (mesma régua do refBaseOf)', async () => {
    const { svc, prisma } = montar();
    await svc.apply({ edits: [{ codigo: '5190430', changes: { ref: 'vms-223 ma' } }] });

    expect(dadosDoEspelho(prisma)).toEqual([{ ref: 'VMS-223 MA', refBase: 'VMS-223' }]);
  });

  it('edição sem REF não mexe na REF-BASE', async () => {
    const { svc, prisma } = montar();
    await svc.apply({ edits: [{ codigo: '5190430', changes: { preco: 199.9 } }] });

    expect(dadosDoEspelho(prisma)).toEqual([{ vendaUn: 199.9 }]);
  });
});
