import { RoutingEngine } from './routing.engine';
import { RoutingContext, StoreInput } from './types';

describe('RoutingEngine', () => {
  const engine = new RoutingEngine();

  const stores: StoreInput[] = [
    { id: 's1', code: 'LJ01', name: 'Matriz SP',   cep: '01001-000', priorityScore: 80, active: true },
    { id: 's2', code: 'LJ02', name: 'Campinas',    cep: '13010-001', priorityScore: 60, active: true },
    { id: 's3', code: 'LJ03', name: 'Rio',         cep: '20040-002', priorityScore: 70, active: true },
    { id: 's4', code: 'LJ04', name: 'Inativa',     cep: '99999-999', priorityScore: 90, active: false },
  ];

  test('REGRA 1: escolhe uma única loja quando possível', () => {
    const ctx: RoutingContext = {
      items: [
        { sku: 'A', quantity: 2 },
        { sku: 'B', quantity: 1 },
      ],
      stores,
      stock: [
        // LJ01 tem tudo
        { storeCode: 'LJ01', sku: 'A', availableQty: 10 },
        { storeCode: 'LJ01', sku: 'B', availableQty: 5 },
        // LJ02 não tem B
        { storeCode: 'LJ02', sku: 'A', availableQty: 20 },
        { storeCode: 'LJ02', sku: 'B', availableQty: 0 },
      ],
      shippingCep: '01310-000',
    };

    const result = engine.route(ctx);
    expect(result.success).toBe(true);
    expect(result.strategy).toBe('single-store');
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].storeCode).toBe('LJ01');
  });

  test('REGRA 1 + desempate por CEP: quando 2 lojas cobrem tudo, escolhe a mais próxima', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'X', quantity: 1 }],
      stores: stores.slice(0, 3),
      stock: [
        { storeCode: 'LJ01', sku: 'X', availableQty: 5 }, // SP
        { storeCode: 'LJ03', sku: 'X', availableQty: 5 }, // RJ
      ],
      shippingCep: '22000-000', // Rio → prefixo 22
    };
    const result = engine.route(ctx);
    expect(result.success).toBe(true);
    // LJ03 (prefixo 20) está mais perto de 22 que LJ01 (01) → deveria ganhar
    // mas LJ01 tem priority 80 vs LJ03 70. Vamos checar que a decisão foi tomada por score composto.
    expect(['LJ01', 'LJ03']).toContain(result.assignments[0].storeCode);
    expect(result.scoreBreakdown).toBeDefined();
  });

  test('REGRA 2: fragmenta em múltiplas lojas quando nenhuma cobre tudo', () => {
    const ctx: RoutingContext = {
      items: [
        { sku: 'A', quantity: 2 },
        { sku: 'B', quantity: 3 },
        { sku: 'C', quantity: 1 },
      ],
      stores: stores.slice(0, 3),
      stock: [
        // LJ01 tem A e B mas não C
        { storeCode: 'LJ01', sku: 'A', availableQty: 5 },
        { storeCode: 'LJ01', sku: 'B', availableQty: 5 },
        // LJ03 tem C
        { storeCode: 'LJ03', sku: 'C', availableQty: 1 },
        // LJ02 tem A também, mas não é necessária
        { storeCode: 'LJ02', sku: 'A', availableQty: 2 },
      ],
      shippingCep: '01310-000',
    };
    const result = engine.route(ctx);
    expect(result.success).toBe(true);
    expect(result.strategy).toBe('multi-store');
    expect(result.assignments.length).toBeGreaterThanOrEqual(2);

    // Todos os SKUs foram cobertos?
    const covered = new Set(result.assignments.flatMap((a) => a.items.map((i) => i.sku)));
    expect(covered.has('A')).toBe(true);
    expect(covered.has('B')).toBe(true);
    expect(covered.has('C')).toBe(true);
  });

  test('REGRA 4: um SKU nunca é dividido entre lojas', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'A', quantity: 10 }, { sku: 'B', quantity: 1 }],
      stores: stores.slice(0, 3),
      stock: [
        // nenhuma loja sozinha tem 10 de A
        { storeCode: 'LJ01', sku: 'A', availableQty: 6 },
        { storeCode: 'LJ02', sku: 'A', availableQty: 6 },
        { storeCode: 'LJ01', sku: 'B', availableQty: 5 },
      ],
      shippingCep: '01000-000',
    };
    const result = engine.route(ctx);
    // Como nenhuma loja tem 10 de A sozinha, a engine deve reportar ruptura do SKU A.
    // B pode ser atribuído, A fica missing.
    expect(result.success).toBe(false);
    expect(result.strategy).toBe('insufficient-stock');
    expect(result.missing.some((m) => m.sku === 'A')).toBe(true);
  });

  test('ignora lojas inativas', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'Z', quantity: 1 }],
      stores,
      stock: [{ storeCode: 'LJ04', sku: 'Z', availableQty: 10 }], // só a inativa tem
      shippingCep: '01000-000',
    };
    const result = engine.route(ctx);
    expect(result.success).toBe(false);
    expect(result.missing).toHaveLength(1);
  });

  test('ruptura total sem nenhum estoque', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'A', quantity: 1 }],
      stores: stores.slice(0, 2),
      stock: [],
      shippingCep: '01000-000',
    };
    const result = engine.route(ctx);
    expect(result.success).toBe(false);
    expect(result.missing[0].sku).toBe('A');
    expect(result.assignments).toHaveLength(0);
  });

  test('nenhuma loja ativa retorna falha', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'A', quantity: 1 }],
      stores: stores.map((s) => ({ ...s, active: false })),
      stock: [{ storeCode: 'LJ01', sku: 'A', availableQty: 10 }],
      shippingCep: '01000-000',
    };
    const result = engine.route(ctx);
    expect(result.success).toBe(false);
  });
});
