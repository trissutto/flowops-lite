import { decidirFechamento, descreverPendentes, pecasPendentesDoPedido } from './pedido-completo';

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

  /**
   * ON-000550 (07/10): duas linhas da MESMA regata (207333 OFF WHITE 56). Uma
   * movida pra Piracicaba, a outra SEM LOJA. Piracicaba bipou 1 e postou 1 —
   * o bipe dela provava a linha dela E a sem dono, e o pedido fechou.
   */
  test('ON-000550: um bipe prova UMA peça — a linha igual sem loja fica pendente', () => {
    const pendentes = pecasPendentesDoPedido({
      items: [
        item('sem-loja', '5390830', { assignedStoreId: null }),
        item('pira', '5390830', { assignedStoreId: 's-pira' }),
        item('preto', '5390748', { assignedStoreId: 's-vinhedo' }),
        item('bege', '5390809', { assignedStoreId: 's-vinhedo' }),
      ],
      cards: [
        { storeId: 's-pira', status: 'shipped' },
        { storeId: 's-vinhedo', status: 'shipped' },
      ],
      bipesEnviadosPorSku: { '5390830': 1, '5390748': 1, '5390809': 1 },
    });
    expect(pendentes.map((p) => p.itemId)).toEqual(['sem-loja']);
    expect(pendentes[0].motivo).toBe('sem_dono');
  });

  test('ON-000106 continua: bipe de card APAGADO depois de postar ainda prova a peça sem dono', () => {
    expect(
      pecasPendentesDoPedido({
        items: [item('i1', 'X', { assignedStoreId: null })],
        cards: [{ storeId: 's-outra', status: 'shipped' }],
        bipesEnviadosPorSku: { X: 1 },
      }),
    ).toEqual([]);
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

  /**
   * CAIXA DE FEEDER NÃO É ENVIO PRA CLIENTE (LP-001264, 26/09): Itanhaém
   * mandou 3 peças pra Santos, a matriz removeu o card de Santos e o pedido
   * ficou "Enviado" com as peças na prateleira de outra loja.
   */
  test('feeder postado sem card na âncora: peça presa na loja âncora', () => {
    const pendentes = pecasPendentesDoPedido({
      items: [item('i1', 'A', { assignedStoreId: 's-itanhaem' })],
      cards: [
        { storeId: 's-itanhaem', storeCode: '01', status: 'shipped', isTransfer: true, transferToStoreCode: '02' },
      ],
    });
    expect(pendentes).toHaveLength(1);
    expect(pendentes[0].motivo).toBe('na_loja_ancora');
    expect(descreverPendentes(pendentes)).toContain('na loja âncora');
  });

  test('feeder postado + âncora postada: peça enviada', () => {
    expect(
      pecasPendentesDoPedido({
        items: [item('i1', 'A', { assignedStoreId: 's-itanhaem' }), item('i2', 'B', { assignedStoreId: 's-santos' })],
        cards: [
          { storeId: 's-itanhaem', storeCode: '01', status: 'shipped', isTransfer: true, transferToStoreCode: '02' },
          { storeId: 's-santos', storeCode: '02', status: 'shipped', isTransfer: false },
        ],
      }),
    ).toEqual([]);
  });

  test('feeder postado com a âncora ainda separando: aguardando', () => {
    const pendentes = pecasPendentesDoPedido({
      items: [item('i1', 'A', { assignedStoreId: 's-itanhaem' })],
      cards: [
        { storeId: 's-itanhaem', storeCode: '01', status: 'shipped', isTransfer: true, transferToStoreCode: '02' },
        { storeId: 's-santos', storeCode: '02', status: 'separating', isTransfer: false },
      ],
    });
    expect(pendentes).toHaveLength(1);
    expect(pendentes[0].motivo).toBe('na_loja_ancora');
  });
});

/**
 * O PEDIDO FECHA AGORA? — a decisão única (26/09). Cenário-mãe: ON-000112, card
 * de Indaiatuba marcado `shipped` pelo cron da postagem em 25/08, pedido ainda
 * "Em separação" em 26/09 com a sacola na casa da cliente.
 */
