import { LinhaDoTempoService } from './linha-do-tempo.service';

/**
 * "SEM LOJA" TEM DOIS SIGNIFICADOS (27/08/2026 — flagra do dono no LP-000215).
 *
 * A tela mostrava a peça em VERMELHO com "Sem loja" e oferecia "cancelar e
 * devolver" tanto no pedido que ninguém roteou quanto no que a rede inteira
 * não tem. São decisões opostas: um precisa de "Gerar separação", o outro só
 * sai com 2º frete de outra loja ou devolvendo o dinheiro da peça.
 *
 * O dado pra separar os dois já existia — `routingResult` com `success:false`
 * e a lista `missing`, gravado por `confirmRoute`. Estes testes travam a
 * leitura dele.
 */
describe('Raio-X do pedido — por que a peça está sem loja', () => {
  const PECA = {
    id: 'item-1',
    sku: '11419396',
    ref: 'VSM-130',
    cor: 'ESTAMPA FOLHAS',
    tamanho: '46',
    quantity: 1,
    unitPrice: 119.9,
    assignedStoreId: null,
    cancelledAt: null,
  };

  const montar = (over: any = {}) => {
    const order: any = {
      id: 'order-1',
      wcOrderId: 950000215,
      status: 'awaiting_stock',
      trackingCode: null,
      routingResult: null,
      items: [PECA],
      pickOrders: [],
      history: [],
      ...over,
    };
    const prisma: any = {
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      pickOrderScan: { findMany: jest.fn().mockResolvedValue([]) },
      pickOrderItemReport: { findMany: jest.fn().mockResolvedValue([]) },
      realignmentShipment: { findMany: jest.fn().mockResolvedValue([]) },
      rastreioObjeto: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return new LinhaDoTempoService(prisma);
  };

  it('pedido que NINGUÉM roteou: amarelo, "aguardando separação" — não é ruptura', async () => {
    const service = montar();
    const r: any = await service.porWcOrderId(950000215);

    expect(r.pecas[0].estado).toBe('nao_roteado');
    expect(r.pecas[0].cor_semaforo).toBe('amarelo');
    expect(r.pecas[0].onde).toContain('aguardando separação');
    // Sem alarme de peça sem dono: não há nada de errado com o pedido ainda.
    expect(r.alertas.join(' ')).not.toContain('sem dono');
  });

  it('roteou e NENHUMA loja tem a peça: vermelho, com a hora da tentativa', async () => {
    const tentadoEm = '2026-08-24T19:46:28.000Z';
    const service = montar({
      routingResult: JSON.stringify({
        success: false,
        strategy: 'multi-store',
        assignments: [],
        missing: [{ sku: '11419396', productName: 'VSM-130 ESTAMPA FOLHAS 46', quantity: 1 }],
        tentadoEm,
      }),
    });
    const r: any = await service.porWcOrderId(950000215);

    expect(r.pecas[0].estado).toBe('sem_estoque_rede');
    expect(r.pecas[0].cor_semaforo).toBe('vermelho');
    expect(r.pecas[0].onde).toContain('NENHUMA LOJA DA REDE TEM ESTA PEÇA');
    expect(r.pecas[0].onde).toContain('24/08');
    // O alerta diz QUAL decisão existe, em vez de só mandar decidir.
    expect(r.alertas.join(' ')).toContain('2º frete');
  });

  it('ruptura sem `tentadoEm` (pedido roteado antes de 27/08) continua vermelha', async () => {
    const service = montar({
      routingResult: JSON.stringify({
        success: false,
        strategy: 'multi-store',
        assignments: [],
        missing: [{ sku: '11419396', productName: 'VSM-130', quantity: 1 }],
      }),
    });
    const r: any = await service.porWcOrderId(950000215);

    expect(r.pecas[0].estado).toBe('sem_estoque_rede');
    expect(r.pecas[0].onde).toContain('o roteamento tentou e não achou');
  });

  it('card cancelado pelo Recalcular (routingResult zerado) NÃO vira "não roteado"', async () => {
    // O `recalcular` limpa o routingResult mas deixa os cards cancelados —
    // aqui houve tentativa, então a peça sem dono continua vermelha.
    const service = montar({
      routingResult: null,
      pickOrders: [
        { id: 'p1', storeId: 's05', status: 'cancelled', createdAt: new Date(), store: { code: '05', name: 'PIRACICABA' } },
      ],
    });
    const r: any = await service.porWcOrderId(950000215);

    expect(r.pecas[0].estado).toBe('sem_dono');
    expect(r.pecas[0].cor_semaforo).toBe('vermelho');
  });

  /**
   * ON-000176 (27/08): card da MOEMA com a peça listada dentro e o raio-x
   * dizendo "sem loja" na MESMA tela. Em pedido de loja única o roteamento
   * não carimba `assignedStoreId` no item — o card assume implicitamente, e é
   * essa régua (a mesma do `listByWcOrderId`) que faltava aqui.
   */
  it('pedido de UMA loja: peça sem carimbo é da loja do card', async () => {
    const service = montar({
      routingResult: null,
      pickOrders: [
        { id: 'p1', storeId: 's15', status: 'new', createdAt: new Date(), isTransfer: false, transferToStoreCode: null, store: { code: '15', name: 'MOEMA' } },
      ],
    });
    const r: any = await service.porWcOrderId(950000215);

    expect(r.pecas[0].estado).toBe('com_loja');
    expect(r.pecas[0].storeName).toBe('MOEMA');
    expect(r.pecas[0].cor_semaforo).toBe('amarelo');
    expect(r.pecas[0].onde).toContain('MOEMA');
  });

  it('pedido de DUAS lojas sem carimbo: continua sem dono (não chuta loja)', async () => {
    const service = montar({
      routingResult: null,
      pickOrders: [
        { id: 'p1', storeId: 's15', status: 'new', createdAt: new Date(), store: { code: '15', name: 'MOEMA' } },
        { id: 'p2', storeId: 's05', status: 'new', createdAt: new Date(), store: { code: '05', name: 'PIRACICABA' } },
      ],
    });
    const r: any = await service.porWcOrderId(950000215);

    expect(r.pecas[0].estado).toBe('sem_dono');
    expect(r.pecas[0].storeCode).toBeNull();
  });

  it('JSON corrompido no routingResult não derruba o raio-x', async () => {
    const service = montar({ routingResult: '{isso não é json' });
    const r: any = await service.porWcOrderId(950000215);

    expect(r.found).not.toBe(false);
    expect(r.pecas).toHaveLength(1);
    // routingResult preenchido = houve tentativa, mesmo ilegível.
    expect(r.pecas[0].estado).toBe('sem_dono');
  });
});
