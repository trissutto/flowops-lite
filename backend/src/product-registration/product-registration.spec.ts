import { ProductRegistrationService } from './product-registration.service';

jest.mock('../erp/erp.service', () => ({ ErpService: class {} }));
jest.mock('../product-search/product-search.service', () => ({
  ProductSearchService: { refBaseOf: (r: string) => String(r || '').replace(/-.*$/, '') },
}));

/**
 * Prisma de mentira: cadastro que JÁ existe (`existentes`, por código),
 * código com estoque órfão (`comEstoque`), sequência de EAN parada em 100, e
 * tudo que foi escrito fica em `escritas`. $transaction repassa o próprio
 * objeto. O ERP lança (pool nulo, como em produção) — o cadastro cai no outbox.
 */
function montar(opts: { existentes?: Record<string, any>; comEstoque?: string[] } = {}) {
  const escritas: Array<{ model: string; op: string; args: any }> = [];
  const existentes = opts.existentes || {};
  const comEstoque = new Set(opts.comEstoque || []);
  const upsertados = new Set<string>();
  let lastSeq = 100n;
  const grava = (model: string, op: string) =>
    jest.fn(async (args: any) => {
      escritas.push({ model, op, args });
      if (op === 'upsert' && model === 'product') upsertados.add(args.where.codigo);
      return {};
    });
  const handler: ProxyHandler<any> = {
    get(_t, model: string) {
      if (model === '$transaction') return async (fn: any) => fn(prisma);
      if (model === 'then') return undefined;
      if (model === 'eanSequence') {
        return {
          findFirst: jest.fn(async () => ({ id: 1, lastSeq })),
          update: jest.fn(async (args: any) => {
            escritas.push({ model, op: 'update', args });
            lastSeq = args.data.lastSeq;
            return {};
          }),
          create: grava(model, 'create'),
        };
      }
      return {
        findUnique: jest.fn(async ({ where }: any) => {
          if (model !== 'product' && model !== 'wincredProduto') return null;
          if (existentes[where.codigo]) return existentes[where.codigo];
          return model === 'product' && upsertados.has(where.codigo) ? { flowIsSource: true } : null;
        }),
        findFirst: jest.fn(async () => null),
        count: jest.fn(async ({ where }: any) => (comEstoque.has(where.codigo ?? where.sku) ? 1 : 0)),
        upsert: grava(model, 'upsert'),
        create: grava(model, 'create'),
        update: grava(model, 'update'),
        deleteMany: grava(model, 'deleteMany'),
      };
    },
  };
  const prisma: any = new Proxy({}, handler);
  const erp: any = {
    inserirProdutosBatch: jest.fn(async () => {
      throw new Error('ERP MySQL não está conectado');
    }),
  };
  const svc = new ProductRegistrationService(prisma, erp);
  const upsertsDe = (model: string) => escritas.filter((e) => e.op === 'upsert' && e.model === model);
  return { svc, escritas, upsertsDe, lastSeqAtual: () => lastSeq };
}

const ENTRADA = {
  grupoCodigo: 9001,
  grupoNome: 'CHINELO',
  subgrupoCodigo: 9101,
  subgrupoNome: 'HAVAIANAS',
  ref: 'SLIM POINT',
  fornecedorCnpj: '61079117000105',
  fornecedorNome: 'ALPARGATAS',
  custo: 40,
  precoVenda: 89.9,
  plusSize: false,
  marca: 'HAVAIANAS',
  cores: ['MARROM'],
  tamanhos: ['33/34', '35/36'],
};
const LIDOS = { 'MARROM|33/34': '7909989904862', 'MARROM|35/36': '7909989904879' };

