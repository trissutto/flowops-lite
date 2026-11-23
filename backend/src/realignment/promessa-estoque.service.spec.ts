import { PromessaEstoqueService } from './promessa-estoque.service';

/**
 * PEÇA VENDIDA NÃO VAI POR TRANSFERÊNCIA COMUM (25/09/2026, LP-001508).
 * Prisma mockado: bipes de pedido, cards e espelho de estoque.
 */
function servico(m: { scans?: any[]; picks?: any[]; estoque?: any[] }) {
  const prisma: any = {
    pickOrderScan: { findMany: jest.fn(async () => m.scans ?? []) },
    pickOrder: {
      findMany: jest.fn(async ({ where }: any) =>
        (m.picks ?? []).filter(
          (p) => (where?.id?.in ?? []).includes(p.id) && !(where?.status?.notIn ?? []).includes(p.status),
        ),
      ),
    },
    wincredEstoque: { findMany: jest.fn(async () => m.estoque ?? []) },
  };
  return new PromessaEstoqueService(prisma);
}

const calca = { codigo: '5269396', qty: 1, rotulo: '6605 JEANS 44' };
const bipeDaCalca = [{ sku: '5269396', pickOrderId: 'p01' }];
const cardAberto = (status = 'separating') => [
  { id: 'p01', status, order: { wcOrderNumber: 'LP-001508', wcOrderId: 950001508 } },
];
const saldo01 = (estoque: number) => [{ codigo: '5269396', loja: '01', estoque }];

describe('garantirNaoLevaPecaVendida', () => {
  it('LP-001508: calça bipada no pedido, card aberto, saldo 0 → recusa e diz o pedido', async () => {
    const s = servico({ scans: bipeDaCalca, picks: cardAberto(), estoque: saldo01(0) });
    await expect(s.garantirNaoLevaPecaVendida({ origemCode: '01', itens: [calca] })).rejects.toThrow(
      /PEÇA VENDIDA.*6605 JEANS 44.*LP-001508/,
    );
  });

  it('sem bipe de pedido nesta loja → passa (mesmo com saldo 0: transferência comum de sempre)', async () => {
    const s = servico({ scans: [], picks: [], estoque: saldo01(0) });
    await expect(s.garantirNaoLevaPecaVendida({ origemCode: '01', itens: [calca] })).resolves.toBeUndefined();
  });

  it('loja tem outra peça livre (saldo cobre a transferência) → passa', async () => {
    const s = servico({ scans: bipeDaCalca, picks: cardAberto(), estoque: saldo01(1) });
    await expect(s.garantirNaoLevaPecaVendida({ origemCode: '01', itens: [calca] })).resolves.toBeUndefined();
  });

  it('duas unidades na caixa com uma livre → recusa (a segunda é a vendida)', async () => {
    const s = servico({ scans: bipeDaCalca, picks: cardAberto(), estoque: saldo01(1) });
    await expect(
      s.garantirNaoLevaPecaVendida({ origemCode: '01', itens: [{ ...calca, qty: 2 }] }),
    ).rejects.toThrow(/PEÇA VENDIDA/);
  });

  it('card do pedido já `shipped` (a peça embarcou daqui) → não conta → passa', async () => {
    const s = servico({ scans: bipeDaCalca, picks: cardAberto('shipped'), estoque: saldo01(0) });
    await expect(s.garantirNaoLevaPecaVendida({ origemCode: '01', itens: [calca] })).resolves.toBeUndefined();
  });

  it('espelho não conhece o código → fail-open (mesma política das outras travas)', async () => {
    const s = servico({ scans: bipeDaCalca, picks: cardAberto(), estoque: [] });
    await expect(s.garantirNaoLevaPecaVendida({ origemCode: '01', itens: [calca] })).resolves.toBeUndefined();
  });

  it('código bipado com zero à esquerda casa com o bipe do pedido sem zero', async () => {
    const s = servico({ scans: bipeDaCalca, picks: cardAberto(), estoque: saldo01(0) });
    await expect(
      s.garantirNaoLevaPecaVendida({ origemCode: '01', itens: [{ ...calca, codigo: '05269396' }] }),
    ).rejects.toThrow(/PEÇA VENDIDA/);
  });

  it('sem itens ou sem loja de origem → não consulta nada', async () => {
    const s = servico({ scans: bipeDaCalca, picks: cardAberto(), estoque: saldo01(0) });
    await expect(s.garantirNaoLevaPecaVendida({ origemCode: '', itens: [calca] })).resolves.toBeUndefined();
    await expect(s.garantirNaoLevaPecaVendida({ origemCode: '01', itens: [] })).resolves.toBeUndefined();
  });
});

