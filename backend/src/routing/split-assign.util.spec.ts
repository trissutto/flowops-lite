import { planSplitAssignment, temSkuDividido } from './split-assign.util';

/** Soma tudo que o plano deixa no pedido — a invariante que não pode quebrar. */
function totalDepois(rows: Array<{ id: string; quantity: number }>, plan: ReturnType<typeof planSplitAssignment>) {
  const porLinha = new Map(rows.map((r) => [r.id, r.quantity]));
  for (const u of plan.updates) porLinha.set(u.id, u.quantity);
  let total = 0;
  for (const q of porLinha.values()) total += q;
  for (const c of plan.creates) total += c.quantity;
  return total;
}

describe('planSplitAssignment', () => {
  it('LP-000289: 1 linha de qty 2 dividida entre 2 lojas vira 1+1', () => {
    const rows = [{ id: 'item-1', quantity: 2 }];
    const plan = planSplitAssignment(rows, [
      { storeId: 'piracicaba', quantity: 1 },
      { storeId: 'vinhedo', quantity: 1 },
    ]);

    // a linha original encolhe pra 1 e fica com a PRIMEIRA loja
    expect(plan.updates).toEqual([
      { id: 'item-1', quantity: 1, assignedStoreId: 'piracicaba' },
    ]);
    // o segundo pedaço vira linha nova na segunda loja
    expect(plan.creates).toEqual([
      { cloneOfRowId: 'item-1', quantity: 1, assignedStoreId: 'vinhedo' },
    ]);
    expect(plan.leftover).toBe(0);
    expect(totalDepois(rows, plan)).toBe(2);
  });

  it('loja única leva a linha inteira — não cria linha nenhuma', () => {
    const rows = [{ id: 'item-1', quantity: 3 }];
    const plan = planSplitAssignment(rows, [{ storeId: 'jundiai', quantity: 3 }]);

    expect(plan.updates).toEqual([
      { id: 'item-1', quantity: 3, assignedStoreId: 'jundiai' },
    ]);
    expect(plan.creates).toHaveLength(0);
    expect(plan.leftover).toBe(0);
  });

  it('divide 5 entre 3 lojas (2+2+1) preservando o total', () => {
    const rows = [{ id: 'item-1', quantity: 5 }];
    const plan = planSplitAssignment(rows, [
      { storeId: 'a', quantity: 2 },
      { storeId: 'b', quantity: 2 },
      { storeId: 'c', quantity: 1 },
    ]);

    expect(plan.updates).toEqual([{ id: 'item-1', quantity: 2, assignedStoreId: 'a' }]);
    expect(plan.creates).toEqual([
      { cloneOfRowId: 'item-1', quantity: 2, assignedStoreId: 'b' },
      { cloneOfRowId: 'item-1', quantity: 1, assignedStoreId: 'c' },
    ]);
    expect(totalDepois(rows, plan)).toBe(5);
  });

  it('pedido que JÁ tinha 2 linhas do mesmo SKU: cada linha vai pra uma loja, sem fatiar', () => {
    const rows = [
      { id: 'item-1', quantity: 1 },
      { id: 'item-2', quantity: 1 },
    ];
    const plan = planSplitAssignment(rows, [
      { storeId: 'a', quantity: 1 },
      { storeId: 'b', quantity: 1 },
    ]);

    expect(plan.updates).toEqual([
      { id: 'item-1', quantity: 1, assignedStoreId: 'a' },
      { id: 'item-2', quantity: 1, assignedStoreId: 'b' },
    ]);
    expect(plan.creates).toHaveLength(0);
    expect(plan.leftover).toBe(0);
  });

  it('linha atravessa duas demandas: qty 3 pra lojas de 1 e 2', () => {
    const rows = [{ id: 'item-1', quantity: 3 }];
    const plan = planSplitAssignment(rows, [
      { storeId: 'a', quantity: 1 },
      { storeId: 'b', quantity: 2 },
    ]);

    expect(plan.updates).toEqual([{ id: 'item-1', quantity: 1, assignedStoreId: 'a' }]);
    expect(plan.creates).toEqual([
      { cloneOfRowId: 'item-1', quantity: 2, assignedStoreId: 'b' },
    ]);
    expect(totalDepois(rows, plan)).toBe(3);
  });

  it('demanda menor que o pedido: o resto fica ÓRFÃO, não some', () => {
    const rows = [{ id: 'item-1', quantity: 3 }];
    const plan = planSplitAssignment(rows, [{ storeId: 'a', quantity: 1 }]);

    expect(plan.leftover).toBe(2);
    expect(plan.updates).toEqual([{ id: 'item-1', quantity: 1, assignedStoreId: 'a' }]);
    expect(plan.creates).toEqual([
      { cloneOfRowId: 'item-1', quantity: 2, assignedStoreId: null },
    ]);
    expect(totalDepois(rows, plan)).toBe(3);
  });

  it('sem demanda nenhuma: a linha inteira fica órfã (peça não evapora)', () => {
    const rows = [{ id: 'item-1', quantity: 2 }];
    const plan = planSplitAssignment(rows, []);

    expect(plan.leftover).toBe(2);
    expect(plan.updates).toEqual([{ id: 'item-1', quantity: 2, assignedStoreId: null }]);
    expect(plan.creates).toHaveLength(0);
    expect(totalDepois(rows, plan)).toBe(2);
  });

  it('demanda MAIOR que o pedido não inventa peça', () => {
    const rows = [{ id: 'item-1', quantity: 1 }];
    const plan = planSplitAssignment(rows, [
      { storeId: 'a', quantity: 1 },
      { storeId: 'b', quantity: 5 },
    ]);

    expect(plan.updates).toEqual([{ id: 'item-1', quantity: 1, assignedStoreId: 'a' }]);
    expect(plan.creates).toHaveLength(0);
    expect(totalDepois(rows, plan)).toBe(1);
  });

  it('ignora demanda zerada/sem loja', () => {
    const rows = [{ id: 'item-1', quantity: 2 }];
    const plan = planSplitAssignment(rows, [
      { storeId: '', quantity: 1 },
      { storeId: 'a', quantity: 0 },
      { storeId: 'b', quantity: 2 },
    ]);

    expect(plan.updates).toEqual([{ id: 'item-1', quantity: 2, assignedStoreId: 'b' }]);
    expect(plan.creates).toHaveLength(0);
    expect(plan.leftover).toBe(0);
  });
});

describe('temSkuDividido', () => {
  it('detecta SKU em mais de uma loja', () => {
    const m = new Map([
      ['sku-a', [{ storeId: 'x', quantity: 1 }]],
      ['sku-b', [{ storeId: 'x', quantity: 1 }, { storeId: 'y', quantity: 1 }]],
    ]);
    expect(temSkuDividido(m)).toBe(true);
  });

  it('pedido normal (cada SKU numa loja) não é divisão', () => {
    const m = new Map([
      ['sku-a', [{ storeId: 'x', quantity: 2 }]],
      ['sku-b', [{ storeId: 'y', quantity: 1 }]],
    ]);
    expect(temSkuDividido(m)).toBe(false);
  });
});
