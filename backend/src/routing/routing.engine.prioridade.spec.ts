import { RoutingEngine } from './routing.engine';
import { RoutingContext, StoreInput } from './types';

/**
 * REGRAS 1 E 2 DO DONO (25/09/2026) — teste da separação automática.
 *   1. Franquia primeiro, SEMPRE — dentro do mesmo número de caixas.
 *   2. Indaiatuba (04) só quando nenhuma outra loja tem a peça.
 * Engine pura, sem mock — mesmo molde do routing.engine.spec.ts.
 */
const engine = new RoutingEngine();

const lojas: StoreInput[] = [
  { id: 's01', code: '01', name: 'ITANHAÉM', cep: '11740-000', priorityScore: 100, active: true, tipo: 'REDE' },
  { id: 's03', code: '03', name: 'VINHEDO', cep: '13280-000', priorityScore: 40, active: true, tipo: 'FILIAL' },
  { id: 's04', code: '04', name: 'INDAIATUBA', cep: '13330-000', priorityScore: 0, active: true, tipo: 'REDE' },
  { id: 's08', code: '08', name: 'SÃO JOSÉ DOS CAMPOS', cep: '12210-000', priorityScore: 60, active: true, tipo: 'FILIAL' },
];
const REGRAS = { franquiaPrimeiro: true, ultimoCasoStoreCodes: ['04'] };
const lojasDe = (r: { assignments: Array<{ storeCode: string }> }) => r.assignments.map((a) => a.storeCode).sort();

describe('REGRA 1 — franquia primeiro dentro do mesmo número de caixas', () => {
  it('loja própria com MUITO mais estoque perde pra franquia que também cobre em 1 caixa', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'A', quantity: 1 }],
      stores: lojas,
      stock: [
        { storeCode: '01', sku: 'A', availableQty: 10 },
        { storeCode: '03', sku: 'A', availableQty: 1 },
      ],
      shippingCep: '11740-000', // vizinho de Itanhaém: distância também perde
      ...REGRAS,
    };
    const r = engine.route(ctx);
    expect(r.strategy).toBe('single-store');
    expect(lojasDe(r)).toEqual(['03']);
  });

  it('franquia NÃO custa caixa a mais: loja própria fecha em 1, franquias só juntas em 2 → loja própria', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }],
      stores: lojas,
      stock: [
        { storeCode: '01', sku: 'A', availableQty: 1 },
        { storeCode: '01', sku: 'B', availableQty: 1 },
        { storeCode: '03', sku: 'A', availableQty: 5 },
        { storeCode: '08', sku: 'B', availableQty: 5 },
      ],
      ...REGRAS,
    };
    const r = engine.route(ctx);
    expect(r.strategy).toBe('single-store');
    expect(lojasDe(r)).toEqual(['01']);
  });

  it('no pedido dividido, entre lojas que cobrem o mesmo tanto, a franquia entra primeiro', () => {
    // A e B: ninguém cobre tudo. Itanhaém e Vinhedo cobrem A (Itanhaém com
    // mais estoque); só São José cobre B. Sem a regra, A ia pra Itanhaém.
    const ctx: RoutingContext = {
      items: [{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }],
      stores: lojas.filter((l) => l.code !== '04'),
      stock: [
        { storeCode: '01', sku: 'A', availableQty: 9 },
        { storeCode: '03', sku: 'A', availableQty: 1 },
        { storeCode: '08', sku: 'B', availableQty: 1 },
      ],
      ...REGRAS,
    };
    const r = engine.route(ctx);
    expect(r.success).toBe(true);
    expect(lojasDe(r)).toEqual(['03', '08']);
  });

  it('regra desligada: volta a valer o estoque (loja própria com mais peças ganha)', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'A', quantity: 1 }],
      stores: lojas,
      stock: [
        { storeCode: '01', sku: 'A', availableQty: 10 },
        { storeCode: '03', sku: 'A', availableQty: 1 },
      ],
      franquiaPrimeiro: false,
      ultimoCasoStoreCodes: ['04'],
    };
    expect(lojasDe(engine.route(ctx))).toEqual(['01']);
  });

  it('scoreBreakdown diz o tipo e o tier de cada loja (a UI explica por que a franquia ganhou)', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'A', quantity: 1 }],
      stores: lojas,
      stock: [{ storeCode: '03', sku: 'A', availableQty: 1 }],
      ...REGRAS,
    };
    const r = engine.route(ctx);
    const vinhedo = r.scoreBreakdown?.find((s) => s.storeCode === '03');
    const itanhaem = r.scoreBreakdown?.find((s) => s.storeCode === '01');
    expect(vinhedo?.tipo).toBe('FILIAL');
    expect(vinhedo?.tier).toBe(0);
    expect(itanhaem?.tier).toBe(1);
  });
});

