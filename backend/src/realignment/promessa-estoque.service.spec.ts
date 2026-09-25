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
