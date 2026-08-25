/**
 * A BUSCA DA TELA DE SEPARAÇÃO — as travas que faltavam em 25/08/2026.
 *
 * O defeito: a busca entrava como mais um `AND` junto da regra da ABA, então
 * procurar `ON-000126` estando em "Processando" devolvia ZERO — o pedido
 * existia, `separating`, do outro lado da mesma tela. E aba sem regra nativa
 * ("Pagto pendente", "Cancelados") nem chegava a consultar o banco.
 *
 * Estes testes prendem as três pontas do conserto:
 *   1. o que a busca procura (campos + terreno numérico com teto de Int32);
 *   2. a ida e a volta (`whereNativoDaAba` × `abaDoNativo`) não podem divergir;
 *   3. o rótulo de status que a linha mostra existe pra todo status vivo.
 */
import {
  filtroBuscaPedido,
  whereNativoDaAba,
  abaDoNativo,
  ROTULO_STATUS_LOCAL,
  STATUS_LOCAL_POR_ABA,
} from './orders.controller';

/** Os campos que o `OR` da busca cobre, achatados pra facilitar a asserção. */
function camposDe(where: Record<string, any>): string[] {
  return (where.OR as any[]).map((o) => Object.keys(o)[0]);
}

describe('filtroBuscaPedido — o que a matriz digita', () => {
  it('procura nº, nome, e-mail e rastreio em QUALQUER termo', () => {
    const campos = camposDe(filtroBuscaPedido('Erica'));
    expect(campos).toEqual(
      expect.arrayContaining(['wcOrderNumber', 'customerName', 'customerEmail', 'trackingCode']),
    );
  });

  it('o e-mail que o placeholder promete é REALMENTE consultado', () => {
    // Antes de 25/08 o campo dizia "nº do pedido, nome ou email" e a coluna
    // `customerEmail` não aparecia em lugar nenhum da query.
    expect(camposDe(filtroBuscaPedido('erica@teste.com'))).toContain('customerEmail');
  });

  it('telefone com máscara compara só os dígitos', () => {
    const w = filtroBuscaPedido('(11) 99894-1591');
    const tel = (w.OR as any[]).find((o) => o.customerPhone);
    expect(tel.customerPhone.contains).toBe('11998941591');
  });

  it('telefone NÃO estoura a coluna Int32 do wcOrderId', () => {
    // 11998941591 > 2.147.483.647: se virar filtro de `wcOrderId`, o Prisma
    // derruba a query inteira ("value is out of range for type integer") e a
    // busca por telefone responde 500.
    const w = filtroBuscaPedido('11998941591');
    const porId = (w.OR as any[]).find((o) => o.wcOrderId !== undefined);
    expect(porId).toBeUndefined();
  });

  it('nº interno de 9 dígitos vira busca por wcOrderId', () => {
    const w = filtroBuscaPedido('960000126');
    expect((w.OR as any[]).find((o) => o.wcOrderId !== undefined)?.wcOrderId).toBe(960000126);
  });

  it('termo COM letra não vaza os dígitos pro telefone', () => {
    // "ON-000126" tem "000126" dentro; casar isso com pedaço de telefone de
    // outra cliente é linha a mais na busca — alarme falso.
    const w = filtroBuscaPedido('ON-000126');
    expect((w.OR as any[]).some((o) => o.customerPhone)).toBe(false);
  });

  it('número curto digitado de cabeça não vira wcOrderId', () => {
    const w = filtroBuscaPedido('1265');
    expect((w.OR as any[]).some((o) => o.wcOrderId !== undefined)).toBe(false);
  });
});

describe('abaDoNativo — a volta bate com a ida', () => {
  const casos: Array<[string, string[], boolean, string | null]> = [
    // status,        cards,                 temRastreio, aba esperada
    ['processing', [], false, 'processing'],
    ['pending', [], false, 'processing'],
    ['awaiting_stock', [], false, 'processing'],
    ['routing', [], false, 'processing'],
    ['separating', ['new'], false, 'separacao'],
    ['separating', ['separating'], false, 'separacao'],
    ['separating', [], false, 'separacao'],
    ['separating', ['separated'], false, 'pronto-postar'],
    ['separating', ['separated', 'new'], false, 'separacao'],
    ['shipped', [], true, 'em-transito'],
    ['shipped', [], false, 'completed'],
    ['delivered', [], false, 'completed'],
    // Status que NENHUMA aba lista — a linha mostra o rótulo sem link.
    ['awaiting_payment', [], false, null],
    ['payment_failed', [], false, null],
    ['cancelled', [], false, null],
  ];

  it.each(casos)('%s (cards %j, rastreio %s) → aba %s', (status, cards, rastreio, esperada) => {
    expect(abaDoNativo(status, cards, new Date(), rastreio)).toBe(esperada);
  });

  it('shipped VELHO sai de "Em trânsito" e cai em "Concluídos"', () => {
    // Fora da janela de 30 dias os Correios não têm mais o que dizer — é a
    // mesma régua do `whereNativoDaAba('em-transito')`.
    const velho = new Date(Date.now() - 40 * 86_400_000);
    expect(abaDoNativo('shipped', [], velho, true)).toBe('completed');
  });

  it('a aba que a volta aponta EXISTE de verdade na ida', () => {
    const abas = new Set(
      casos.map(([, , , aba]) => aba).filter((a): a is string => !!a),
    );
    for (const aba of abas) expect(whereNativoDaAba(aba)).not.toBeNull();
  });
});

describe('ROTULO_STATUS_LOCAL — a linha nunca mostra código cru', () => {
  it('todo status que alguma aba lista tem rótulo humano', () => {
    const statusDasAbas = new Set(Object.values(STATUS_LOCAL_POR_ABA).flat());
    for (const st of statusDasAbas) {
      expect(ROTULO_STATUS_LOCAL[st]).toBeTruthy();
    }
  });

  it('os status que aba nenhuma lista também têm rótulo', () => {
    // São justamente os que só a busca alcança: sem rótulo, a matriz leria
    // "awaiting_payment" na tela.
    for (const st of ['awaiting_payment', 'payment_failed', 'cancelled', 'separating', 'shipped']) {
      expect(ROTULO_STATUS_LOCAL[st]).toBeTruthy();
    }
  });
});
