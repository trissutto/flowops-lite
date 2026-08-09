/**
 * Decide se um item do pedido deve aparecer como a linha compacta da REF.
 * Itens pendentes nunca recolhem; itens conferidos recolhem por padrao.
 *
 * @param {boolean} conferido
 * @param {string | null} expandedItemId
 * @param {string} itemId
 */
export function isPurchaseOrderItemCollapsed(conferido, expandedItemId, itemId) {
  return conferido && expandedItemId !== itemId;
}

/**
 * Mantem o acordeao com no maximo uma referencia conferida aberta.
 * Clicar na referencia aberta fecha; clicar em outra troca a referencia aberta.
 *
 * @param {string | null} currentItemId
 * @param {string} clickedItemId
 * @returns {string | null}
 */
export function toggleExpandedPurchaseOrderItem(currentItemId, clickedItemId) {
  return currentItemId === clickedItemId ? null : clickedItemId;
}
