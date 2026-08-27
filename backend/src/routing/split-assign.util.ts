/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SKU DIVIDIDO ENTRE LOJAS — QUEM GUARDA A DIVISÃO É A LINHA DO ITEM
 *  (27/08 — caso LP-000289)
 *
 *  A REGRA 4 do `routing.engine` divide um SKU entre lojas quando nenhuma tem
 *  a quantidade inteira (cliente pede 2, cada loja tem 1). A decisão saía
 *  certa no `routingResult`... e MORRIA na gravação:
 *
 *      for (const item of a.items)
 *        tx.orderItem.updateMany({ where: { orderId, sku }, ... })
 *
 *  `updateMany` filtra por SKU e ignora a QUANTIDADE. Como `order_items` tem
 *  UMA linha (qty=2) com UM `assignedStoreId` — e não existe tabela de item
 *  por card —, a segunda loja regravava a linha da primeira. O último a
 *  escrever ganhava:
 *
 *      PIRACICABA ×1 + VINHEDO ×1   →   linha inteira (qty 2) na VINHEDO
 *      → card da PIRACICABA VAZIO (nenhum item aponta pra ela)
 *      → card da VINHEDO pedindo 2 peças de uma loja que tem 1
 *
 *  E a loja que tinha a segunda peça na arara não fazia nada, enquanto a
 *  outra reportava "não temos" — o começo do carrossel de swap manual.
 *
 *  A CORREÇÃO: se o SKU foi dividido, a LINHA se divide junto. Uma linha de
 *  qty 2 vira duas linhas de qty 1, cada uma com seu `assignedStoreId`. Todo
 *  o resto do sistema (card, bipe, remove, swap, anti-overbooking, acerto
 *  ÷2,5) já lê por `assignedStoreId` e passa a funcionar sozinho.
 *
 *  INVARIANTE: a soma das quantidades daquele SKU no pedido NÃO MUDA. O que
 *  sobrar sem loja sai como `orphans` (o chamador zera o `assignedStoreId`) —
 *  peça nenhuma some no rateio, nem quando a demanda não fecha com as linhas.
 *
 *  Função PURA de propósito (mesmo motivo do `routing.engine` e do
 *  `committed-stock.util`): a regra é testável sem banco, e quem faz IO é a
 *  service.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Linha de `order_items` daquele SKU, como está no banco. */
export interface SplitRow {
  id: string;
  quantity: number;
}

/** Quanto daquele SKU cada loja ficou de separar (vem do `routingResult`). */
export interface SplitDemand {
  storeId: string;
  quantity: number;
}

export interface SplitPlan {
  /** Linhas existentes que mudam de quantidade e/ou de loja. */
  updates: Array<{ id: string; quantity: number; assignedStoreId: string | null }>;
  /** Linhas NOVAS (clones da original) pros pedaços seguintes da divisão. */
  creates: Array<{ cloneOfRowId: string; quantity: number; assignedStoreId: string | null }>;
  /**
   * Quantidade que sobrou sem loja — não deveria acontecer (`confirmRoute` só
   * grava com `missing: []`), mas se acontecer a peça continua existindo no
   * pedido, órfã, em vez de sumir. Aparece no log como sintoma.
   */
  leftover: number;
}

/**
 * Distribui as linhas de um SKU entre as lojas que ficaram de separá-lo.
 *
 * Consome linha por linha, na ordem recebida (o chamador ordena por `id` pra
 * o resultado ser determinístico entre execuções). Uma linha só é FATIADA
 * quando a demanda da loja atual é menor que ela — o caso comum (1 loja leva
 * a linha inteira) não cria linha nenhuma.
 */
export function planSplitAssignment(
  rows: SplitRow[],
  demands: SplitDemand[],
): SplitPlan {
  const plan: SplitPlan = { updates: [], creates: [], leftover: 0 };

  const fila = demands
    .map((d) => ({ storeId: d.storeId, resto: Math.max(0, Math.floor(Number(d.quantity) || 0)) }))
    .filter((d) => d.storeId && d.resto > 0);

  let di = 0;

  for (const row of rows) {
    const total = Math.max(0, Math.floor(Number(row.quantity) || 0));
    if (total <= 0) {
      // Linha zerada/inválida: não distribui nada, mas também não a deixa
      // apontando pra uma loja que não vai receber peça.
      plan.updates.push({ id: row.id, quantity: total, assignedStoreId: null });
      continue;
    }

    let restoLinha = total;
    let primeiroPedaco = true;

    while (restoLinha > 0 && di < fila.length) {
      const alvo = fila[di];
      const take = Math.min(restoLinha, alvo.resto);

      if (primeiroPedaco) {
        // O primeiro pedaço REAPROVEITA a linha original: sem divisão (take
        // === total) ela só é carimbada; com divisão, encolhe pro pedaço.
        plan.updates.push({ id: row.id, quantity: take, assignedStoreId: alvo.storeId });
        primeiroPedaco = false;
      } else {
        plan.creates.push({ cloneOfRowId: row.id, quantity: take, assignedStoreId: alvo.storeId });
      }

      restoLinha -= take;
      alvo.resto -= take;
      if (alvo.resto <= 0) di++;
    }

    if (restoLinha > 0) {
      // Acabou a demanda antes da linha: o resto vira peça SEM loja em vez de
      // evaporar (a soma do SKU no pedido não pode mudar).
      plan.leftover += restoLinha;
      if (primeiroPedaco) {
        plan.updates.push({ id: row.id, quantity: restoLinha, assignedStoreId: null });
      } else {
        plan.creates.push({ cloneOfRowId: row.id, quantity: restoLinha, assignedStoreId: null });
      }
    }
  }

  return plan;
}

/** `true` se algum SKU caiu em mais de uma loja — o caso que exige o rateio. */
export function temSkuDividido(demandsBySku: Map<string, SplitDemand[]>): boolean {
  for (const demands of demandsBySku.values()) {
    if (demands.length > 1) return true;
  }
  return false;
}
