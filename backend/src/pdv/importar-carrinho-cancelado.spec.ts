import { PdvService } from './pdv.service';

/**
 * VENDA CANCELADA NÃO SEGURA O CARRINHO (25/08/2026).
 *
 * A operadora importou o carrinho pro PDV, cancelou a venda (peça errada,
 * cliente mudou de tamanho, o que for) — e a cliente virou fantasma:
 *
 *   • sumiu da fila "Carrinhos" do PDV de TODAS as lojas, porque o filtro de
 *     "já importado" só olhava se EXISTIA venda vinculada, não o status dela;
 *   • e na retaguarda, onde a linha continuava aparecendo, o botão "Fechar
 *     esta venda no PDV" respondia `400 Este carrinho JÁ virou venda no PDV`
 *     pra sempre.
 *
 * Invisível de um lado, intocável do outro: sobrava fechar por fora, que é o
 * buraco que este botão existe pra tapar. Medido em produção no dia: 2
 * capturas ativas nessa situação (R$ 199,70 e R$ 139,80), nenhuma com baixa.
 */
describe('Importar carrinho — venda cancelada volta a ser importável', () => {
  const capturaBase = {
    id: 'rec-1',
    nome: 'ALESSANDRA ANDRIATO LUIZ',
    telefone: '19996386158',
    sessionId: 'sess-1',
    status: 'active',
    subtotal: 199.7,
    items: [{ productId: 'CHIC', color: 'PRETO', size: '52', quantity: 1, unitPrice: 69.9 }],
    createdAt: new Date('2026-08-25T14:57:00Z'),
    updatedAt: new Date('2026-08-25T14:57:00Z'),
  };

  /** Serviço sem construtor: ele pede uma dúzia de dependências que a decisão
   *  testada aqui não usa. O que importa é o que a regra faz com o status. */
  const fazService = (vendasDoCarrinho: any[]) => {
    const svc = Object.create(PdvService.prototype) as PdvService;
    const prisma: any = {
      checkoutRecovery: {
        findUnique: jest.fn().mockResolvedValue(capturaBase),
        findMany: jest.fn().mockResolvedValue([capturaBase]),
      },
      pdvSale: {
        // Mock com cara de banco: respeita o filtro de status que o código manda.
        findMany: jest.fn().mockImplementation(({ where }: any) => {
          const st = where?.status;
          return Promise.resolve(
            vendasDoCarrinho
              .filter((v) => {
                if (st?.not) return v.status !== st.not;
                if (st?.notIn) return !st.notIn.includes(v.status);
                return true;
              })
              // Todas as vendas do mock são deste carrinho. A fila pede o
              // `_count` dos itens pra saber se a venda aberta tem alguma peça
              // dentro; a importação não usa.
              .map((v) => ({
                ...v,
                carrinhoRecoveryId: capturaBase.id,
                _count: { items: v.itens ?? 1 },
              })),
          );
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    (svc as any).prisma = prisma;
    (svc as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    (svc as any).createSale = jest
      .fn()
      .mockResolvedValue({ id: 'venda-nova', storeCode: '15', items: [] });
    (svc as any).resolverCodigoDaVariacao = jest.fn().mockResolvedValue('CHIC PRETO 52');
    (svc as any).addItem = jest
      .fn()
      .mockResolvedValue({ item: { id: 'i1', precoUnit: 69.9 }, sale: { items: [] } });
    (svc as any).setCustomer = jest.fn().mockResolvedValue({});
    return { svc, prisma };
  };

  const importar = (svc: PdvService) =>
    (svc as any).importarCarrinho({ recoveryId: 'rec-1', storeCode: '15' });

  it('venda CANCELADA → importa de novo (a peça não foi vendida)', async () => {
    const { svc } = fazService([
      {
        id: 'venda-cancelada',
        storeCode: '13',
        storeName: 'SITE',
        status: 'cancelled',
        createdAt: new Date('2026-08-25T15:58:00Z'),
      },
    ]);
    const r = await importar(svc);
    expect(r.saleId).toBe('venda-nova');
    expect(r.jaExistia).toBe(false);
    expect((svc as any).createSale).toHaveBeenCalled();
  });

  it('venda FINALIZADA → recusa, e diz onde e quando ela foi feita', async () => {
    const { svc } = fazService([
      {
        id: 'venda-fechada',
        storeCode: '13',
        storeName: 'SITE',
        status: 'finalized',
        createdAt: new Date('2026-08-25T15:58:00Z'),
      },
    ]);
    await expect(importar(svc)).rejects.toThrow(/JÁ virou venda no PDV \(SITE, 25\/08/);
    expect((svc as any).createSale).not.toHaveBeenCalled();
  });

  it('venda ABERTA → devolve ELA, sem criar uma segunda', async () => {
    const { svc } = fazService([
      {
        id: 'venda-aberta',
        storeCode: '13',
        storeName: 'SITE',
        status: 'open',
        createdAt: new Date('2026-08-25T15:58:00Z'),
      },
    ]);
    const r = await importar(svc);
    expect(r).toMatchObject({ saleId: 'venda-aberta', storeCode: '13', jaExistia: true });
    expect((svc as any).createSale).not.toHaveBeenCalled();
  });

  it('cancelada + finalizada no mesmo carrinho → vale a FINALIZADA (recusa)', async () => {
    const { svc } = fazService([
      // A cancelada é a mais recente — a regra antiga olhava só essa.
      { id: 'v2', storeCode: '15', storeName: 'MOEMA', status: 'cancelled', createdAt: new Date('2026-08-25T18:00:00Z') },
      { id: 'v1', storeCode: '13', storeName: 'SITE', status: 'finalized', createdAt: new Date('2026-08-25T15:58:00Z') },
    ]);
    await expect(importar(svc)).rejects.toThrow(/JÁ virou venda no PDV/);
  });

  it('a fila do PDV não pergunta por venda cancelada — a linha volta a aparecer', async () => {
    const { svc, prisma } = fazService([
      { id: 'venda-cancelada', storeCode: '13', storeName: 'SITE', status: 'cancelled', createdAt: new Date() },
    ]);
    const linhas = await (svc as any).listarContatosCapturados('abandoned', []);
    // O filtro de "já importado" ignora cancelada (mock respeita o where).
    expect(prisma.pdvSale.findMany.mock.calls[0][0].where.status).toEqual({ not: 'cancelled' });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ recovery_id: 'rec-1', source: 'ecommerce-contact' });
  });

  it('venda aberta VAZIA (nenhuma peça resolveu) não esconde a cliente da fila', async () => {
    const { svc } = fazService([
      { id: 'venda-vazia', storeCode: '13', storeName: 'SITE', status: 'open', itens: 0, createdAt: new Date() },
    ]);
    const linhas = await (svc as any).listarContatosCapturados('abandoned', []);
    expect(linhas).toHaveLength(1);
  });

  it('venda aberta COM peça continua segurando a linha — a venda está na tela dela', async () => {
    const { svc } = fazService([
      { id: 'venda-montada', storeCode: '13', storeName: 'SITE', status: 'open', itens: 3, createdAt: new Date() },
    ]);
    const linhas = await (svc as any).listarContatosCapturados('abandoned', []);
    expect(linhas).toHaveLength(0);
  });
});