describe('decidirFechamento', () => {
  const d = (s: string) => new Date(s);

  test('pedido já fechado não fecha de novo (nem reabre)', () => {
    for (const status of ['shipped', 'delivered', 'cancelled']) {
      expect(decidirFechamento({ status, cards: [{ status: 'shipped' }], pendentes: [] })).toEqual({
        fecha: false,
        motivo: 'ja_fechado',
      });
    }
  });

  test('sem card nenhum: fila da matriz, não desfecho', () => {
    expect(decidirFechamento({ status: 'separating', cards: [], pendentes: [] })).toEqual({
      fecha: false,
      motivo: 'sem_card',
    });
  });

  test('qualquer card ainda aberto segura o pedido', () => {
    for (const status of ['new', 'separating', 'separated', 'ready']) {
      expect(
        decidirFechamento({
          status: 'separating',
          cards: [{ status: 'shipped' }, { status }],
          pendentes: [],
        }),
      ).toEqual({ fecha: false, motivo: 'card_aberto' });
    }
  });

  test('peça pendente segura o pedido mesmo com tudo postado (ordem de 26/08)', () => {
    expect(
      decidirFechamento({
        status: 'separating',
        cards: [{ status: 'shipped' }],
        pendentes: [{ itemId: 'i', sku: 'A', rotulo: 'A', motivo: 'sem_dono' }],
      }),
    ).toEqual({ fecha: false, motivo: 'pendencia' });
  });

  test('ON-000112: tudo postado, nada pendente → shipped com a data do despacho, não de hoje', () => {
    const r = decidirFechamento({
      status: 'separating',
      cards: [{ status: 'shipped', carrier: 'Correios SEDEX', updatedAt: d('2026-08-25T16:00:00Z') }],
      pendentes: [],
      agora: d('2026-09-26T21:00:00Z'),
    });
    expect(r).toEqual({ fecha: true, como: 'shipped', despachoEm: d('2026-08-25T16:00:00Z') });
  });

  test('pedido dividido: o carimbo é o do ÚLTIMO card que entrega; o feeder não conta', () => {
    const r = decidirFechamento({
      status: 'separating',
      cards: [
        { status: 'shipped', isTransfer: true, updatedAt: d('2026-09-10T10:00:00Z') },
        { status: 'shipped', updatedAt: d('2026-09-04T18:15:00Z') },
        { status: 'shipped', updatedAt: d('2026-09-02T16:00:00Z') },
      ],
      pendentes: [],
    });
    expect(r).toMatchObject({ fecha: true, como: 'shipped', despachoEm: d('2026-09-04T18:15:00Z') });
  });

  test('retirada: "Cliente retirou" na loja que entrega fecha ENTREGUE', () => {
    const r = decidirFechamento({
      status: 'separating',
      isPickup: true,
      cards: [
        { status: 'shipped', isTransfer: true, carrier: 'Retirada', updatedAt: d('2026-09-21T13:00:00Z') },
        { status: 'shipped', carrier: 'Retirada', updatedAt: d('2026-09-22T14:00:00Z') },
      ],
      pendentes: [],
    });
    expect(r).toMatchObject({ fecha: true, como: 'delivered', despachoEm: d('2026-09-22T14:00:00Z') });
  });

  // LP-001652 (26/09): retirada em Sorocaba, peça vinda de Anália Franco, SEM
  // card na loja de retirada. O "📦 Enviei pra loja X" da origem (carrier
  // Retirada) fechava o pedido como ENTREGUE com a caixa ainda na origem.
  test('retirada só com card de TRANSFERÊNCIA (sem card na loja de retirada) fecha ENVIADO, não entregue', () => {
    const r = decidirFechamento({
      status: 'separating',
      isPickup: true,
      cards: [{ status: 'shipped', isTransfer: true, carrier: 'Retirada', updatedAt: d('2026-09-24T15:39:00Z') }],
      pendentes: [],
    });
    expect(r).toMatchObject({ fecha: true, como: 'shipped', despachoEm: d('2026-09-24T15:39:00Z') });
  });

  test('receptor VAZIO da loja de retirada com "Cliente retirou" entrega (feeder fechado antes não conta)', () => {
    const r = decidirFechamento({
      status: 'separating',
      isPickup: true,
      cards: [
        { status: 'shipped', isTransfer: true, carrier: 'Retirada', updatedAt: d('2026-09-24T15:39:00Z') },
        { status: 'shipped', carrier: 'Retirada', updatedAt: d('2026-09-26T13:10:00Z') },
      ],
      pendentes: [],
    });
    expect(r).toMatchObject({ fecha: true, como: 'delivered', despachoEm: d('2026-09-26T13:10:00Z') });
  });

  test('retirada com card final postado pelos Correios não vira entregue', () => {
    const r = decidirFechamento({
      status: 'separating',
      isPickup: true,
      cards: [{ status: 'shipped', carrier: 'Correios PAC', updatedAt: d('2026-09-22T14:00:00Z') }],
      pendentes: [],
    });
    expect(r).toMatchObject({ fecha: true, como: 'shipped' });
  });

  test('card cancelado é ignorado; sem carimbo nenhum, vale o agora', () => {
    const agora = d('2026-09-26T21:00:00Z');
    const r = decidirFechamento({
      status: 'processing',
      cards: [{ status: 'cancelled' }, { status: 'shipped' }],
      pendentes: [],
      agora,
    });
    expect(r).toEqual({ fecha: true, como: 'shipped', despachoEm: agora });
  });
});
