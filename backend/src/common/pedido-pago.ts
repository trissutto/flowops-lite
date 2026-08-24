/**
 * "Este pedido virou DINHEIRO?" — a régua dos relatórios de receita (24/08).
 *
 * Nasceu de uma medição: a tela `/retaguarda/campanhas` mostrava, no site novo
 * em 30 dias, **185 pedidos / R$ 38.489,41** — dos quais **40 pedidos /
 * R$ 9.524,83 (24,7%) NUNCA foram pagos**. A causa era uma letra: o filtro
 * excluía `'failed'`, mas o status que o site novo grava pra cartão recusado é
 * **`payment_failed`** (`loja-orders.service.ts`), que não casa com `'failed'`
 * e passava direto como receita.
 *
 * A ironia que denunciou o furo: `statusPublico()` mostra `payment_failed` pra
 * CLIENTE como **"cancelado"**. O mesmo pedido era cancelado pra ela e receita
 * pro relatório.
 *
 * ## Por que a régua tem DOIS degraus
 *
 * `paidAt` é o carimbo do dinheiro e seria o filtro ideal sozinho — mas ele só
 * existe nos trilhos NOVOS. Medido em 24/08 na base inteira:
 *
 * | source        | pedidos | com `paidAt` |
 * |---------------|--------:|-------------:|
 * | `site` (WC)   |  22.397 |       **0%** |
 * | `live`        |     204 |       **0%** |
 * | `ecommerce`   |     193 |        79,3% |
 * | `pdv_online`  |     102 |         100% |
 *
 * Exigir `paidAt` de todo mundo zeraria os 22.397 pedidos do WooCommerce —
 * trocaria um relatório inflado por um relatório vazio. Por isso:
 *
 *   1. status na lista de "não pagou" → NUNCA é receita (vale pra todo mundo);
 *   2. trilho que CARIMBA `paidAt` → o carimbo é obrigatório por cima disso.
 *
 * No `ecommerce` os dois degraus concordam 100% hoje (todo `separating`/
 * `shipped`/`delivered` tem carimbo; todo `awaiting_payment`/`payment_failed`
 * não tem). O degrau 2 é a rede de segurança pro dia em que não concordarem.
 */

/**
 * Status que provam que o pedido NÃO virou dinheiro.
 *
 * ⚠️ `payment_failed` e `awaiting_payment` são os que faltavam — juntos eram os
 * 24,7% de receita fantasma. `pending` são os 4 pedidos WooCommerce que
 * nasceram e nunca andaram (o mais velho de 25/04, sem `payment_info`).
 */
export const STATUS_SEM_PAGAMENTO: readonly string[] = [
  'cancelled',
  'canceled',
  'failed',
  'payment_failed',   // cartão RECUSADO — o site novo grava ASSIM, não 'failed'
  'awaiting_payment', // PIX/link gerado e nunca pago
  'pending',          // nasceu e nunca andou
];

/** Só CANCELAMENTO/estorno — pedido que foi pago e voltou atrás. */
export const STATUS_CANCELADO: readonly string[] = ['cancelled', 'canceled', 'failed'];

/**
 * Trilhos que CARIMBAM `paidAt` na hora que o dinheiro entra. Neles o carimbo
 * é obrigatório; fora deles não existe e não dá pra exigir.
 */
export const TRILHOS_COM_CARIMBO: readonly string[] = ['ecommerce', 'loja', 'pdv_online'];

export interface PedidoParaRegua {
  status?: string | null;
  paidAt?: Date | null;
  source?: string | null;
}

/** O pedido virou dinheiro? Único lugar que decide isso nos relatórios. */
export function pedidoPago(o: PedidoParaRegua | null | undefined): boolean {
  const status = String(o?.status ?? '').trim();
  if (!status) return false;
  if (STATUS_SEM_PAGAMENTO.includes(status)) return false;
  if (TRILHOS_COM_CARIMBO.includes(String(o?.source ?? ''))) return o?.paidAt != null;
  return true;
}

/** Foi cancelado/estornado (≠ "nunca pagou"). */
export function pedidoCancelado(o: PedidoParaRegua | null | undefined): boolean {
  return STATUS_CANCELADO.includes(String(o?.status ?? '').trim());
}

/**
 * Nunca virou dinheiro, mas TAMBÉM não foi cancelado: cartão recusado, PIX que
 * venceu, link que a cliente não abriu. É o balde que estava sendo contado como
 * receita — some do total, mas aparece na tela pra não virar buraco silencioso.
 */
export function pedidoNaoPago(o: PedidoParaRegua | null | undefined): boolean {
  return !pedidoPago(o) && !pedidoCancelado(o);
}

/**
 * A mesma régua em formato de `where` do Prisma, pronta pra compor.
 * Uso: `where: comPedidoPago({ ...seus filtros })` — nunca espalhe com spread,
 * porque a régua usa `AND`/`OR` e sobrescreveria os seus.
 */
export function comPedidoPago<T extends Record<string, any>>(where: T): Record<string, any> {
  return {
    AND: [
      where,
      { status: { notIn: [...STATUS_SEM_PAGAMENTO] } },
      { OR: [{ source: { notIn: [...TRILHOS_COM_CARIMBO] } }, { paidAt: { not: null } }] },
    ],
  };
}
