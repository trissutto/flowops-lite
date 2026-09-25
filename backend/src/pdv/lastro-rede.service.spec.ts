import { LastroRedeService } from './lastro-rede.service';

/**
 * SEMÁFORO DE LASTRO — de onde vem o número (25/09).
 *
 * Caso real: Itanhaém vendendo a REGATA 207333 PRETO 56 (código 5238927) a
 * distância. A Consulta mostrava 2 na loja e 12 na rede; o passo do frete
 * dizia 🔴 "NÃO EXISTE em nenhuma loja nem em trânsito". O serviço lia
 * `giga_estoque` cru enquanto Consulta, site, bipe e routing leem
 * `wincred_estoque` via StockService. O contrato agora é: o semáforo enxerga
 * pela MESMA vista do routing, e erro do espelho SOBE em vez de virar vermelho.
 */
const SKU = '5238927';

function montar(opts?: {
  estoque?: Array<{ sku: string; storeCode: string; availableQty: number }>;
  committed?: Map<string, number>;
  caixas?: any[];
  pecasEmCaixa?: any[];
  estoqueFalha?: Error;
}) {
  const prisma = {
    store: {
      findMany: jest.fn().mockResolvedValue([
        { code: '01', name: 'Santos' },
        { code: '07', name: 'Itanhaém' },
        { code: '13', name: 'SITE' }, // loja-canal: nunca cede peça
      ]),
    },
    realignmentShipment: { findMany: jest.fn().mockResolvedValue(opts?.caixas ?? []) },
    transferOrder: { findMany: jest.fn().mockResolvedValue(opts?.pecasEmCaixa ?? []) },
    // A tabela que o bug lia. Se alguém voltar a consultá-la aqui, o teste cai.
    $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('giga_estoque não é fonte do semáforo')),
    gigaEstoque: { findMany: jest.fn().mockRejectedValue(new Error('giga_estoque não é fonte do semáforo')) },
    integrationLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const routing = { getCommittedStock: jest.fn().mockResolvedValue(opts?.committed ?? new Map()) };
  const stock = {
    getStockFor: opts?.estoqueFalha
      ? jest.fn().mockRejectedValue(opts.estoqueFalha)
      : jest.fn().mockResolvedValue(opts?.estoque ?? []),
  };
  const svc = new LastroRedeService(prisma as any, routing as any, stock as any);
  return { svc, prisma, routing, stock };
}

describe('LastroRedeService.checar — fonte do estoque', () => {
  it('peça com saldo no espelho que a Consulta lê → VERDE, sem passar perto de giga_estoque', async () => {
    const { svc, prisma, stock } = montar({
      estoque: [
        { sku: SKU, storeCode: '07', availableQty: 2 },
        { sku: SKU, storeCode: '01', availableQty: 1 },
      ],
    });
    const r = await svc.checar([{ sku: SKU, qty: 1 }]);
    expect(r.porSku[SKU]).toMatchObject({ status: 'verde', motivo: null, precisa: 1, bruto: 3, disponivel: 3, prometidas: 0 });
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.gigaEstoque.findMany).not.toHaveBeenCalled();
    // A MESMA chamada do routing: fresca (sem cache de 30s) e só com lojas que cedem peça.
    expect(stock.getStockFor).toHaveBeenCalledWith([SKU], ['01', '07'], { fresh: true });
  });

  it('a loja-canal (13) não entra nem na pergunta ao espelho', async () => {
    const { svc, stock } = montar({ estoque: [] });
    await svc.checar([{ sku: SKU }]);
    const [, codes] = stock.getStockFor.mock.calls[0];
    expect(codes).not.toContain('13');
  });

  it('espelho fora do ar → o erro SOBE (o PDV mostra "não consegui conferir"), nunca vira vermelho', async () => {
    const { svc } = montar({ estoqueFalha: new Error('wincred_estoque caiu') });
    await expect(svc.checar([{ sku: SKU }])).rejects.toThrow('wincred_estoque caiu');
  });

  it('sku com zeros à esquerda e repetido agrega a quantidade numa chave só', async () => {
    const { svc, stock } = montar({ estoque: [{ sku: SKU, storeCode: '07', availableQty: 5 }] });
    const r = await svc.checar([{ sku: '0005238927', qty: 1 }, { sku: SKU, qty: 2 }]);
    expect(Object.keys(r.porSku)).toEqual([SKU]);
    expect(r.porSku[SKU]).toMatchObject({ status: 'verde', precisa: 3 });
    expect(stock.getStockFor.mock.calls[0][0]).toEqual([SKU]);
  });
});

describe('LastroRedeService.checar — as cores', () => {
  it('só parte da quantidade na rede → AMARELO parcial', async () => {
    const { svc } = montar({ estoque: [{ sku: SKU, storeCode: '07', availableQty: 2 }] });
    const r = await svc.checar([{ sku: SKU, qty: 3 }]);
    expect(r.porSku[SKU]).toMatchObject({ status: 'amarelo', motivo: 'parcial', disponivel: 2, precisa: 3 });
  });

  it('tudo já prometido a card aberto → AMARELO prometida (chave do routing com zeros casa com o sku)', async () => {
    const { svc } = montar({
      estoque: [{ sku: SKU, storeCode: '07', availableQty: 2 }],
      committed: new Map([['07::0005238927', 2]]),
    });
    const r = await svc.checar([{ sku: SKU, qty: 1 }]);
    expect(r.porSku[SKU]).toMatchObject({ status: 'amarelo', motivo: 'prometida', bruto: 2, disponivel: 0, prometidas: 2 });
  });

  it('nada em loja, mas dentro de caixa em trânsito → AMARELO trânsito com a caixa', async () => {
    const { svc } = montar({
      estoque: [],
      caixas: [{ id: 'cx1', code: 'REM-900', toStoreCode: '07', toStoreName: 'Itanhaém', sentAt: new Date(Date.now() - 2 * 86_400_000) }],
      pecasEmCaixa: [{ shipmentId: 'cx1', codigoBipado: '0005238927' }],
    });
    const r = await svc.checar([{ sku: SKU }]);
    expect(r.porSku[SKU]).toMatchObject({ status: 'amarelo', motivo: 'transito', bruto: 0 });
    expect(r.porSku[SKU].transito).toEqual([{ caixa: 'REM-900', paraLoja: '07', paraLojaNome: 'Itanhaém', qty: 1, dias: 2 }]);
  });

  it('nem em loja nem em trânsito → VERMELHO inexistente', async () => {
    const { svc } = montar({ estoque: [] });
    const r = await svc.checar([{ sku: SKU }]);
    expect(r.porSku[SKU]).toMatchObject({ status: 'vermelho', motivo: 'inexistente', bruto: 0, disponivel: 0 });
  });

  it('carrinho sem peça → nada a checar e nenhuma consulta', async () => {
    const { svc, stock, prisma } = montar();
    const r = await svc.checar([{ sku: '' }, { sku: '000' }]);
    expect(r).toEqual({ porSku: {} });
    expect(stock.getStockFor).not.toHaveBeenCalled();
    expect(prisma.store.findMany).not.toHaveBeenCalled();
  });
});
