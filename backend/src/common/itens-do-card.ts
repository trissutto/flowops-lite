/**
 * QUAIS PEÇAS SÃO DESTE CARD (07/10/2026 — caso ON-000600).
 *
 * Até aqui a resposta era só "as peças do pedido com `assignedStoreId` =
 * loja do card" — e por isso a mesma loja nunca podia ter dois cards no mesmo
 * pedido (caso ON-000106: o segundo card mostraria o que o primeiro já
 * postou). Isso travou o ON-000600: São José postou 1 de 3, as outras duas
 * peças estavam NA ARARA de São José, e a matriz não conseguia mandar a
 * segunda caixa por ela.
 *
 * CARD DE COMPLEMENTO: quando a loja ganha peça nova num pedido em que o card
 * dela JÁ POSTOU, nasce um card novo e as peças ganham dono por card em
 * `OrderItem.pickOrderId` (as já postadas → card antigo, as novas → card
 * novo). A regra:
 *
 *   peça é do card C  ⇔  peça.assignedStoreId = C.storeId
 *                        E (peça.pickOrderId é nulo
 *                           OU peça.pickOrderId = C.id
 *                           OU peça.pickOrderId não é de outro card da mesma
 *                              loja neste pedido)
 *
 * Pedido normal (um card por loja) nunca tem `pickOrderId` → o filtro extra
 * nem entra e o comportamento é EXATAMENTE o de antes.
 */

export type CardRef = { id: string; orderId: string; storeId: string };

/** Ids dos OUTROS cards da mesma loja no mesmo pedido. */
export async function outrosCardsDaLoja(db: any, card: CardRef): Promise<string[]> {
  const rows: Array<{ id: string }> = await db.pickOrder.findMany({
    where: { orderId: card.orderId, storeId: card.storeId, id: { not: card.id } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * `where` do Prisma pras peças do card. `outros` vazio (o caso de sempre) =
 * o filtro antigo, idêntico. ⚠️ O `OR` com `pickOrderId: null` é obrigatório:
 * `notIn` sozinho descarta o NULL no SQL (NULL NOT IN (...) não é verdadeiro).
 */
export function whereItensDoCard(card: CardRef, outros: string[]): Record<string, any> {
  const base: Record<string, any> = { orderId: card.orderId, assignedStoreId: card.storeId };
  if (!outros.length) return base;
  return { ...base, OR: [{ pickOrderId: null }, { pickOrderId: { notIn: outros } }] };
}

/** Atalho: busca os outros cards e devolve o `where`. */
export async function whereDoCard(db: any, card: CardRef): Promise<Record<string, any>> {
  return whereItensDoCard(card, await outrosCardsDaLoja(db, card));
}

/**
 * Versão em memória, pra quem já tem as peças e os cards do pedido na mão.
 * `cardsDoPedido` = todos os cards do pedido (qualquer loja).
 */
export function pecaDoCard(
  item: { assignedStoreId?: string | null; pickOrderId?: string | null },
  card: { id: string; storeId: string },
  cardsDoPedido: Array<{ id: string; storeId: string }>,
): boolean {
  if (!item.assignedStoreId || item.assignedStoreId !== card.storeId) return false;
  const dono = item.pickOrderId;
  if (!dono || dono === card.id) return true;
  // Aponta pra outro card: só perde se esse outro for da MESMA loja.
  return !cardsDoPedido.some((c) => c.id === dono && c.storeId === card.storeId);
}
