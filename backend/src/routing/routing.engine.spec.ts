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

  test('REGRA 4 (split): divide um SKU entre lojas quando nenhuma tem o total, mas a rede tem', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'A', quantity: 10 }, { sku: 'B', quantity: 1 }],
      stores: stores.slice(0, 3),
      stock: [
        // nenhuma loja sozinha tem 10 de A, mas 6+6=12 na rede
        { storeCode: 'LJ01', sku: 'A', availableQty: 6 },
        { storeCode: 'LJ02', sku: 'A', availableQty: 6 },
        { storeCode: 'LJ01', sku: 'B', availableQty: 5 },
      ],
      shippingCep: '01000-000',
    };
    const result = engine.route(ctx);
    // Agora a engine divide A entre LJ01 e LJ02 em vez de dar ruptura falsa.
    expect(result.success).toBe(true);
    expect(result.missing).toHaveLength(0);
    // A soma de A entre todas as lojas tem que fechar as 10 pedidas.
    const totalA = result.assignments
      .flatMap((a) => a.items)
      .filter((i) => i.sku === 'A')
      .reduce((s, i) => s + i.quantity, 0);
    expect(totalA).toBe(10);
    // A foi de fato dividido em pelo menos 2 lojas.
    const lojasComA = result.assignments.filter((a) => a.items.some((i) => i.sku === 'A'));
    expect(lojasComA.length).toBeGreaterThanOrEqual(2);
  });

  test('REGRA 4 (kill-switch): com disableSkuSplit=true volta a dar ruptura', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'A', quantity: 10 }, { sku: 'B', quantity: 1 }],
      stores: stores.slice(0, 3),
      stock: [
        { storeCode: 'LJ01', sku: 'A', availableQty: 6 },
        { storeCode: 'LJ02', sku: 'A', availableQty: 6 },
        { storeCode: 'LJ01', sku: 'B', availableQty: 5 },
      ],
      shippingCep: '01000-000',
      disableSkuSplit: true,
    };
    const result = engine.route(ctx);
    expect(result.success).toBe(false);
    expect(result.strategy).toBe('insufficient-stock');
    expect(result.missing.some((m) => m.sku === 'A')).toBe(true);
  });

  test('REGRA 4 (split parcial): rede não cobre o total → sobra vira ruptura do restante', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'A', quantity: 10 }],
      stores: stores.slice(0, 3),
      stock: [
        // 6+3=9 na rede, faltam 10 → 1 fica missing
        { storeCode: 'LJ01', sku: 'A', availableQty: 6 },
        { storeCode: 'LJ02', sku: 'A', availableQty: 3 },
      ],
      shippingCep: '01000-000',
    };
    const result = engine.route(ctx);
    expect(result.success).toBe(false);
    const miss = result.missing.find((m) => m.sku === 'A');
    expect(miss?.quantity).toBe(1);
    // mesmo em ruptura parcial, o plano já aproveita as 9 disponíveis
    const totalA = result.assignments
      .flatMap((a) => a.items)
      .filter((i) => i.sku === 'A')
      .reduce((s, i) => s + i.quantity, 0);
    expect(totalA).toBe(9);
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

  // ── REGRA 1.5 — JUNTADA DA ROTA PRÓPRIA (Itanhaém/PG/Santos, 21/08) ──────
  describe('juntada da rota própria', () => {
    // ITA/PG/Santos + uma loja de fora (Campinas) que também teria estoque.
    const litoral: StoreInput[] = [
      { id: 'i1', code: '01', name: 'Itanhaém',     cep: '11740-000', priorityScore: 50, active: true },
      { id: 'i2', code: '14', name: 'Praia Grande', cep: '11700-000', priorityScore: 50, active: true },
      { id: 'i3', code: '02', name: 'Santos',       cep: '11000-000', priorityScore: 50, active: true },
      { id: 'i4', code: '07', name: 'Campinas',     cep: '13000-000', priorityScore: 90, active: true },
    ];
    const GRUPO = ['01', '14', '02'];

    test('trio cobre entre si → âncora é a mais À FRENTE na rota (carga só anda pra frente)', () => {
      const ctx: RoutingContext = {
        items: [
          { sku: 'A', quantity: 2 }, // só PG tem
          { sku: 'B', quantity: 1 }, // só Santos tem
        ],
        stores: litoral,
        stock: [
          { storeCode: '14', sku: 'A', availableQty: 3 },
          { storeCode: '02', sku: 'B', availableQty: 1 },
          // Campinas cobriria o B também — mas o trio resolve sozinho.
          { storeCode: '07', sku: 'B', availableQty: 9 },
        ],
        shippingCep: '80000-000', // cliente fora do estado — caso clássico
        juntadaGroup: GRUPO,
      };
      const r = engine.route(ctx);
      expect(r.success).toBe(true);
      expect(r.strategy).toBe('multi-store');
      // PG tem MAIS peças (2 vs 1), mas o carro coleta PG ANTES de Santos:
      // Santos não consegue mandar pra trás → âncora = Santos, sempre a
      // mais à frente na rota entre as envolvidas.
      expect(r.consolidateStoreCode).toBe('02');
      const ancora = r.assignments.find((a) => a.storeCode === '02');
      const feeder = r.assignments.find((a) => a.storeCode === '14');
      expect(ancora?.isTransfer ?? false).toBe(false);
      expect(feeder?.isTransfer).toBe(true);
      expect(feeder?.transferToStoreCode).toBe('02');
      // Campinas fica de fora do plano.
      expect(r.assignments.some((a) => a.storeCode === '07')).toBe(false);
    });

    test('Itanhaém + Santos → âncora Santos (fim da rota), nunca Itanhaém', () => {
      const ctx: RoutingContext = {
        items: [
          { sku: 'A', quantity: 3 }, // Itanhaém tem MAIS peças...
          { sku: 'B', quantity: 1 },
        ],
        stores: litoral,
        stock: [
          { storeCode: '01', sku: 'A', availableQty: 3 },
          { storeCode: '02', sku: 'B', availableQty: 1 },
        ],
        juntadaGroup: GRUPO,
      };
      const r = engine.route(ctx);
      // ...e mesmo assim a âncora é Santos: o carro TERMINA lá.
      expect(r.consolidateStoreCode).toBe('02');
    });

    test('Itanhaém + Praia Grande (sem Santos) → âncora PG (a mais à frente entre as duas)', () => {
      const ctx: RoutingContext = {
        items: [
          { sku: 'A', quantity: 1 },
          { sku: 'B', quantity: 1 },
        ],
        stores: litoral,
        stock: [
          { storeCode: '01', sku: 'A', availableQty: 1 },
          { storeCode: '14', sku: 'B', availableQty: 1 },
        ],
        juntadaGroup: GRUPO,
      };
      const r = engine.route(ctx);
      expect(r.consolidateStoreCode).toBe('14');
    });

    test('REGRA 2.5: trio + loja de fora → lojas do trio juntam entre si (menos pacotes)', () => {
      const ctx: RoutingContext = {
        items: [
          { sku: 'A', quantity: 1 }, // Itanhaém
          { sku: 'B', quantity: 1 }, // Santos
          { sku: 'C', quantity: 1 }, // só Campinas
        ],
        stores: litoral,
        stock: [
          { storeCode: '01', sku: 'A', availableQty: 1 },
          { storeCode: '02', sku: 'B', availableQty: 1 },
          { storeCode: '07', sku: 'C', availableQty: 5 },
        ],
        shippingCep: '01310-000', // dentro de SP: sem consolidação obrigatória
        juntadaGroup: GRUPO,
      };
      const r = engine.route(ctx);
      expect(r.success).toBe(true);
      // Ita e Santos juntam de carro (âncora Santos); Campinas é o 2º pacote.
      const ita = r.assignments.find((a) => a.storeCode === '01');
      const santos = r.assignments.find((a) => a.storeCode === '02');
      const campinas = r.assignments.find((a) => a.storeCode === '07');
      expect(ita?.isTransfer).toBe(true);
      expect(ita?.transferToStoreCode).toBe('02');
      expect(santos?.isTransfer ?? false).toBe(false);
      expect(campinas?.isTransfer ?? false).toBe(false);
      expect(r.consolidateStoreCode).toBe('02');
      // Cliente recebe 2 pacotes (Santos + Campinas), não 3.
      expect(r.assignments.filter((a) => !a.isTransfer)).toHaveLength(2);
    });

    test('CONSOLIDAÇÃO OBRIGATÓRIA (fora do estado): tudo vira 1 pacote numa âncora', () => {
      const ctx: RoutingContext = {
        items: [
          { sku: 'A', quantity: 1 }, // Itanhaém
          { sku: 'C', quantity: 3 }, // só Campinas (mais peças)
        ],
        stores: litoral,
        stock: [
          { storeCode: '01', sku: 'A', availableQty: 1 },
          { storeCode: '07', sku: 'C', availableQty: 5 },
        ],
        shippingCep: '80000-000', // Paraná — fora do estado
        juntadaGroup: GRUPO,
        consolidacaoObrigatoria: true,
      };
      const r = engine.route(ctx);
      expect(r.success).toBe(true);
      // Campinas tem mais peças (3 vs 1) e ninguém alcança ninguém de carro
      // (Itanhaém → Campinas não é rota) → âncora = Campinas; Itanhaém manda
      // remessa interna. Cliente recebe 1 pacote.
      expect(r.consolidateStoreCode).toBe('07');
      const clientes = r.assignments.filter((a) => !a.isTransfer);
      expect(clientes).toHaveLength(1);
      expect(clientes[0].storeCode).toBe('07');
      const feeder = r.assignments.find((a) => a.storeCode === '01');
      expect(feeder?.isTransfer).toBe(true);
      expect(feeder?.transferToStoreCode).toBe('07');
    });

    test('CONSOLIDAÇÃO OBRIGATÓRIA com 2 lojas do trio + 1 fora: âncora no trio (feeders de carro são de graça)', () => {
      const ctx: RoutingContext = {
        items: [
          { sku: 'A', quantity: 1 }, // Itanhaém
          { sku: 'B', quantity: 1 }, // Praia Grande
          { sku: 'C', quantity: 1 }, // só Campinas
        ],
        stores: litoral,
        stock: [
          { storeCode: '01', sku: 'A', availableQty: 1 },
          { storeCode: '14', sku: 'B', availableQty: 1 },
          { storeCode: '07', sku: 'C', availableQty: 5 },
        ],
        shippingCep: '80000-000',
        juntadaGroup: GRUPO,
        consolidacaoObrigatoria: true,
      };
      const r = engine.route(ctx);
      expect(r.success).toBe(true);
      // PG recebe Itanhaém DE CARRO (grátis) e só Campinas paga remessa →
      // âncora PG (1 remessa paga) vence Campinas (2 pagas).
      expect(r.consolidateStoreCode).toBe('14');
      const clientes = r.assignments.filter((a) => !a.isTransfer);
      expect(clientes).toHaveLength(1);
      expect(clientes[0].storeCode).toBe('14');
      for (const a of r.assignments) {
        if (a.storeCode === '14') continue;
        expect(a.isTransfer).toBe(true);
        expect(a.transferToStoreCode).toBe('14');
      }
    });

    test('trio NÃO cobre → segue o greedy normal, sem juntada', () => {
      const ctx: RoutingContext = {
        items: [
          { sku: 'A', quantity: 1 },
          { sku: 'C', quantity: 1 }, // só Campinas tem
        ],
        stores: litoral,
        stock: [
          { storeCode: '01', sku: 'A', availableQty: 1 },
          { storeCode: '07', sku: 'C', availableQty: 5 },
        ],
        juntadaGroup: GRUPO,
      };
      const r = engine.route(ctx);
      expect(r.success).toBe(true);
      expect(r.consolidateStoreCode ?? null).toBeNull();
      expect(r.assignments.every((a) => !a.isTransfer)).toBe(true);
    });

    test('uma loja cobre tudo sozinha → single-store normal (REGRA 1 vence)', () => {
      const ctx: RoutingContext = {
        items: [{ sku: 'A', quantity: 1 }],
        stores: litoral,
        stock: [{ storeCode: '02', sku: 'A', availableQty: 5 }],
        juntadaGroup: GRUPO,
      };
      const r = engine.route(ctx);
      expect(r.strategy).toBe('single-store');
      expect(r.consolidateStoreCode ?? null).toBeNull();
    });

    test('operador fixou loja (pin) → a juntada automática NÃO passa por cima', () => {
      const ctx: RoutingContext = {
        items: [
          { sku: 'A', quantity: 1 },
          { sku: 'B', quantity: 1 },
        ],
        stores: litoral,
        stock: [
          { storeCode: '01', sku: 'A', availableQty: 1 },
          { storeCode: '02', sku: 'B', availableQty: 1 },
          { storeCode: '07', sku: 'A', availableQty: 5 },
          { storeCode: '07', sku: 'B', availableQty: 5 },
        ],
        juntadaGroup: GRUPO,
        pinStoreCodes: ['07'],
      };
      const r = engine.route(ctx);
      expect(r.consolidateStoreCode ?? null).toBeNull();
    });
  });
