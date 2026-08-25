/**
 * PEDIDO QUE JÁ SAIU NÃO VOLTA PRO FLUXO (25/08/2026, ordem do dono).
 *
 * O `PATCH /orders/wc/:id` aceitava qualquer status em qualquer ordem. Mandar
 * `separacao` num pedido **já despachado** fazia duas coisas, nenhuma com
 * trava: criava card novo nas lojas (peça postada voltando pra arara de alguém
 * procurar) e puxava o pedido de `shipped` de volta pra `separating`,
 * ressuscitando ele na fila da matriz.
 *
 * Caso que provou: **LP-000210**, 24/08. Concluído às 18:34, e às 18:46 estava
 * `separating` de novo com a nota default (`Status alterado pra separating pelo
 * Flow` = PATCH sem nota). Mesma família dos 22 relançamentos de 24/08 que
 * viraram separação fantasma pras lojas — o `confirmRoute` já recusava por lá,
 * e esta porta continuava aberta.
 *
 * ⚠️ A volta LEGÍTIMA existe e tem porta própria: "Recalcular separação"
 * (`POST /orders/wc/:id/recalculate-separation`), que CANCELA os cards antigos
 * antes de reabrir. Esta regra não vale lá — vale só pro status na mão, e
 * status na mão não desfaz postagem.
 */

/** Os status que a tela pede quando quer o pedido de volta na fila. */
const VOLTA_PRO_FLUXO = new Set(['separacao', 'em-separacao', 'processing']);

/** O pedido já saiu fisicamente — não existe mais o que separar. */
const JA_SAIU = new Set(['shipped', 'delivered']);

/**
 * A peça já saiu e estão pedindo pra separar de novo?
 *
 * @param statusAtual  status LOCAL do pedido (`orders.status`)
 * @param statusPedido o slug que a tela mandou no PATCH
 */
export function voltariaProFluxo(
  statusAtual: string | null | undefined,
  statusPedido: string | null | undefined,
): boolean {
  if (!statusAtual || !statusPedido) return false;
  return (
    JA_SAIU.has(String(statusAtual).trim().toLowerCase()) &&
    VOLTA_PRO_FLUXO.has(String(statusPedido).trim().toLowerCase())
  );
}

/** O texto que a tela mostra quando a trava pega — diz o porquê E a saída. */
export function motivoDaRecusa(statusAtual: string): string {
  const rotulo = statusAtual === 'delivered' ? 'ENTREGUE' : 'DESPACHADO';
  return (
    `Pedido já ${rotulo} — não dá pra mandar ele de volta pra separação. ` +
    `Isso abriria card novo nas lojas pra uma peça que já saiu. ` +
    `Se a peça precisa mesmo ser separada de novo, use "Recalcular separação" ` +
    `no pedido (ela cancela os cards antigos antes de reabrir).`
  );
}