describe('ProductRegistrationService.processar — o código de barras lido vira o CÓDIGO (04/11/2026)', () => {
  it('linha com código lido nasce com ele como código E ean, sem consumir EAN do Flow', async () => {
    const { svc, upsertsDe, lastSeqAtual } = montar();
    const r = await svc.processar({ ...ENTRADA, eans: LIDOS }, { gigaAsync: true });
    expect(r.itens.map((i) => i.codigo)).toEqual(['7909989904862', '7909989904879']);
    expect(r.itens.map((i) => i.ean)).toEqual(['7909989904862', '7909989904879']);
    expect(r.seqInicial).toBeNull();
    expect(lastSeqAtual()).toBe(100n);
    const upserts = upsertsDe('product');
    expect(upserts.map((e) => e.args.where.codigo)).toEqual(['7909989904862', '7909989904879']);
    expect(upserts[0].args.create.ean).toBe('7909989904862');
    // o espelho recebe dois upserts por peça (gravarNoFlow + espelhoImediato) — o que importa é o código
    expect(Array.from(new Set(upsertsDe('wincredProduto').map((e) => e.args.where.codigo)))).toEqual(['7909989904862', '7909989904879']);
    expect(r.inseridos).toBe(2);
    expect(r.ignorados).toBe(0);
  });

  it('mistura: só a linha SEM código lido consome EAN do Flow', async () => {
    const { svc, lastSeqAtual } = montar();
    const r = await svc.processar({ ...ENTRADA, eans: { 'MARROM|33/34': '7909989904862' } }, { gigaAsync: true });
    expect(r.itens[0].codigo).toBe('7909989904862');
    expect(r.itens[1].codigo).toMatch(/^8\d{12}$/);
    expect(r.itens[1].ean).toBe(r.itens[1].codigo);
    expect(lastSeqAtual()).toBe(101n);
    expect(r.seqInicial).toBe('101');
    expect(r.seqFinal).toBe('101');
  });

  it('zero à esquerda: o código segue a normalização do catálogo, o ean guarda o lido como está', async () => {
    const { svc, upsertsDe } = montar();
    const r = await svc.processar(
      { ...ENTRADA, eans: { 'MARROM|33/34': '0012345678905', 'MARROM|35/36': '7909989904879' } },
      { gigaAsync: true },
    );
    expect(r.itens[0].codigo).toBe('12345678905');
    expect(r.itens[0].ean).toBe('0012345678905');
    expect(upsertsDe('product')[0].args.create).toMatchObject({ codigo: '12345678905', ean: '0012345678905' });
  });

  it('lido que não cabe na coluna codigo (15+ caracteres) fica no modo antigo: EAN-13 do Flow + ean = o lido', async () => {
    const { svc, lastSeqAtual } = montar();
    const r = await svc.processar(
      { ...ENTRADA, eans: { 'MARROM|33/34': 'ABCDEFGHIJ123456', 'MARROM|35/36': '7909989904879' } },
      { gigaAsync: true },
    );
    expect(r.itens[0].codigo).toMatch(/^8\d{12}$/);
    expect(r.itens[0].ean).toBe('ABCDEFGHIJ123456');
    expect(r.itens[1].codigo).toBe('7909989904879');
    expect(lastSeqAtual()).toBe(101n);
  });

  it('código lido que já é de OUTRA peça = recusa antes de escrever ou consumir sequência', async () => {
    const { svc, escritas, lastSeqAtual } = montar({
      existentes: {
        '7909989904862': { codigo: '7909989904862', ref: 'TOP', cor: 'PRETO', tamanho: '33/34', descricaoCompleta: 'HAVAIANAS TOP PRETO 33/34' },
      },
    });
    await expect(svc.processar({ ...ENTRADA, eans: LIDOS }, { gigaAsync: true })).rejects.toThrow(
      /SLIM POINT MARROM 33\/34: o código de barras 7909989904862 já é o código da peça 7909989904862 \(HAVAIANAS TOP PRETO 33\/34\)/,
    );
    expect(escritas).toHaveLength(0);
    expect(lastSeqAtual()).toBe(100n);
  });

  it('código lido da MESMA peça (segunda compra) = reaproveita: não regrava, volta em itens', async () => {
    const { svc, upsertsDe } = montar({
      existentes: {
        '7909989904862': { codigo: '7909989904862', ref: 'SLIM POINT', cor: 'MARROM', tamanho: '33/34', descricaoCompleta: 'HAVAIANAS SLIM POINT MARROM 33/34 (DO EDITOR)' },
      },
    });
    const r = await svc.processar({ ...ENTRADA, eans: LIDOS }, { gigaAsync: true });
    expect(r.itens[0]).toMatchObject({
      codigo: '7909989904862',
      reaproveitado: true,
      descricaoCompleta: 'HAVAIANAS SLIM POINT MARROM 33/34 (DO EDITOR)',
    });
    expect(r.itens[1]).toMatchObject({ codigo: '7909989904879', reaproveitado: false });
    expect(r.inseridos).toBe(1);
    expect(r.ignorados).toBe(1);
    expect(r.total).toBe(2);
    expect(upsertsDe('product').map((e) => e.args.where.codigo)).toEqual(['7909989904879']);
  });

  it('o mesmo código lido em duas linhas do lote = recusa', async () => {
    const { svc, escritas } = montar();
    await expect(
      svc.processar({ ...ENTRADA, eans: { 'MARROM|33/34': '7909989904862', 'MARROM|35/36': '7909989904862' } }, { gigaAsync: true }),
    ).rejects.toThrow(/já foi lido em SLIM POINT MARROM 33\/34/);
    expect(escritas).toHaveLength(0);
  });

  it('código sem cadastro mas com estoque = recusa (adotaria saldo de peça desconhecida)', async () => {
    const { svc, escritas } = montar({ comEstoque: ['7909989904862'] });
    await expect(svc.processar({ ...ENTRADA, eans: LIDOS }, { gigaAsync: true })).rejects.toThrow(/já tem estoque de outra peça/);
    expect(escritas).toHaveLength(0);
  });

  it('sem código lido nada muda: EAN-13 do Flow pra todas, ean = o próprio código', async () => {
    const { svc, lastSeqAtual, upsertsDe } = montar();
    const r = await svc.processar(ENTRADA, { gigaAsync: true });
    expect(r.itens.map((i) => i.codigo)).toEqual([expect.stringMatching(/^8\d{12}$/), expect.stringMatching(/^8\d{12}$/)]);
    expect(r.itens.map((i) => i.ean)).toEqual(r.itens.map((i) => i.codigo));
    expect(r.itens.every((i) => !i.reaproveitado)).toBe(true);
    expect(lastSeqAtual()).toBe(102n);
    expect(r.seqInicial).toBe('101');
    expect(r.seqFinal).toBe('102');
    expect(upsertsDe('product')[0].args.create.ean).toBe(r.itens[0].codigo);
  });
});