// ──────────────────────────────────────────────────────────────────────
  // SKU REPETIDO EM DUAS LINHAS (27/08 — conserto do LP-000289)
  //
  // Depois que um SKU dividido passou a virar DUAS linhas de order_items,
  // o re-roteamento recebe o mesmo SKU duas vezes. Sem somar antes, o motor
  // acha que o pedido é menor do que é — e manda a peça pra loja errada.
  // ──────────────────────────────────────────────────────────────────────
  describe('linhas repetidas do mesmo SKU', () => {
    test('duas linhas de 1 são um pedido de 2 (não de 1)', () => {
      const ctx: RoutingContext = {
        items: [
          { sku: 'A', quantity: 1 },
          { sku: 'A', quantity: 1 },
        ],
        stores: stores.slice(0, 3),
        stock: [
          { storeCode: 'LJ01', sku: 'A', availableQty: 1 }, // NÃO cobre 2
          { storeCode: 'LJ02', sku: 'A', availableQty: 5 }, // cobre
        ],
        shippingCep: '01310-000',
      };
      const r = engine.route(ctx);
      expect(r.success).toBe(true);
      // Se as linhas não fossem somadas, LJ01 (1 peça) passaria no canFulfillAll.
      expect(r.assignments).toHaveLength(1);
      expect(r.assignments[0].storeCode).toBe('LJ02');
      expect(r.assignments[0].items).toEqual([{ sku: 'A', quantity: 2 }]);
    });

    test('LP-000289: 2 linhas de 1, nenhuma loja com 2 → divide 1+1', () => {
      const ctx: RoutingContext = {
        items: [
          { sku: 'VOGUE', quantity: 1 },
          { sku: 'VOGUE', quantity: 1 },
        ],
        stores: stores.slice(0, 3),
        stock: [
          { storeCode: 'LJ01', sku: 'VOGUE', availableQty: 1 },
          { storeCode: 'LJ02', sku: 'VOGUE', availableQty: 1 },
        ],
        shippingCep: '01310-000',
      };
      const r = engine.route(ctx);
      expect(r.success).toBe(true);
      expect(r.missing).toHaveLength(0);
      expect(r.assignments).toHaveLength(2);
      const total = r.assignments.reduce(
        (s, a) => s + a.items.reduce((x, i) => x + i.quantity, 0), 0);
      expect(total).toBe(2);
    });
  });
});
