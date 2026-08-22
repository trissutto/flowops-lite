/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PEÇA PROMETIDA NÃO É PEÇA DISPONÍVEL  (22/08 — ordem do dono)
 *
 *  "No roteamento deve se levar em conta as peças pedidas na loja, pois
 *   enquanto a peça não é baixada ela pode ser pedida várias vezes."
 *
 *  O estoque só desce quando a loja BIPA a peça. Entre o card nascer e a
 *  vendedora bipar, `wincred_estoque` continua contando aquela peça — e o
 *  roteamento do pedido seguinte a via como livre e mandava OUTRO card pra
 *  mesma peça. A loja recebe dois pedidos, tem uma peça, e alguém descobre
 *  isso no balcão.
 *
 *  Aqui mora a conta do que está PROMETIDO, e o único jeito honesto de fazer
 *  ela é PENDENTE = esperado − o que já saiu no bipe:
 *
 *    - card com 11 peças e 5 bipadas → 5 já saíram do estoque; reservar as 11
 *      tiraria 16 peças de uma loja que só tem 11. Ruptura falsa, pedido preso
 *      na matriz — o efeito colateral clássico de "só ligar o anti-overbooking".
 *    - card com a baixa FECHADA (`debitApprovedAt`: matriz aprovou, ou card da
 *      live que nasceu já bipado) não reserva nada: o estoque já desceu.
 *    - peça que a loja reportou como "não achei" sai do card
 *      (`assignedStoreId = null`) e já foi baixada como fantasma — por isso a
 *      atribuição aqui é ESTRITA no `assignedStoreId`, sem chute pelo pedido.
 *
 *  Função PURA de propósito (o mesmo motivo do `routing.engine`): a regra é
 *  testável sem banco, e quem faz IO é a service.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface CommittedPickOrder {
  /** Só pra depuração/log — a conta não usa. */
  pickOrderId?: string;
  /** Loja do card (código, do jeito que o engine enxerga). */
  storeCode: string;
  /** Baixa já fechada (matriz aprovou / card nasceu bipado) → não reserva nada. */
  debitApproved?: boolean;
  /** Itens do pedido ATRIBUÍDOS a esta loja (`assignedStoreId`). */
  items: Array<{ sku: string; quantity: number }>;
  /** Peças deste card que JÁ saíram do estoque no bipe: sku → quantidade. */
  debited?: Map<string, number>;
}

/**
 * Soma o que cada loja já deve entregar e ainda não tirou do estoque.
 *
 * @returns Map com chave `${storeCode}::${sku}` → quantidade PROMETIDA.
 */
export function computeCommittedStock(
  cards: CommittedPickOrder[],
): Map<string, number> {
  const out = new Map<string, number>();

  for (const card of cards) {
    if (!card?.storeCode) continue;
    if (card.debitApproved) continue;

    const esperado = new Map<string, number>();
    for (const it of card.items ?? []) {
      const sku = String(it?.sku ?? '').trim();
      const qty = Number(it?.quantity) || 0;
      if (!sku || qty <= 0) continue;
      esperado.set(sku, (esperado.get(sku) ?? 0) + qty);
    }

    for (const [sku, qty] of esperado) {
      // O que ainda vai sair do estoque por causa deste card. Mesma conta do
      // `pendingDebitItems` do bipe — de propósito: se as duas divergirem, uma
      // das duas está reservando (ou baixando) peça que não existe.
      const pendente = qty - (card.debited?.get(sku) ?? 0);
      if (pendente <= 0) continue;
      const key = `${card.storeCode}::${sku}`;
      out.set(key, (out.get(key) ?? 0) + pendente);
    }
  }

  return out;
}
