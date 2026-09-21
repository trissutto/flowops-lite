import { VitaliciosService } from './vitalicios.service';

/**
 * A montagem da aba cruza CINCO fontes (catálogo, estoque, caixas em
 * trânsito, pedidos a caminho e a matriz de mínimo/ideal) — este teste roda o
 * serviço inteiro sobre um banco de mentira pra provar que cada número cai na
 * célula certa, e que o pedido sai do jeito que o dono decidiu.
 */

type Linha = Record<string, any>;

function banco(dados: {
  vitalicios: Linha[];
  produtos: Linha[];
  estoque: Linha[];
  caixas?: Linha[];
  pecasEmCaixa?: Linha[];
  itensPedido?: Linha[];
  reposicao?: Linha[];
  ultimoPedido?: Linha | null;
}) {
  return {
    produtoVitalicio: {
      findMany: jest.fn(async (args?: any) => {
        const ors: any[] = args?.where?.OR || [];
        if (!ors.length) return dados.vitalicios;
        return dados.vitalicios.filter((v) => ors.some((o) => o.ref === v.ref && o.marca === v.marca));
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        dados.vitalicios.find((v) => v.ref === where.ref_marca.ref && v.marca === where.ref_marca.marca) || null,
      ),
      upsert: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    // O serviço corta por REF-base e marca em JS: o banco pode devolver tudo.
    product: { findMany: jest.fn(async () => dados.produtos) },
    wincredEstoque: {
      findMany: jest.fn(async ({ where }: any) => dados.estoque.filter((e) => where.codigo.in.includes(e.codigo))),
    },
    realignmentShipment: { findMany: jest.fn(async () => dados.caixas || []) },
    transferOrder: {
      findMany: jest.fn(async ({ where }: any) =>
        (dados.pecasEmCaixa || []).filter((p) => where.shipmentId.in.includes(p.shipmentId)),
      ),
    },
    purchaseOrderItem: {
      findMany: jest.fn(async ({ where }: any) => {
        const itens = dados.itensPedido || [];
        // ultimosItensComprados pede por REF; pedidosACaminho, por status do item.
        if (where?.ref?.in) return itens.filter((i) => where.ref.in.includes(i.ref));
        return itens.filter((i) => ['pendente', 'parcial'].includes(i.itemStatus) && i.order?.status !== 'cancelado');
      }),
    },
    produtoReposicao: { findMany: jest.fn(async () => dados.reposicao || []) },
    purchaseOrder: { findFirst: jest.fn(async () => dados.ultimoPedido ?? null) },
  };
}

const P = (codigo: string, ref: string, cor: string, tamanho: string, extra: Linha = {}) => ({
  codigo,
  ref,
  marca: 'MARRIE',
  cor,
  tamanho,
  custo: 25,
  vendaUn: 89.9,
  descricaoPdv: 'CASACO SOFT',
  descricaoCompleta: 'CASACO SOFT PLUS SIZE',
  grupo: 7,
  nomeGrupo: 'CASACO',
  subgrupo: null,
  ncm: '61023000',
  fornecedor: '12.345.678/0001-90',
  ...extra,
});

function montar(dados: Parameters<typeof banco>[0]) {
  const prisma = banco(dados);
  const erp = { listarFornecedores: jest.fn(async () => [{ cnpj: '12345678000190', nome: 'MARRIE ARIMATH' }]) };
  const pedidos = {
    create: jest.fn(async (input: any, _userId?: string) => ({
      id: 'po-1',
      numero: 321,
      fornecedorNome: input.fornecedorNome,
      fornecedorCnpj: input.fornecedorCnpj || null,
      totalPecas: input.items.reduce(
        (s: number, i: any) => s + Object.values(i.tamanhosQty as Record<string, number>).reduce((a, b) => a + b, 0),
        0,
      ),
      totalCusto: 0,
    })),
  };
  const svc = new VitaliciosService(prisma as any, erp as any, pedidos as any);
  return { svc, prisma, erp, pedidos };
}

const BASE = {
  vitalicios: [{ ref: '7031', marca: 'MARRIE', marcadoPor: 'Thiago', createdAt: new Date('2026-09-21') }],
  produtos: [
    P('8000000000461', '7031', 'PRETO', '46'),
    P('8000000000478', '7031', 'PRETO', '48'),
    // Sufixo de letra é a MESMA família (REF-base 7031).
    P('8000000000508', '7031A', 'AZUL', '50'),
    // 70310 é OUTRA família — o "começa com 7031" do banco não pode trazê-la.
    P('8000000009999', '70310', 'PRETO', '46'),
    // Mesma REF, OUTRA marca — não é a vitalícia.
    P('8000000008888', '7031', 'PRETO', '46', { marca: 'OUTRA' }),
  ],
  estoque: [
    { codigo: '8000000000461', loja: '01', estoque: 2 },
    // Loja com contagem negativa não desconta das outras.
    { codigo: '8000000000461', loja: '02', estoque: -1 },
    { codigo: '8000000000478', loja: '03', estoque: 5 },
    { codigo: '8000000009999', loja: '01', estoque: 40 },
    { codigo: '8000000008888', loja: '01', estoque: 40 },
  ],
  caixas: [{ id: 'cx-1' }],
  pecasEmCaixa: [{ shipmentId: 'cx-1', codigoBipado: '08000000000461' }],
  itensPedido: [
    {
      ref: '7031',
      cor: 'PRETO',
      tamanhosQty: '{"46":3}',
      tamanhosQtyRecebida: null,
      itemStatus: 'pendente',
      descricaoBase: 'CASACO SOFT',
      custoUnit: 30,
      precoUnit: 79.9,
      grupoCode: 7,
      grupoNome: 'CASACO',
      subgrupoCode: null,
      subgrupoNome: null,
      ncm: '61023000',
      createdAt: new Date('2026-09-10'),
      order: { numero: 10, status: 'enviado', origem: null, marca: 'MARRIE' },
    },
    {
      // Rascunho LANÇADO À MÃO e esquecido: não segura compra nenhuma.
      ref: '7031',
      cor: 'PRETO',
      tamanhosQty: '{"48":9}',
      tamanhosQtyRecebida: null,
      itemStatus: 'pendente',
      descricaoBase: 'CASACO SOFT',
      custoUnit: 28,
      precoUnit: 79.9,
      createdAt: new Date('2026-05-01'),
      order: { numero: 4, status: 'rascunho', origem: null, marca: 'MARRIE' },
    },
  ],
  reposicao: [
    { ref: '7031', marca: 'MARRIE', cor: 'PRETO', tamanho: '46', minimoTotal: 4, idealTotal: 10 },
    { ref: '7031', marca: 'MARRIE', cor: 'PRETO', tamanho: '48', minimoTotal: 2, idealTotal: 4 },
  ],
  ultimoPedido: { fornecedorNome: 'MARRIE ARIMATH', fornecedorCnpj: '12345678000190' },
};

describe('VitaliciosService.listar — cada número na célula certa', () => {
  it('soma rede + trânsito + pedido a caminho e completa até o IDEAL', async () => {
    const { svc } = montar(BASE);
    const r = await svc.listar();
    expect(r.refs).toHaveLength(1);
    const ref = r.refs[0];
    expect(ref.ref).toBe('7031');
    expect(ref.descricao).toBe('CASACO SOFT');

    const preto = ref.cores.find((c) => c.cor === 'PRETO')!;
    const t46 = preto.tamanhos.find((t) => t.tamanho === '46')!;
    expect(t46.estoque).toBe(2); // o -1 da loja 02 conta zero; a outra família e a outra marca ficam fora
    expect(t46.transito).toBe(1); // código com zero à esquerda casa
    expect(t46.emPedido).toBe(3);
    expect(t46.pedidos).toEqual([{ numero: 10, qtd: 3 }]);
    expect(t46.tenho).toBe(6);
    expect(t46.comprar).toBe(4);
    expect(t46.situacao).toBe('abaixo_ideal');

    const t48 = preto.tamanhos.find((t) => t.tamanho === '48')!;
    expect(t48.emPedido).toBe(0); // rascunho manual esquecido não conta
    expect(t48.comprar).toBe(0);
    expect(t48.situacao).toBe('ok');

    // Grade da casa inteira na linha, mesmo sem peça cadastrada no tamanho.
    expect(preto.tamanhos.map((t) => t.tamanho)).toEqual(['46', '48', '50', '52', '54', '56', '58', '60']);
    const t60 = preto.tamanhos.find((t) => t.tamanho === '60')!;
    expect(t60.comprar).toBeNull(); // sem ideal: vazio, não zero

    // Custo = o último PAGO (pedido #10); preço = o de venda de hoje.
    expect(preto.custoUnit).toBe(30);
    expect(preto.precoUnit).toBe(89.9);
    expect(preto.comprar).toBe(4);
    expect(ref.custoComprar).toBe(120);

    // AZUL: sem estoque, sem pedido, sem mínimo/ideal — some da grade, mas é
    // contada, com a grade dela (a tela abre a cor com os tamanhos certos) e
    // com o MESMO custo/preço que o gerar usaria (cor nunca pedida herda o
    // último custo pago da REF).
    expect(ref.cores.map((c) => c.cor)).toEqual(['PRETO']);
    expect(ref.coresSemMovimento).toEqual([
      { cor: 'AZUL', tamanhos: ['46', '48', '50', '52', '54', '56', '58', '60'], custoUnit: 30, precoUnit: 89.9 },
    ]);
  });

  it('rascunho gerado PELA ABA segura a compra (gerar duas vezes não dobra)', async () => {
    const itensPedido = [
      ...BASE.itensPedido,
      {
        ref: '7031',
        cor: 'PRETO',
        tamanhosQty: '{"46":4}',
        tamanhosQtyRecebida: null,
        itemStatus: 'pendente',
        custoUnit: 30,
        precoUnit: 89.9,
        createdAt: new Date('2026-09-21'),
        order: { numero: 11, status: 'rascunho', origem: 'vitalicios', marca: 'MARRIE' },
      },
    ];
    const { svc } = montar({ ...BASE, itensPedido });
    const r = await svc.listar();
    const t46 = r.refs[0].cores[0].tamanhos.find((t) => t.tamanho === '46')!;
    expect(t46.emPedido).toBe(7);
    expect(t46.comprar).toBe(0);
  });

  it('filtro de marca e de busca', async () => {
    const { svc } = montar(BASE);
    expect((await svc.listar({ marca: 'outra' })).refs).toHaveLength(0);
    expect((await svc.listar({ busca: 'soft' })).refs).toHaveLength(1);
    expect((await svc.listar({ busca: 'vestido' })).refs).toHaveLength(0);
  });
});

describe('VitaliciosService.gerarPedidos — um rascunho por marca', () => {
  it('gera o pedido com o custo pago, o preço de hoje e o fornecedor do último pedido', async () => {
    const { svc, pedidos } = montar(BASE);
    const r = await svc.gerarPedidos(
      [{ ref: '7031', marca: 'marrie', cor: 'preto', tamanhos: { '46': 4, '48': 0, '50': -2 } }],
      'user-1',
      'Thiago',
    );
    expect(pedidos.create).toHaveBeenCalledTimes(1);
    const [input, userId] = pedidos.create.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(input.marca).toBe('MARRIE');
    expect(input.origem).toBe('vitalicios');
    expect(input.fornecedorNome).toBe('MARRIE ARIMATH');
    expect(input.fornecedorCnpj).toBe('12345678000190');
    expect(input.items).toHaveLength(1);
    expect(input.items[0]).toMatchObject({
      ref: '7031',
      cor: 'PRETO',
      custoUnit: 30,
      precoUnit: 89.9,
      ncm: '61023000',
      tamanhosQty: { '46': 4 },
    });
    expect(r.pedidos).toEqual([
      expect.objectContaining({ numero: 321, marca: 'MARRIE', pecas: 4, semCnpj: false }),
    ]);
  });

  it('recusa REF que não está marcada como vitalícia', async () => {
    const { svc, pedidos } = montar(BASE);
    await expect(
      svc.gerarPedidos([{ ref: '9999', marca: 'MARRIE', cor: 'PRETO', tamanhos: { '46': 1 } }], null, 'x'),
    ).rejects.toThrow(/não estão marcadas como vitalícias/);
    expect(pedidos.create).not.toHaveBeenCalled();
  });

  it('peça sem custo não inventa valor: sai da lista com o motivo', async () => {
    const semCusto = {
      ...BASE,
      itensPedido: [],
      produtos: BASE.produtos.map((p) => ({ ...p, custo: null })),
    };
    const { svc, pedidos } = montar(semCusto);
    const r = await svc.gerarPedidos(
      [{ ref: '7031', marca: 'MARRIE', cor: 'PRETO', tamanhos: { '46': 2 } }],
      null,
      'x',
    );
    expect(pedidos.create).not.toHaveBeenCalled();
    expect(r.pedidos).toHaveLength(0);
    expect(r.ignorados[0]).toMatchObject({ ref: '7031', cor: 'PRETO' });
  });

  it('sem pedido anterior da marca, usa o CNPJ que as peças carregam', async () => {
    const { svc, pedidos, erp } = montar({ ...BASE, ultimoPedido: null });
    await svc.gerarPedidos([{ ref: '7031', marca: 'MARRIE', cor: 'PRETO', tamanhos: { '46': 1 } }], null, 'x');
    expect(erp.listarFornecedores).toHaveBeenCalled();
    expect(pedidos.create.mock.calls[0][0]).toMatchObject({ fornecedorNome: 'MARRIE ARIMATH', fornecedorCnpj: '12345678000190' });
  });
});

describe('VitaliciosService.marcar', () => {
  it('não marca REF que não existe no catálogo', async () => {
    const { svc, prisma } = montar(BASE);
    await expect(svc.marcar([{ ref: '5555', marca: 'MARRIE' }], 'x')).rejects.toThrow(/sem peça no catálogo/);
    expect(prisma.produtoVitalicio.upsert).not.toHaveBeenCalled();
    await svc.marcar([{ ref: '7031a', marca: 'marrie' }], 'Thiago');
    expect(prisma.produtoVitalicio.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { ref: '7031', marca: 'MARRIE', marcadoPor: 'Thiago' } }),
    );
  });
});
