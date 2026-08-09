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

/**
 * A colecao e escolhida uma vez no cabecalho e aplicada somente nas REFs que
 * ainda nao foram conferidas. Produto recebido nunca e alterado no navegador.
 *
 * @template {{ conferido?: unknown, colecaoId?: string }} T
 * @param {T[]} items
 * @param {string} collectionId
 * @returns {T[]}
 */
export function applyPurchaseOrderCollection(items, collectionId) {
  return items.map((item) => (
    item.conferido ? item : { ...item, colecaoId: collectionId }
  ));
}

/**
 * Recupera a colecao do primeiro item classificado ao reabrir um pedido.
 *
 * @param {Array<{ colecaoId?: string }>} items
 */
export function getPurchaseOrderCollection(items) {
  return items.find((item) => item.colecaoId)?.colecaoId || '';
}