describe('REGRA 2 — Indaiatuba só quando ninguém mais tem a peça', () => {
  it('Indaiatuba fecharia em 1 caixa, as outras precisam de 2 → vai pras outras mesmo assim', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }],
      stores: lojas,
      stock: [
        { storeCode: '04', sku: 'A', availableQty: 5 },
        { storeCode: '04', sku: 'B', availableQty: 5 },
        { storeCode: '01', sku: 'A', availableQty: 1 },
        { storeCode: '08', sku: 'B', availableQty: 1 },
      ],
      ...REGRAS,
    };
    const r = engine.route(ctx);
    expect(r.success).toBe(true);
    expect(r.strategy).toBe('multi-store');
    expect(lojasDe(r)).toEqual(['01', '08']);
  });

  it('Indaiatuba entra SÓ pro SKU que ninguém mais tem; o resto continua sem ela', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }],
      stores: lojas,
      stock: [
        { storeCode: '04', sku: 'A', availableQty: 5 }, // A: Indaiatuba tem, mas Itanhaém também
        { storeCode: '04', sku: 'B', availableQty: 5 }, // B: só Indaiatuba
        { storeCode: '01', sku: 'A', availableQty: 1 },
      ],
      ...REGRAS,
    };
    const r = engine.route(ctx);
    expect(r.success).toBe(true);
    const de04 = r.assignments.find((a) => a.storeCode === '04');
    const de01 = r.assignments.find((a) => a.storeCode === '01');
    expect(de04?.items).toEqual([{ sku: 'B', quantity: 1 }]);
    expect(de01?.items).toEqual([{ sku: 'A', quantity: 1 }]);
  });

  it('ruptura de verdade continua ruptura (nem Indaiatuba tem)', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'Z', quantity: 1 }],
      stores: lojas,
      stock: [{ storeCode: '04', sku: 'A', availableQty: 5 }],
      ...REGRAS,
    };
    const r = engine.route(ctx);
    expect(r.success).toBe(false);
    expect(r.strategy).toBe('insufficient-stock');
  });

  it('cliente RETIRA em Indaiatuba: a loja de retirada não é "último caso" (pickup-lock lá)', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'A', quantity: 1 }],
      stores: lojas,
      stock: [
        { storeCode: '04', sku: 'A', availableQty: 1 },
        { storeCode: '01', sku: 'A', availableQty: 1 },
      ],
      pickupStoreCode: '04',
      ...REGRAS,
    };
    const r = engine.route(ctx);
    expect(r.strategy).toBe('pickup-lock');
    expect(lojasDe(r)).toEqual(['04']);
  });

  it('operador FIXOU/preferiu Indaiatuba: a escolha dele manda', () => {
    const base: RoutingContext = {
      items: [{ sku: 'A', quantity: 1 }],
      stores: lojas,
      stock: [
        { storeCode: '04', sku: 'A', availableQty: 1 },
        { storeCode: '01', sku: 'A', availableQty: 1 },
      ],
      ...REGRAS,
    };
    expect(lojasDe(engine.route({ ...base, preferStoreCode: '04' }))).toEqual(['04']);
    expect(lojasDe(engine.route({ ...base, pinStoreCodes: ['04'] }))).toEqual(['04']);
  });

  it('lista vazia desliga a regra: Indaiatuba disputa como qualquer loja', () => {
    const ctx: RoutingContext = {
      items: [{ sku: 'A', quantity: 1 }],
      stores: lojas.filter((l) => l.code === '04' || l.code === '01'),
      stock: [
        { storeCode: '04', sku: 'A', availableQty: 9 },
        { storeCode: '01', sku: 'A', availableQty: 1 },
      ],
      franquiaPrimeiro: true,
      ultimoCasoStoreCodes: [],
    };
    expect(lojasDe(engine.route(ctx))).toEqual(['04']);
  });
});
