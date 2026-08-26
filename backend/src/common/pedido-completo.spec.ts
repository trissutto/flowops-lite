import { descreverPendentes, pecasPendentesDoPedido } from './pedido-completo';

/**
 * A RÉGUA DA PEÇA PENDENTE — "não deixar em hipótese alguma pedido concluído
 * com peça ainda em aguardando" (dono, 26/08).
 *
 * O cenário-mãe é o LP-000239: SOROCABA postou as 2 peças dela, a terceira
 * (reportada, sem dono) sumiu da conta porque quem fechava contava CARDS.
 */
describe('peças pendentes do pedido', () => {
  const item = (id: string, sku: string, extra: Partial<Parameters<typeof pecasPendentesDoPedido>[0]['items'][0]> = {}) => ({
    id,
    sku,
    ref: sku,
    quantity: 1,
    ...extra,
  });

  test('tudo enviado pelo card do dono: nada pendente', () => {
    expect(
      pecasPendentesDoPedido({
        items: [item('i1', 'A', { assignedStoreId: 's1' }), item('i2', 'B', { assignedStoreId: 's2' })],
        cards: [
          { storeId: 's1', status: 'shipped' },
          { storeId: 's2', status: 'delivered' },
        ],
      }),
    ).toEqual([]);
  });

  test('LP-000239: card da irmã shipped não fala pela peça sem dono', () => {
    const pendentes = pecasPendentesDoPedido({
      items: [
        item('i1', 'A', { assignedStoreId: 's-sorocaba' }),
        item('i2', 'B', { assignedStoreId: 's-sorocaba' }),
        item('i3', 'BMM-008', { assignedStoreId: null }),
      ],
      cards: [{ storeId: 's-sorocaba', status: 'shipped' }],
    });
    expect(pendentes).toHaveLength(1);
    expect(pendentes[0]).toMatchObject({ itemId: 'i3', motivo: 'sem_dono' });
  });

  test('report aberto marca a peça como reportada', () => {
    const pendentes = pecasPendentesDoPedido({
      items: [item('i1', 'A', { assignedStoreId: null })],
      cards: [],
      reportsAbertos: [{ orderItemId: 'i1' }],
    });
    expect(pendentes[0].motivo).toBe('reportada');
  });

  test('report aberto casa por SKU quando não tem orderItemId', () => {
    const pendentes = pecasPendentesDoPedido({
      items: [item('i1', 'A', { assignedStoreId: null })],
      cards: [],
      reportsAbertos: [{ sku: 'A' }],
    });
    expect(pendentes[0].motivo).toBe('reportada');
  });

  test('card do dono ainda aberto: aguardando_loja', () => {
    const pendentes = pecasPendentesDoPedido({
      items: [item('i1', 'A', { assignedStoreId: 's1' })],
      cards: [{ storeId: 's1', status: 'new' }],
    });
    expect(pendentes[0].motivo).toBe('aguardando_loja');
  });

  test('dono apontando pra card que não existe mais: sem_dono', () => {
    const pendentes = pecasPendentesDoPedido({
      items: [item('i1', 'A', { assignedStoreId: 's-fantasma' })],
      cards: [{ storeId: 's1', status: 'shipped' }],
    });
    expect(pendentes[0].motivo).toBe('sem_dono');
  });

  test('cancelada/creditada não conta; frete nunca conta', () => {
    expect(
      pecasPendentesDoPedido({
        items: [
          item('i1', 'A', { assignedStoreId: null, cancelledAt: new Date() }),
          item('i2', 'FRETE', { ref: 'FRETE', assignedStoreId: null }),
        ],
        cards: [],
      }),
    ).toEqual([]);
  });

  test('bipe de envio órfão cobre a peça sem dono (card apagado após postar)', () => {
    expect(
      pecasPendentesDoPedido({
        items: [item('i1', 'A', { assignedStoreId: null })],
        cards: [],
        bipesEnviadosPorSku: { A: 1 },
      }),
    ).toEqual([]);
  });

  test('bipe órfão não cobre duas peças com uma unidade só', () => {
    const pendentes = pecasPendentesDoPedido({
      items: [item('i1', 'A', { assignedStoreId: null }), item('i2', 'A', { assignedStoreId: null })],
      cards: [],
      bipesEnviadosPorSku: { A: 1 },
    });
    expect(pendentes).toHaveLength(1);
    expect(pendentes[0].itemId).toBe('i2');
  });

  test('descreverPendentes resume com motivo e trunca a lista', () => {
    const pendentes = pecasPendentesDoPedido({
      items: [
        item('i1', 'A', { cor: 'PRETO', tamanho: '50', assignedStoreId: null }),
        item('i2', 'B', { assignedStoreId: null }),
        item('i3', 'C', { assignedStoreId: null }),
        item('i4', 'D', { assignedStoreId: null }),
      ],
      cards: [],
    });
    const texto = descreverPendentes(pendentes, 2);
    expect(texto).toContain('A PRETO 50 (sem loja definida)');
    expect(texto).toContain('+2 peça(s)');
  });
});
