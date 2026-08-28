import { RoutingEngine } from './routing.engine';
import { StoreInput, StockEntry } from './types';

/**
 * A LOJA VENDEDORA NÃO PODE CUSTAR UMA CAIXA A MAIS (28/08/2026).
 *
 * Caso real ON-000201, venda online do PDV de Moema (15), 15:03: a engine
 * mandou pra 4 lojas — Moema com UMA peça (223248-DUp PRETO 52) que Sorocaba
 * (3 un) e Campinas (2 un) tinham, e as duas entraram no plano do mesmo jeito.
 * Héllen e Elisa desfizeram na mão em 4 movimentos, entre 15:07 e 15:11.
 *
 * A semeadura de 17/08 continua valendo — o que mudou é que agora ela só fica
 * quando NÃO custa um pacote extra.
 */
const LOJAS: Array<[string, string, number]> = [
  ['01', 'ITANHAÉM', 1], ['02', 'SANTOS', 0.4], ['03', 'VINHEDO', 0.4], ['04', 'INDAIATUBA', 0],
  ['06', 'SOROCABA', 0.1], ['07', 'CAMPINAS', 0.5], ['10', 'JUNDIAÍ', 0.4], ['11', 'LIMEIRA', 0.4],
  ['14', 'PRAIA GRANDE', 0.5], ['15', 'Moema', 0.5], ['18', 'Anália Franca', 0],
];
const stores: StoreInput[] = LOJAS.map(([code, name, priorityScore]) => ({
  id: `id-${code}`, code, name, priorityScore, active: true,
}));

const A = '5276219', B = '11599357', C = '8000000004192';
const D = '11344766', E = '8000000004437', F = '8000000004031';

function montaStock(bruto: Record<string, Record<string, number>>): StockEntry[] {
  const out: StockEntry[] = [];
  for (const [sku, porLoja] of Object.entries(bruto)) {
    for (const [storeCode, availableQty] of Object.entries(porLoja)) out.push({ sku, storeCode, availableQty });
  }
  return out;
}

/** Estoque real do dia do incidente. */
const STOCK_201 = montaStock({
  [A]: { '01': 1, '02': 1, '04': 1, '07': 1, '11': 1, '14': 1, '18': 1 },
  [B]: { '02': 1, '04': 1, '06': 3, '07': 2, '10': 1, '11': 1, '14': 1, '15': 1, '18': 1 },
  [C]: { '01': 1, '02': 1, '03': 1, '04': 1, '07': 1 },
  [D]: { '01': 11, '03': 1 },
  [E]: { '02': 1, '04': 1, '07': 1, '14': 1 },
  [F]: { '06': 1 },
});
const ITENS_201 = [A, B, C, D, E, F].map((sku) => ({ sku, quantity: 1 }));

const rodar = (ctx: any) => new RoutingEngine().route(ctx);

describe('loja vendedora × número de pacotes', () => {
  it('ON-000201: Moema tinha 1 peça que Sorocaba e Campinas também tinham — sai do plano', () => {
    const r = rodar({ items: ITENS_201, stores, stock: STOCK_201, shippingCep: '18000000', sellerStoreCode: '15' });
    expect(r.success).toBe(true);
    expect(r.assignments.length).toBe(3);
    expect(r.assignments.map((a) => a.storeCode)).not.toContain('15');
    // a peça da Moema foi junto com quem já ia separar
    const dono = r.assignments.find((a) => a.items.some((i) => i.sku === B));
    expect(['06', '07']).toContain(dono!.storeCode);
  });

  it('todas as 6 peças continuam roteadas (não virou ruptura)', () => {
    const r = rodar({ items: ITENS_201, stores, stock: STOCK_201, shippingCep: '18000000', sellerStoreCode: '15' });
    expect(r.missing).toHaveLength(0);
    const roteados = new Set(r.assignments.flatMap((a) => a.items.map((i) => i.sku)));
    expect(roteados.size).toBe(6);
  });

  it('sem vendedora o plano é o mesmo — a semeadura era a única diferença', () => {
    const com = rodar({ items: ITENS_201, stores, stock: STOCK_201, shippingCep: '18000000', sellerStoreCode: '15' });
    const sem = rodar({ items: ITENS_201, stores, stock: STOCK_201, shippingCep: '18000000' });
    expect(com.assignments.map((a) => a.storeCode).sort()).toEqual(sem.assignments.map((a) => a.storeCode).sort());
  });

  it('17/08 PRESERVADO: vendedora com metade do pedido continua entrando', () => {
    // Ela cobre 3 de 4 SKUs; sem ela o plano não fica menor.
    const stock = montaStock({
      [A]: { '15': 1, '07': 1 },
      [B]: { '15': 1, '07': 1 },
      [C]: { '15': 1, '07': 1 },
      [D]: { '01': 1 },
    });
    const r = rodar({
      items: [A, B, C, D].map((sku) => ({ sku, quantity: 1 })),
      stores, stock, shippingCep: '18000000', sellerStoreCode: '15',
    });
    expect(r.assignments.map((a) => a.storeCode)).toContain('15');
    expect(r.assignments.find((a) => a.storeCode === '15')!.items).toHaveLength(3);
  });

  it('empate no número de pacotes mantém a vendedora (frete zero)', () => {
    // 15 tem A; 07 tem B. Duas lojas com ou sem semeadura.
    const stock = montaStock({ [A]: { '15': 1, '02': 1 }, [B]: { '07': 1 } });
    const r = rodar({
      items: [A, B].map((sku) => ({ sku, quantity: 1 })),
      stores, stock, shippingCep: '18000000', sellerStoreCode: '15',
    });
    expect(r.assignments.length).toBe(2);
    expect(r.assignments.map((a) => a.storeCode)).toContain('15');
  });

  it('loja FIXADA na mão manda sobre a heurística', () => {
    const r = rodar({
      items: ITENS_201, stores, stock: STOCK_201, shippingCep: '18000000',
      sellerStoreCode: '15', pinStoreCodes: ['15'],
    });
    expect(r.assignments.map((a) => a.storeCode)).toContain('15');
  });
});
