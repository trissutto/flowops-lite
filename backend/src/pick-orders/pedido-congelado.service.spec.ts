import { BadRequestException } from '@nestjs/common';
import { PickOrdersService } from './pick-orders.service';
import { MOTIVO_CONGELADO } from '../common/pedido-congelado';

/**
 * PEDIDO REPORTADO VOLTA INTEIRO PRA MATRIZ (07/10 — ON-000600 da Katia).
 *
 * Trava o comportamento do congelamento no serviço: o que congela, o que
 * segue viagem, o que a loja ainda consegue fazer e como a matriz libera.
 */
describe('congelarRestoDoPedido — pedido reportado volta pra matriz', () => {
  const makeSvc = (cards: any[]) => {
    const svc = Object.create(PickOrdersService.prototype) as any;
    svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    svc.gateway = { emitPickOrderRemoved: jest.fn(), emitPickOrderToStore: jest.fn() };
    svc.prisma = {
      pickOrder: {
        findMany: jest.fn().mockResolvedValue(cards),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
      },
      order: { findUnique: jest.fn().mockResolvedValue({ status: 'separating' }) },
      orderHistory: { create: jest.fn().mockResolvedValue({}) },
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1' }) },
    };
    return svc;
  };

  const cards = [
    { id: 'jundiai', status: 'separating', issueReason: null, storeId: 's10', store: { code: '10' } },
    { id: 'santos', status: 'separated', issueReason: null, storeId: 's05', store: { code: '05' } },
    { id: 'moema', status: 'shipped', issueReason: null, storeId: 's07', store: { code: '07' } },
  ];

  test('reporte por peça: o card da loja e o das outras congelam; o postado segue', async () => {
    const svc = makeSvc(cards);
    const ids = await svc.congelarRestoDoPedido('o1', {
      origemId: 'jundiai', incluirOrigem: true, lojaQueReportou: '10', userId: 'u1',
    });
    expect(ids).toEqual(['jundiai', 'santos']);
    const upd = svc.prisma.pickOrder.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: { in: ['jundiai', 'santos'] }, issueReason: null });
    expect(upd.data.issueReason).toBe(MOTIVO_CONGELADO);
    // Saem da tela das duas lojas, não da que já postou.
    expect(svc.gateway.emitPickOrderRemoved).toHaveBeenCalledTimes(2);
    const nota = svc.prisma.orderHistory.create.mock.calls[0][0].data.note as string;
    expect(nota).toMatch(/PEDIDO CONGELADO/);
    // Loja congelada NÃO pode cair no "já negou este pedido" da tela.
    expect(nota).not.toMatch(/\bLoja\s+05\s+reportou\b/i);
  });

  test('reporte do card inteiro: a origem fica com o motivo verdadeiro', async () => {
    const svc = makeSvc(cards);
    const ids = await svc.congelarRestoDoPedido('o1', {
      origemId: 'jundiai', incluirOrigem: false, lojaQueReportou: '10', userId: 'u1',
    });
    expect(ids).toEqual(['santos']);
  });

  test('nada a congelar: não grava histórico', async () => {
    const svc = makeSvc([{ id: 'x', status: 'shipped', issueReason: null, storeId: 's', store: { code: '01' } }]);
    const ids = await svc.congelarRestoDoPedido('o1', {
      origemId: 'y', incluirOrigem: false, lojaQueReportou: '10', userId: null,
    });
    expect(ids).toEqual([]);
    expect(svc.prisma.orderHistory.create).not.toHaveBeenCalled();
  });

  test('falha no banco não derruba o reporte da loja', async () => {
    const svc = makeSvc(cards);
    svc.prisma.pickOrder.findMany.mockRejectedValue(new Error('boom'));
    await expect(
      svc.congelarRestoDoPedido('o1', { origemId: 'jundiai', incluirOrigem: true, lojaQueReportou: '10', userId: 'u1' }),
    ).resolves.toEqual([]);
    expect(svc.logger.error).toHaveBeenCalled();
  });

  test('matriz libera card congelado: volta pra fila da loja', async () => {
    const svc = makeSvc(cards);
    svc.prisma.pickOrder.findUnique
      .mockResolvedValueOnce({ id: 'santos', orderId: 'o1', storeId: 's05', status: 'separated', issueReason: MOTIVO_CONGELADO, store: { code: '05' } })
      .mockResolvedValueOnce({ id: 'santos' });
    const r = await svc.liberarCongelado('santos', { id: 'u1', name: 'Thiago' });
    expect(r).toEqual({ ok: true, pickOrderId: 'santos', storeCode: '05' });
    const upd = svc.prisma.pickOrder.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'santos', issueReason: MOTIVO_CONGELADO });
    expect(upd.data.issueReason).toBeNull();
    expect(svc.gateway.emitPickOrderToStore).toHaveBeenCalledWith('s05', { id: 'santos' });
  });

  test('liberar NÃO apaga reporte de verdade da loja', async () => {
    const svc = makeSvc(cards);
    svc.prisma.pickOrder.findUnique.mockResolvedValueOnce({
      id: 'jundiai', orderId: 'o1', storeId: 's10', status: 'new', issueReason: 'out_of_stock', store: { code: '10' },
    });
    await expect(svc.liberarCongelado('jundiai', { id: 'u1' })).rejects.toThrow(BadRequestException);
    expect(svc.prisma.pickOrder.updateMany).not.toHaveBeenCalled();
  });
});

describe('portas da loja recusam card congelado', () => {
  test('finalizar separação', async () => {
    const svc = Object.create(PickOrdersService.prototype) as any;
    svc.prisma = {
      pickOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p', storeId: 's', status: 'separating', orderId: 'o', issueReason: MOTIVO_CONGELADO,
        }),
      },
    };
    await expect(svc.finishSeparation('p', 's', 'u', [])).rejects.toThrow(/VOLTOU PRA MATRIZ/);
  });

  test('mudar status (postar / cliente retirou)', async () => {
    const svc = Object.create(PickOrdersService.prototype) as any;
    svc.prisma = {
      pickOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p', storeId: 's', status: 'separated', orderId: 'o', issueReason: MOTIVO_CONGELADO,
        }),
      },
    };
    await expect(
      svc.updateStatus('p', 's', 'u', { status: 'shipped', trackingCode: 'X', carrier: 'correios' }),
    ).rejects.toThrow(/VOLTOU PRA MATRIZ/);
  });

  test('gerar etiqueta', async () => {
    const svc = Object.create(PickOrdersService.prototype) as any;
    svc.prisma = {
      pickOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p', storeId: 's', status: 'separated', orderId: 'o', issueReason: MOTIVO_CONGELADO,
        }),
      },
    };
    await expect(svc.gerarEnvioCorreios('p', 's', 'u')).rejects.toThrow(/VOLTOU PRA MATRIZ/);
  });
});
