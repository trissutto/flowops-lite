import { computeCommittedStock } from './committed-stock.util';

describe('computeCommittedStock — peça prometida não é peça disponível', () => {
  it('reserva a peça do card que ainda não foi bipado', () => {
    const out = computeCommittedStock([
      { storeCode: '05', items: [{ sku: 'A', quantity: 1 }] },
    ]);
    expect(out.get('05::A')).toBe(1);
  });

  it('soma dois cards da MESMA loja pro mesmo SKU', () => {
    const out = computeCommittedStock([
      { storeCode: '05', items: [{ sku: 'A', quantity: 1 }] },
      { storeCode: '05', items: [{ sku: 'A', quantity: 2 }] },
    ]);
    expect(out.get('05::A')).toBe(3);
  });

  it('NÃO reserva o que já saiu no bipe (senão vira ruptura falsa)', () => {
    // Caso SJC: card de 11 peças, 5 bipadas. As 5 já sumiram do wincred_estoque.
    const out = computeCommittedStock([
      {
        storeCode: '08',
        items: [{ sku: 'A', quantity: 11 }],
        debited: new Map([['A', 5]]),
      },
    ]);
    expect(out.get('08::A')).toBe(6);
  });

  it('card todo bipado não reserva nada', () => {
    const out = computeCommittedStock([
      {
        storeCode: '08',
        items: [{ sku: 'A', quantity: 2 }],
        debited: new Map([['A', 2]]),
      },
    ]);
    expect(out.has('08::A')).toBe(false);
  });

  it('card com baixa fechada (debitApproved) não reserva — live já bipada', () => {
    const out = computeCommittedStock([
      { storeCode: '13', debitApproved: true, items: [{ sku: 'A', quantity: 3 }] },
    ]);
    expect(out.size).toBe(0);
  });

  it('bipe a MAIS que o esperado não vira reserva negativa', () => {
    const out = computeCommittedStock([
      {
        storeCode: '01',
        items: [{ sku: 'A', quantity: 1 }],
        debited: new Map([['A', 3]]),
      },
      { storeCode: '01', items: [{ sku: 'A', quantity: 2 }] },
    ]);
    // A sobra do primeiro card NÃO pode abater a reserva legítima do segundo.
    expect(out.get('01::A')).toBe(2);
  });

  it('separa por loja e por SKU', () => {
    const out = computeCommittedStock([
      {
        storeCode: '05',
        items: [
          { sku: 'A', quantity: 1 },
          { sku: 'B', quantity: 2 },
        ],
      },
      { storeCode: '07', items: [{ sku: 'A', quantity: 4 }] },
    ]);
    expect(out.get('05::A')).toBe(1);
    expect(out.get('05::B')).toBe(2);
    expect(out.get('07::A')).toBe(4);
  });

  it('card sem item atribuído (peça reportada saiu pra matriz) não reserva', () => {
    const out = computeCommittedStock([{ storeCode: '17', items: [] }]);
    expect(out.size).toBe(0);
  });

  it('ignora quantidade zerada/negativa e sku vazio', () => {
    const out = computeCommittedStock([
      {
        storeCode: '05',
        items: [
          { sku: 'A', quantity: 0 },
          { sku: '', quantity: 3 },
          { sku: 'B', quantity: -2 },
        ],
      },
    ]);
    expect(out.size).toBe(0);
  });
});
