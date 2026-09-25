import { pecasDaLoja, totalDePecas } from './pecas-por-loja.util';

/**
 * Régua da mensagem de WhatsApp: cada loja recebe SÓ o que ela separa
 * (caso LP-001687, 25/09/2026 — 2 linhas do mesmo vestido, 1 pra Piracicaba
 * e 1 pra Praia Grande, e as duas lojas receberam as duas).
 */
const vestido = (extra: Record<string, any> = {}) => ({
  sku: '5410644',
  quantity: 1,
  productName: 'Vestido Manga Curta — VMM-225 · PRETO · 56',
  cor: 'PRETO',
  tamanho: '56',
  ...extra,
});

describe('pecasDaLoja — cada loja recebe SÓ o que ela separa', () => {
  it('LP-001687: mesmo SKU dividido 1+1 → cada loja vê UMA peça (carimbo do confirmRoute)', () => {
    const linhas = [vestido({ assignedStoreId: 'pira' }), vestido({ assignedStoreId: 'pg' })];
    const pira = pecasDaLoja(linhas, { storeId: 'pira', items: [{ sku: '5410644', quantity: 1 }] });
    const pg = pecasDaLoja(linhas, { storeId: 'pg', items: [{ sku: '5410644', quantity: 1 }] });
    expect(pira).toHaveLength(1);
    expect(pg).toHaveLength(1);
    expect(pira[0]).toMatchObject({ sku: '5410644', quantity: 1, variant: 'PRETO 56' });
    expect(totalDePecas(pira)).toBe(1);
  });

  it('sem carimbo (preview/mock): consome as linhas por SKU até a cota da loja', () => {
    const linhas = [vestido(), vestido(), vestido()];
    const a = pecasDaLoja(linhas, { storeId: 'a', items: [{ sku: '5410644', quantity: 2 }] });
    const b = pecasDaLoja(linhas, { storeId: 'b', items: [{ sku: '5410644', quantity: 1 }] });
    expect(totalDePecas(a)).toBe(2);
    expect(totalDePecas(b)).toBe(1);
  });

  it('cota lida também de `qty` (forçar loja / swap)', () => {
    const linhas = [vestido(), vestido()];
    const a = pecasDaLoja(linhas, { storeId: 'a', items: [{ sku: '5410644', qty: 1 }] });
    expect(totalDePecas(a)).toBe(1);
  });

  it('linha com quantidade maior que a cota da loja é cortada na cota', () => {
    const linhas = [vestido({ quantity: 3 })];
    const a = pecasDaLoja(linhas, { storeId: 'a', items: [{ sku: '5410644', quantity: 2 }] });
    expect(a).toEqual([expect.objectContaining({ sku: '5410644', quantity: 2 })]);
  });

  it('retirada na loja: pedido inteiro, mesmo com carimbo de outra loja', () => {
    const linhas = [
      vestido({ assignedStoreId: 'x' }),
      { sku: 'B', quantity: 1, productName: 'Blusa', cor: 'AZUL', tamanho: '50', assignedStoreId: 'x' },
    ];
    const r = pecasDaLoja(linhas, { storeId: 'y', items: [] }, { pedidoInteiro: true });
    expect(r).toHaveLength(2);
    expect(r[1]).toMatchObject({ sku: 'B', variant: 'AZUL 50' });
  });

  it('peça cancelada e linha de FRETE nunca entram (nem no pedido inteiro)', () => {
    const linhas = [
      vestido({ assignedStoreId: 'a' }),
      vestido({ assignedStoreId: 'a', cancelledAt: new Date() }),
      { sku: 'FRETE', ref: 'FRETE', quantity: 1, productName: 'Frete', assignedStoreId: 'a' },
    ];
    expect(pecasDaLoja(linhas, { storeId: 'a', items: [{ sku: '5410644', quantity: 1 }] })).toHaveLength(1);
    expect(pecasDaLoja(linhas, { storeId: 'a', items: [] }, { pedidoInteiro: true })).toHaveLength(1);
  });

  it('SKU que não é da loja fica de fora', () => {
    const linhas = [vestido(), { sku: 'B', quantity: 1, productName: 'Blusa' }];
    const r = pecasDaLoja(linhas, { storeId: 'a', items: [{ sku: 'B', quantity: 1 }] });
    expect(r).toEqual([expect.objectContaining({ sku: 'B', quantity: 1 })]);
  });

  it('loja sem nada (cota vazia e sem carimbo) → lista vazia, sem inventar peça', () => {
    expect(pecasDaLoja([vestido()], { storeId: 'a', items: [] })).toEqual([]);
  });
});
