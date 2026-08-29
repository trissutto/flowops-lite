import { BadRequestException } from '@nestjs/common';
import { PickOrdersService } from './pick-orders.service';
import { PickScanService } from './pick-scan.service';

/**
 * TRAVAS DO ENVIO + ESTORNO (29/08, sugestões nº 15 e 20 da revisão).
 *
 * As travas que seguram dinheiro moram no PickOrdersService/PickScanService e
 * até hoje só existiam protegidas por incidente ("quebrou → trava → fix").
 * Estes testes travam o comportamento pra próxima refatoração não derrubar:
 *
 *  - travarEnvioSemBipe: peça sem bipe NUNCA embarca (caso ON-000201) —
 *    inclusive peça que entrou no card DEPOIS do finish; card legado
 *    (bipes de navegador) passa; kill-switch desliga.
 *  - revertScansForSku: o estorno devolve UMA vez — segundo estorno do mesmo
 *    bipe não cria peça que não existe (é o caminho do cancelamento
 *    pós-envio e da troca de peça).
 */
describe('travarEnvioSemBipe — peça sem bipe não embarca', () => {
  const PICK = { id: 'pick-1', orderId: 'order-1', storeId: 'store-6', debitApprovedAt: null as Date | null };

  const makeSvc = (opts: {
    itens: Array<{ sku: string; quantity: number; ref?: string; cor?: string; tamanho?: string }>;
    scans: Array<{ sku: string }>;
    debitApprovedAt?: Date | null;
  }) => {
    const svc = Object.create(PickOrdersService.prototype);
    (svc as any).prisma = {
      orderItem: { findMany: jest.fn().mockResolvedValue(opts.itens) },
    };
    (svc as any).scans = {
      listActiveScans: jest.fn().mockResolvedValue(opts.scans),
    };
    return svc as any;
  };

  afterEach(() => {
    delete process.env.ENVIO_EXIGE_BIPE;
  });

  test('card 100% bipado passa', async () => {
    const svc = makeSvc({
      itens: [{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }],
      scans: [{ sku: 'A' }, { sku: 'B' }],
    });
    await expect(svc.travarEnvioSemBipe(PICK)).resolves.toBeUndefined();
  });

  test('peça que entrou DEPOIS do finish trava o envio (caso ON-000201)', async () => {
    const svc = makeSvc({
      // A calça 223248-DU chegou no card depois — 2 itens, 1 bipe.
      itens: [
        { sku: '11599357', quantity: 1, ref: '223248-DU', cor: 'PRETO', tamanho: '52' },
        { sku: '8000000004031', quantity: 1, ref: 'SMILE' },
      ],
      scans: [{ sku: '8000000004031' }],
    });
    await expect(svc.travarEnvioSemBipe(PICK)).rejects.toThrow(BadRequestException);
    await expect(svc.travarEnvioSemBipe(PICK)).rejects.toThrow(/223248-DU PRETO 52/);
  });

  test('quantidade parcial do MESMO SKU também trava (2 pedidas, 1 bipada)', async () => {
    const svc = makeSvc({
      itens: [{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 1 }],
      scans: [{ sku: 'A' }],
    });
    await expect(svc.travarEnvioSemBipe(PICK)).rejects.toThrow(/PEÇA SEM BIPE/);
  });

  test('card LEGADO (zero bipes no servidor + finish carimbado) passa', async () => {
    const svc = makeSvc({
      itens: [{ sku: 'A', quantity: 2 }],
      scans: [],
    });
    await expect(
      svc.travarEnvioSemBipe({ ...PICK, debitApprovedAt: new Date('2026-08-10') }),
    ).resolves.toBeUndefined();
  });

  test('zero bipes SEM carimbo de finish trava (não é legado, é pulo de etapa)', async () => {
    const svc = makeSvc({ itens: [{ sku: 'A', quantity: 1 }], scans: [] });
    await expect(svc.travarEnvioSemBipe(PICK)).rejects.toThrow(/PEÇA SEM BIPE/);
  });

  test('kill-switch ENVIO_EXIGE_BIPE=0 desliga a trava', async () => {
    process.env.ENVIO_EXIGE_BIPE = '0';
    const svc = makeSvc({ itens: [{ sku: 'A', quantity: 1 }], scans: [] });
    await expect(svc.travarEnvioSemBipe(PICK)).resolves.toBeUndefined();
  });

  test('card sem item atribuído não trava (nada a bipar)', async () => {
    const svc = makeSvc({ itens: [], scans: [] });
    await expect(svc.travarEnvioSemBipe(PICK)).resolves.toBeUndefined();
  });
});