/**
 * ÓRFÃ DE TRANSFERÊNCIA NÃO É PROMESSA (23/11/2026 — Itanhaém → Praia Grande).
 * 42 bipes gravaram a linha `pending` e não entraram na REM-2026-003253; a
 * trava do eco do leitor contava cada uma como "já pedida" até a loja não
 * conseguir bipar mais nada (HAPPINESS PRETO 50: 5 órfãs, 5 em estoque).
 */
function servicoPromessas(m: { ordens?: any[]; caixas?: any[]; estoque?: any[] }) {
  const prisma: any = {
    transferOrder: {
      findMany: jest.fn(async ({ where }: any) =>
        (m.ordens ?? []).filter((o) => {
          if (where?.codigoBipado && typeof where.codigoBipado === 'string' && o.codigoBipado !== where.codigoBipado) return false;
          if (where?.codigoBipado?.in && !where.codigoBipado.in.includes(o.codigoBipado)) return false;
          if (where?.lojaOrigemCode && o.lojaOrigemCode !== where.lojaOrigemCode) return false;
          if (where?.lojaDestinoCode && o.lojaDestinoCode !== where.lojaDestinoCode) return false;
          if (where?.realignmentStatus?.in && !where.realignmentStatus.in.includes(o.realignmentStatus)) return false;
          return true;
        }),
      ),
    },
    realignmentShipment: { findMany: jest.fn(async () => m.caixas ?? []) },
    wincredEstoque: { findMany: jest.fn(async () => m.estoque ?? []) },
  };
  return new PromessaEstoqueService(prisma);
}

const HAPPINESS50 = '8000000054906';
const orfa = () => ({
  tipo: 'TRANSFERENCIA', codigoBipado: HAPPINESS50, lojaOrigemCode: '01', lojaDestinoCode: '14',
  realignmentStatus: 'pending', shipmentId: null, qtyOrigem: 1,
});
const naCaixa = (shipmentId = 'rem-3253') => ({
  tipo: 'TRANSFERENCIA', codigoBipado: HAPPINESS50, lojaOrigemCode: '01', lojaDestinoCode: '14',
  realignmentStatus: 'sent', shipmentId, qtyOrigem: 1,
});
const pedidoRealinhamento = () => ({
  tipo: 'REALINHAMENTO', codigoBipado: HAPPINESS50, lojaOrigemCode: '01', lojaDestinoCode: '14',
  realignmentStatus: 'pending', shipmentId: null, qtyOrigem: 1,
});
const estoque01 = (n: number) => [{ codigo: HAPPINESS50, loja: '01', estoque: n }];
const bipe = { codigo: HAPPINESS50, origemCode: '01', destinoCode: '14', rotulo: 'HAPPINESS PRETO 50' };

