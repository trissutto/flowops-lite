import { BadRequestException } from '@nestjs/common';
import { PickScanService } from './pick-scan.service';

/**
 * CARD JÁ BAIXADO QUE GANHOU PEÇA NOVA (ON-000214 / ON-000201, 28-29/08).
 *
 * O recalculo do pedido incluía peça num card que a loja já tinha bipado e
 * finalizado (carimbo `debitApprovedAt`), e o bipe recusava tudo: "Estoque
 * deste pedido já foi baixado — não dá pra bipar de novo". Estes testes travam
 * o comportamento novo: o bipe REABRE a baixa quando os fechamentos anteriores
 * não tocaram estoque em nível de card (`"applied":[]`), e continua recusando
 * quando reabrir dobraria a baixa.
 */
describe('PickScanService — peça nova em card já baixado', () => {
  const CARD = 'card-1';
  const STORE = 'store-17';
  const CARIMBO = new Date('2026-08-28T03:48:51Z');

  const makeService = (opts: {
    debitApprovedAt: Date | null;
    baixaDeCardLog: { id: number } | null;
    jaBipadosDoSku?: number;
  }) => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      pickOrder: {
        findUnique: jest.fn().mockResolvedValue({
          status: 'separating',
          debitApprovedAt: opts.debitApprovedAt,
          issueReason: null,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      pickOrderScan: {
        count: jest.fn().mockResolvedValue(opts.jaBipadosDoSku ?? 0),
        create: jest.fn().mockResolvedValue({
          scanUid: 'uid-1',
          sku: 'PECA-NOVA',
          ean: null,
          debitSkippedReason: null,
        }),
      },
      integrationLog: {
        findFirst: jest.fn().mockResolvedValue(opts.baixaDeCardLog),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma: any = {
      $transaction: jest.fn(async (cb: any) => cb(tx)),
      pickOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: CARD,
          storeId: STORE,
          orderId: 'order-1',
          status: 'separating',
          debitApprovedAt: opts.debitApprovedAt,
          issueReason: null,
          store: { code: '17' },
        }),
      },
      orderItem: {
        findMany: jest.fn().mockResolvedValue([
          { sku: 'PECA-VELHA', quantity: 1 },
          { sku: 'PECA-NOVA', quantity: 1 },
        ]),
      },
      pickOrderScan: {
        groupBy: jest.fn().mockResolvedValue([{ sku: 'PECA-NOVA', _count: { _all: 1 } }]),
      },
      integrationLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const erp: any = { isWriteEnabled: true, applyStockDeltaInTx: jest.fn() };
    return { service: new PickScanService(prisma, erp), tx, prisma, erp };
  };

  const bipar = (service: PickScanService, sku = 'PECA-NOVA') =>
    service.registerScan(CARD, STORE, 'user-1', { scanUid: 'uid-1', sku });

  it('reabre a baixa e registra o bipe quando os fechamentos foram só carimbo (applied:[])', async () => {
    const { service, tx, erp } = makeService({ debitApprovedAt: CARIMBO, baixaDeCardLog: null });

    const res = await bipar(service);

    expect(res.ok).toBe(true);
    // O carimbo caiu na mesma transação do bipe...
    expect(tx.pickOrder.update).toHaveBeenCalledWith({
      where: { id: CARD },
      data: { debitApprovedAt: null, debitApprovedBy: null },
    });
    // ...com auditoria no molde do reopenDebit...
    expect(tx.integrationLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event: 'debit.reopened' }),
      }),
    );
    // ...e a peça nova saiu do estoque uma vez.
    expect(tx.pickOrderScan.create).toHaveBeenCalled();
    expect(erp.applyStockDeltaInTx).toHaveBeenCalledWith(
      tx,
      [{ sku: 'PECA-NOVA', qty: 1, storeCode: '17' }],
      -1,
      expect.anything(),
    );
  });

  it('o guard procura baixa REAL de card nos dois eventos e ignora applied:[]', async () => {
    const { service, tx } = makeService({ debitApprovedAt: CARIMBO, baixaDeCardLog: null });
    await bipar(service);

    expect(tx.integrationLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source: 'erp',
          event: { in: ['debit.real.applied', 'debit.real.auto.applied'] },
          payload: { contains: `"pickOrderId":"${CARD}"` },
          NOT: { payload: { contains: '"applied":[]' } },
        }),
      }),
    );
  });

  it('recusa o bipe quando algum fechamento aplicou baixa em nível de card (dobraria estoque)', async () => {
    const { service, tx, erp } = makeService({
      debitApprovedAt: CARIMBO,
      baixaDeCardLog: { id: 55 },
    });

    await expect(bipar(service)).rejects.toBeInstanceOf(BadRequestException);
    await expect(bipar(service)).rejects.toThrow('dobraria a baixa');
    expect(tx.pickOrder.update).not.toHaveBeenCalled();
    expect(tx.pickOrderScan.create).not.toHaveBeenCalled();
    expect(erp.applyStockDeltaInTx).not.toHaveBeenCalled();
  });

  it('card sem carimbo segue o caminho normal, sem consultar o guard', async () => {
    const { service, tx } = makeService({ debitApprovedAt: null, baixaDeCardLog: null });

    const res = await bipar(service);

    expect(res.ok).toBe(true);
    expect(tx.integrationLog.findFirst).not.toHaveBeenCalled();
    expect(tx.pickOrder.update).not.toHaveBeenCalled();
  });

  it('bipe além do teto por SKU derruba a transação mesmo com o card reaberto', async () => {
    // A peça bipada NÃO era nova (teto já atingido): o teto lança depois da
    // reabertura, a transação inteira volta atrás e o carimbo continua lá.
    const { service, tx } = makeService({
      debitApprovedAt: CARIMBO,
      baixaDeCardLog: null,
      jaBipadosDoSku: 1,
    });

    await expect(bipar(service, 'PECA-VELHA')).rejects.toThrow('Já bipou 1 de 1');
    expect(tx.pickOrderScan.create).not.toHaveBeenCalled();
  });
});
