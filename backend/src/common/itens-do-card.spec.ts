import { pecaDoCard, whereItensDoCard } from './itens-do-card';
import { pecasPendentesDoPedido } from './pedido-completo';

/**
 * CARD DE COMPLEMENTO (07/10 — ON-000600): São José postou 1 de 3 e as
 * outras duas estão na arara DELA. O card novo da mesma loja enxerga só as
 * peças novas; o antigo, só a que já saiu.
 */
describe('itens-do-card', () => {
  const SJC = 'sjc';
  const cardVelho = { id: 'velho', storeId: SJC };
  const cardNovo = { id: 'novo', storeId: SJC };
  const cards = [cardVelho, cardNovo, { id: 'moema', storeId: 'moema' }];

  const offWhite = { assignedStoreId: SJC, pickOrderId: 'velho' };
  const preto48 = { assignedStoreId: SJC, pickOrderId: 'novo' };
  const azul50 = { assignedStoreId: SJC, pickOrderId: 'novo' };

  it('cada card vê só as suas peças', () => {
    expect([offWhite, preto48, azul50].filter((i) => pecaDoCard(i, cardVelho, cards))).toEqual([offWhite]);
    expect([offWhite, preto48, azul50].filter((i) => pecaDoCard(i, cardNovo, cards))).toEqual([preto48, azul50]);
  });

  it('pedido normal (sem carimbo) segue a regra de sempre: peça da loja = peça do card', () => {
    expect(pecaDoCard({ assignedStoreId: SJC, pickOrderId: null }, cardVelho, [cardVelho])).toBe(true);
    expect(pecaDoCard({ assignedStoreId: 'outra', pickOrderId: null }, cardVelho, [cardVelho])).toBe(false);
  });

  it('carimbo velho que aponta pra card de OUTRA loja ou que não existe é ignorado', () => {
    expect(pecaDoCard({ assignedStoreId: SJC, pickOrderId: 'moema' }, cardNovo, cards)).toBe(true);
    expect(pecaDoCard({ assignedStoreId: SJC, pickOrderId: 'apagado' }, cardNovo, cards)).toBe(true);
  });

  it('where: sem outro card da loja é o filtro antigo, idêntico', () => {
    expect(whereItensDoCard({ id: 'velho', orderId: 'o', storeId: SJC }, [])).toEqual({
      orderId: 'o', assignedStoreId: SJC,
    });
  });

  it('where: com outro card, o OR mantém o NULL (NOT IN descartaria)', () => {
    expect(whereItensDoCard({ id: 'novo', orderId: 'o', storeId: SJC }, ['velho'])).toEqual({
      orderId: 'o',
      assignedStoreId: SJC,
      OR: [{ pickOrderId: null }, { pickOrderId: { notIn: ['velho'] } }],
    });
  });

  it('pedido NÃO fecha com a segunda caixa ainda na arara (ON-000600)', () => {
    const pend = pecasPendentesDoPedido({
      items: [
        { id: '1', sku: 'A', ref: '13131', cor: 'OFF WHITE', tamanho: '50', quantity: 1, assignedStoreId: SJC, pickOrderId: 'velho' },
        { id: '2', sku: 'B', ref: '13131', cor: 'PRETO', tamanho: '48', quantity: 1, assignedStoreId: SJC, pickOrderId: 'novo' },
      ],
      cards: [
        { id: 'velho', storeId: SJC, status: 'shipped' },
        { id: 'novo', storeId: SJC, status: 'new' },
      ],
    } as any);
    expect(pend).toHaveLength(1);
    expect(JSON.stringify(pend)).toMatch(/PRETO/);
  });
});