describe('garantirNaoDuplicaBipe — órfã de transferência não é promessa', () => {
  it('23/11: 5 órfãs e 5 em estoque → o bipe PASSA (antes: "já está pedida (5) e a loja tem 5")', async () => {
    const s = servicoPromessas({ ordens: [orfa(), orfa(), orfa(), orfa(), orfa()], estoque: estoque01(5) });
    await expect(s.garantirNaoDuplicaBipe(bipe)).resolves.toBeUndefined();
  });

  it('eco do leitor continua barrado: 1 peça já na caixa ABERTA, 1 em estoque → recusa', async () => {
    const s = servicoPromessas({
      ordens: [naCaixa()],
      caixas: [{ id: 'rem-3253', status: 'open' }],
      estoque: estoque01(1),
    });
    await expect(s.garantirNaoDuplicaBipe(bipe)).rejects.toThrow(/já está pedida daqui pra essa loja \(1\) e a loja tem 1/);
  });

  it('pedido de REALINHAMENTO pendente (sem caixa) é promessa de verdade → recusa', async () => {
    const s = servicoPromessas({ ordens: [pedidoRealinhamento()], estoque: estoque01(1) });
    await expect(s.garantirNaoDuplicaBipe(bipe)).rejects.toThrow(/já está pedida/);
  });

  it('peça em caixa já FECHADA (in_transit) não conta — o estoque da origem já baixou', async () => {
    const s = servicoPromessas({
      ordens: [naCaixa('rem-velha')],
      caixas: [{ id: 'rem-velha', status: 'in_transit' }],
      estoque: estoque01(1),
    });
    await expect(s.garantirNaoDuplicaBipe(bipe)).resolves.toBeUndefined();
  });

  it('órfãs misturadas com a peça real na caixa: só a real conta (1 na caixa + 4 órfãs, 2 em estoque → passa)', async () => {
    const s = servicoPromessas({
      ordens: [naCaixa(), orfa(), orfa(), orfa(), orfa()],
      caixas: [{ id: 'rem-3253', status: 'open' }],
      estoque: estoque01(2),
    });
    await expect(s.garantirNaoDuplicaBipe(bipe)).resolves.toBeUndefined();
  });
});

describe('prometidasPorCodigo — a conta da Grade por Loja e do plano', () => {
  it('órfãs de transferência não entram no prometido', async () => {
    const s = servicoPromessas({ ordens: [orfa(), orfa(), orfa()] });
    const m = await s.prometidasPorCodigo([HAPPINESS50], '01');
    expect(m.get(HAPPINESS50) ?? 0).toBe(0);
  });

  it('peça na caixa aberta + pedido de realinhamento somam normalmente', async () => {
    const s = servicoPromessas({
      ordens: [naCaixa(), pedidoRealinhamento(), orfa()],
      caixas: [{ id: 'rem-3253', status: 'open' }],
    });
    const m = await s.prometidasPorCodigo([HAPPINESS50], '01');
    expect(m.get(HAPPINESS50)).toBe(2);
  });
});

describe('cancelarOrfasDeTransferencia — a varredura', () => {
  it('cancela só TRANSFERENCIA pendente sem caixa mais velha que o corte, com a nota, e conta por rota', async () => {
    const updateMany = jest.fn(async () => ({ count: 2 }));
    const findMany = jest.fn(async () => [
      { lojaOrigemCode: '01', lojaDestinoCode: '14' },
      { lojaOrigemCode: '01', lojaDestinoCode: '14' },
    ]);
    const s = new PromessaEstoqueService({ transferOrder: { findMany, updateMany } } as any);
    const antes = Date.now();
    const r = await s.cancelarOrfasDeTransferencia(10);
    expect(r.canceladas).toBe(2);
    expect(r.porLoja).toEqual([{ loja: '01→14', n: 2 }]);
    const chamada: any = (updateMany.mock.calls as any[])[0][0];
    const where = chamada.where;
    expect(where.tipo).toBe('TRANSFERENCIA');
    expect(where.realignmentStatus).toBe('pending');
    expect(where.shipmentId).toBeNull();
    // corte ≈ agora − 10 min (tolerância de 5s pro relógio do teste)
    expect(Math.abs(antes - 10 * 60_000 - where.createdAt.lt.getTime())).toBeLessThan(5_000);
    expect(chamada.data.realignmentStatus).toBe('cancelled');
    expect(chamada.data.realignmentNotFoundNote).toMatch(/não entrou na caixa/);
  });

  it('sem órfã → não escreve nada', async () => {
    const updateMany = jest.fn();
    const s = new PromessaEstoqueService({ transferOrder: { findMany: jest.fn(async () => []), updateMany } } as any);
    const r = await s.cancelarOrfasDeTransferencia(10);
    expect(r.canceladas).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
