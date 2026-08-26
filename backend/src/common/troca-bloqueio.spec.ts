import { cardDaPeca, motivoDeBloqueioDaTroca } from './troca-bloqueio';

/**
 * A TRAVA DA TROCA — testes da régua que decide se ESTA peça ainda pode ser
 * trocada.
 *
 * Os dois erros doem: soltar demais manda a loja procurar na arara uma peça
 * que mudou (ou deixa a NF-e mentindo); travar demais deixa a matriz sem
 * saída depois de já ter combinado a troca com a cliente no WhatsApp — foi o
 * que aconteceu no LP-000239 e é o caso 'pedido dividido' aqui embaixo.
 */
describe('pode trocar esta peça?', () => {
  const loja = (code: string, name: string) => ({ code, name });
  const card = (id: string, status: string, storeId: string, code: string, name: string) => ({
    id,
    status,
    storeId,
    store: loja(code, name),
  });

  const aberto = {
    orderStatus: 'separating',
    card: card('card-1', 'new', 'store-1', '01', 'ITANHAÉM'),
    bipesDaPeca: 0,
  };

  test('pedido em separação, card da peça ainda "new": pode trocar', () => {
    expect(motivoDeBloqueioDaTroca(aberto)).toBeNull();
  });

  test('peça que nenhuma loja pegou (sem card): pode trocar', () => {
    expect(motivoDeBloqueioDaTroca({ orderStatus: 'awaiting_stock', card: null, bipesDaPeca: 0 })).toBeNull();
  });

  test.each(['shipped', 'delivered', 'cancelled'])('pedido %s: não troca mais', (orderStatus) => {
    expect(motivoDeBloqueioDaTroca({ ...aberto, orderStatus })).toMatch(/portal de trocas|devolução/);
  });

  test('card DELA já separado: manda pra devolução, dizendo a loja', () => {
    const motivo = motivoDeBloqueioDaTroca({
      ...aberto,
      card: card('card-1', 'separated', 'store-1', '01', 'ITANHAÉM'),
    });
    expect(motivo).toContain('ITANHAÉM');
    expect(motivo).toMatch(/separação/);
  });

  test('card DELA já postado: fala em postagem, não em separação', () => {
    const motivo = motivoDeBloqueioDaTroca({
      ...aberto,
      card: card('card-1', 'shipped', 'store-1', '01', 'ITANHAÉM'),
    });
    expect(motivo).toMatch(/postou/);
  });

  test('bipe DELA trava (a peça saiu do estoque no bipe)', () => {
    expect(motivoDeBloqueioDaTroca({ ...aberto, bipesDaPeca: 1 })).toMatch(/bipou/);
  });

  test('NF-e do card DELA trava, com o número na mensagem', () => {
    expect(
      motivoDeBloqueioDaTroca({ ...aberto, notaAutorizada: { numero: 689 } }),
    ).toContain('689');
  });

  /**
   * O CASO QUE ORIGINOU A REGRA (LP-000239, 26/08): SOROCABA bipou, emitiu a
   * NF-e 689 e postou as DUAS peças dela; a terceira (BMM-008 PRETO 50) não
   * existia em loja nenhuma e continuava no card "new" de ITANHAÉM. A cliente
   * combinou trocar por LARANJA e o sistema recusou por causa da SOROCABA.
   */
  test('pedido dividido: irmã já postou a peça DELA — esta aqui continua trocável', () => {
    const cards = [
      card('card-sorocaba', 'shipped', 'store-06', '06', 'SOROCABA'),
      card('card-itanhaem', 'new', 'store-01', '01', 'ITANHAÉM'),
    ];
    const peca = { assignedStoreId: 'store-01' };
    const dela = cardDaPeca(cards, peca);
    expect(dela?.id).toBe('card-itanhaem');
    expect(
      motivoDeBloqueioDaTroca({ orderStatus: 'separating', card: dela, bipesDaPeca: 0 }),
    ).toBeNull();
  });

  describe('de quem é a peça', () => {
    const cards = [
      card('card-a', 'new', 'store-a', '01', 'ITANHAÉM'),
      card('card-b', 'shipped', 'store-b', '06', 'SOROCABA'),
    ];

    test('segue o assignedStoreId', () => {
      expect(cardDaPeca(cards, { assignedStoreId: 'store-b' })?.id).toBe('card-b');
    });

    test('peça sem loja num pedido de VÁRIOS cards: de ninguém (não trava)', () => {
      expect(cardDaPeca(cards, { assignedStoreId: null })).toBeNull();
    });

    test('peça sem loja num pedido de UM card só: é dele (mesmo critério do card da loja)', () => {
      expect(cardDaPeca([cards[0]], { assignedStoreId: null })?.id).toBe('card-a');
    });

    test('loja atribuída sem card correspondente: de ninguém', () => {
      expect(cardDaPeca(cards, { assignedStoreId: 'store-z' })).toBeNull();
    });
  });
});