describe('revertScansForSku — estorno devolve UMA vez (cancelamento/troca pós-bipe)', () => {
  const makeScanSvc = (scans: any[]) => {
    const updates: any[] = [];
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      pickOrderScan: {
        findMany: jest.fn().mockResolvedValue(scans),
        updateMany: jest.fn().mockImplementation((args: any) => {
          updates.push(args);
          return Promise.resolve({ count: (args.where?.id?.in ?? []).length });
        }),
      },
      pickOrder: { update: jest.fn().mockResolvedValue({}) },
      integrationLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const deltas: any[] = [];
    const svc = Object.create(PickScanService.prototype);
    (svc as any).prisma = {
      $transaction: jest.fn(async (cb: any) => cb(tx)),
      integrationLog: { create: jest.fn().mockResolvedValue({}) },
    };
    (svc as any).erp = {
      isWriteEnabled: true,
      applyStockDeltaInTx: jest.fn().mockImplementation((_tx: any, items: any[], sign: number) => {
        deltas.push({ items, sign });
        return Promise.resolve(items.map((i: any) => ({ ...i })));
      }),
    };
    (svc as any).logger = { log: jest.fn(), warn: jest.fn() };
    return { svc: svc as any, tx, deltas, updates };
  };

  test('estorna só o bipe BAIXADO e devolve +1 por peça', async () => {
    const { svc, deltas } = makeScanSvc([
      { id: 1, sku: 'A', storeCode: '06', stockDecreasedAt: new Date(), stockIncreasedAt: null },
    ]);
    const r = await svc.revertScansForSku('pick-1', 'A', 'troca', 'user-1');
    expect(r.pecas).toBe(1);
    // Devolução: UM delta positivo de 1 peça.
    expect(deltas).toHaveLength(1);
    expect(deltas[0].sign).toBe(1);
    expect(deltas[0].items).toEqual([expect.objectContaining({ sku: 'A', qty: 1, storeCode: '06' })]);
  });

  test('SEGUNDO estorno do mesmo bipe não devolve de novo (peça já voltou)', async () => {
    // O bipe já tem stockIncreasedAt — o filtro baixado-e-não-devolvido
    // deixa ele de fora do delta (só recebe o carimbo de revert).
    const { svc, deltas } = makeScanSvc([
      { id: 1, sku: 'A', storeCode: '06', stockDecreasedAt: new Date(), stockIncreasedAt: new Date() },
    ]);
    const r = await svc.revertScansForSku('pick-1', 'A', 'troca', 'user-1');
    expect(r.pecas).toBe(0);
    expect(deltas).toHaveLength(0);
  });

  test('bipe que rodou em shadow (nunca baixou) é carimbado mas não devolve estoque', async () => {
    const { svc, deltas } = makeScanSvc([
      { id: 1, sku: 'A', storeCode: '06', stockDecreasedAt: null, stockIncreasedAt: null },
    ]);
    const r = await svc.revertScansForSku('pick-1', 'A', 'cancelamento', null);
    expect(r.pecas).toBe(0);
    expect(deltas).toHaveLength(0);
  });

  test('sem bipe ativo do SKU: no-op', async () => {
    const { svc, deltas } = makeScanSvc([]);
    const r = await svc.revertScansForSku('pick-1', 'A', 'cancelamento', null);
    expect(r.pecas).toBe(0);
    expect(deltas).toHaveLength(0);
  });
});
