/**
 * PEDIDO REPORTADO VOLTA INTEIRO PRA MATRIZ (07/10/2026 — ordem do dono,
 * caso ON-000600 da Katia).
 *
 * O combinado era: "se por algum motivo alguma peça do pedido for reportada,
 * o pedido inteiro volta para a matriz resolver". O código não fazia isso:
 *  - o "Não achei essa peça" (reporte POR PEÇA) tirava só aquela peça e o
 *    card seguia com o resto — a loja finalizava e postava;
 *  - o "Reportar problema" (card inteiro) tirava só o card daquela loja — os
 *    cards das OUTRAS lojas do pedido dividido seguiam separando e postando.
 * A frase "pedido com problema volta pra matriz" só existia no texto do
 * histórico da separação automática.
 *
 * Agora qualquer reporte CONGELA o pedido: todo card que AINDA NÃO SAIU
 * (new/separating/separated/ready) ganha `issueReason = 'pedido_congelado'`.
 * É o mesmo mecanismo do card reportado — some da fila da loja, a matriz vê
 * o alarme vermelho — mas com um motivo próprio, porque essa loja NÃO negou
 * nada: o Recalcular não pode excluí-la como se tivesse dito "não tenho".
 *
 * Caixa que JÁ FOI POSTADA (`shipped`) segue viagem — decisão do dono:
 * "o pedido que não foi ainda volta para a matriz".
 *
 * A saída da matriz: re-rotear (Recalcular / Trocar loja), dar crédito ou
 * reembolso pela peça, e "Liberar" o card congelado quando o resto pode ir.
 */

export const MOTIVO_CONGELADO = 'pedido_congelado';

export const LABEL_CONGELADO = 'Pedido congelado — outra loja reportou; aguardando a matriz';

/** Status de card que ainda não saiu da loja — é o que congela. */
export const STATUS_CONGELAVEIS = ['new', 'separating', 'separated', 'ready'] as const;

export type CardDoPedido = {
  id: string;
  status: string;
  issueReason?: string | null;
};

/**
 * Quais cards do pedido congelam quando um deles é reportado.
 *  - `origemId`: o card de onde veio o reporte.
 *  - `incluirOrigem`: no reporte POR PEÇA o card da loja continua ativo com
 *    o resto das peças — ele também congela. No reporte do card inteiro ele
 *    já ganhou o motivo verdadeiro (`out_of_stock` etc.) e fica de fora.
 * Card já com problema (de verdade ou congelado) não é tocado: o motivo
 * verdadeiro de outra loja não pode ser sobrescrito.
 */
export function cardsACongelar(
  cards: CardDoPedido[],
  opts: { origemId: string; incluirOrigem: boolean },
): string[] {
  return cards
    .filter((c) => (STATUS_CONGELAVEIS as readonly string[]).includes(String(c.status)))
    .filter((c) => !c.issueReason)
    .filter((c) => opts.incluirOrigem || c.id !== opts.origemId)
    .map((c) => c.id);
}

/**
 * A loja deste card NEGOU alguma coisa? Só reporte de verdade conta — o card
 * congelado é inocente e continua elegível no Recalcular/Trocar loja.
 */
export function lojaReportouDeVerdade(issueReason: string | null | undefined): boolean {
  return !!issueReason && issueReason !== MOTIVO_CONGELADO;
}

export function estaCongelado(issueReason: string | null | undefined): boolean {
  return issueReason === MOTIVO_CONGELADO;
}

/**
 * Trava das portas da LOJA (finalizar, mudar status, gerar etiqueta): card com
 * problema — reportado ou congelado — é assunto da matriz. A tela da loja já
 * esconde esses cards; isto cobre a aba que ficou aberta antes do socket.
 */
export function motivoTravaDaLoja(issueReason: string | null | undefined): string | null {
  if (!issueReason) return null;
  return estaCongelado(issueReason)
    ? 'Este pedido VOLTOU PRA MATRIZ: outra peça dele foi reportada. Não separe nem poste — aguarde a matriz liberar.'
    : 'Este pedido está com problema reportado e voltou pra matriz. Aguarde a decisão da matriz.';
}
