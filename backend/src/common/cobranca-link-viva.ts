/**
 * LINK PAGAR.ME: TENTATIVA RECUSADA NÃO MATA O LINK (10/09/2026).
 *
 * ── O CASO ──
 *
 * "Fizemos o link de manhã e a cliente só pagou à noite. Verificamos e está
 * pago, mas o sistema não tem esta informação." — dono, 10/09.
 *
 * O link de checkout da Pagar.me vale 72h (`PAGARME_LINK_HORAS`) e aceita
 * QUANTAS TENTATIVAS a cliente quiser dentro desse prazo: cartão recusado de
 * manhã, PIX pago à noite, MESMO link. Mas o Flow tratava a primeira recusa
 * como ponto final:
 *
 *   1. a tentativa recusada carimbava `pagarme_payments.status='failed'`;
 *   2. o `PagarmeReconcileService` só pergunta pro gateway sobre linha
 *      `status='pending'` — a partir do carimbo, NINGUÉM MAIS PERGUNTA;
 *   3. sem `paid` no banco, o `PagarmeLinkReconcileService` nunca vê a venda,
 *      a tela diz "aguardando" e o dinheiro fica na conta sem venda.
 *
 * E a cliente que voltasse no `/pg/<token>` levava "cobrança cancelada" num
 * link que a Pagar.me ainda aceitaria — venda perdida na porta.
 *
 * Nada disso dá erro em lugar nenhum: é a família "fonte morta com cara de
 * não-existe" da constituição de 14/07, aqui na forma "pago com cara de
 * pendente".
 *
 * ── A RÉGUA ──
 *
 * Uma só, consultada pelos DOIS lados (o cron que pergunta e a página que a
 * cliente abre) — divergir aí faz o sistema perguntar sobre um link que a
 * página já enterrou, ou o contrário.
 */

/** Status que o Flow guarda em `pagarme_payments.status`. */
export type StatusCobrancaPagarme = 'paid' | 'failed' | 'canceled' | 'pending';

/**
 * Folga depois do vencimento em que ainda vale perguntar. O pagamento pode
 * ter entrado nos últimos segundos de validade e demorar a aparecer na
 * consulta — mesma folga do `aposentarSeVencida` do PagBank.
 */
export const FOLGA_POS_VENCIMENTO_MS = 6 * 3600_000;

/**
 * O PEDIDO INTEIRO DECIDE — não a primeira cobrança.
 *
 * `checkOrderStatus` lia `order.charges[0]` e mandava esse status pro banco.
 * Num pedido com mais de uma cobrança (a recusada de manhã + a paga à noite)
 * isso é uma moeda no ar: a Pagar.me devolve as cobranças na ordem de
 * criação, então `[0]` é justamente a mais VELHA — a que falhou. Resultado:
 * pedido pago sendo gravado como `failed`, e pior, um `paid` que já estava no
 * banco podendo ser rebaixado.
 *
 * Regra: **dinheiro na conta ganha de qualquer outra cobrança do pedido.**
 * `overpaid` entra junto — a cliente pagou a mais, mas pagou.
 *
 * A reversão continua possível (antifraude que reprova DEPOIS de aprovar, o
 * caso de 01/08): sem nenhuma cobrança paga, o pedido volta a valer o que as
 * terminais disserem.
 */
export function statusDoPedidoPagarme(order: any): StatusCobrancaPagarme {
  const charges: any[] = Array.isArray(order?.charges) ? order.charges : [];
  const st = (c: any) => String(c?.status || '').toLowerCase();

  if (charges.some((c) => st(c) === 'paid' || st(c) === 'overpaid')) return 'paid';
  // O pedido pode se declarar pago antes da cobrança aparecer na resposta.
  if (String(order?.status || '').toLowerCase() === 'paid') return 'paid';

  const terminais = charges.filter((c) => st(c) === 'failed' || st(c) === 'canceled');
  // Alguma cobrança ainda viva (pending/processing/waiting_payment) = pendente.
  if (!charges.length || terminais.length !== charges.length) return 'pending';

  // Todas terminais: vale a MAIS NOVA — é ela que descreve onde a cobrança
  // parou. Sem `created_at` (payload magro), a última do array.
  const maisNova = terminais.reduce((a, b) => {
    const ta = Date.parse(a?.created_at || '') || 0;
    const tb = Date.parse(b?.created_at || '') || 0;
    return tb >= ta ? b : a;
  });
  return st(maisNova) === 'failed' ? 'failed' : 'canceled';
}

/**
 * O LINK AINDA ACEITA PAGAMENTO?
 *
 * - `paid` → não: já resolveu.
 * - `canceled` → não: o pedido foi cancelado de propósito, o checkout morre junto.
 * - `failed` → **SIM, enquanto não vencer**: é a tentativa recusada, e a
 *   Pagar.me deixa a cliente tentar de novo no mesmo checkout. Era este ramo
 *   que não existia.
 * - `pending` → sim, enquanto não vencer.
 *
 * Sem `expiresAt` (cobrança PIX antiga, que não usa link) a régua não tem como
 * saber o prazo: mantém o comportamento de sempre — `pending` continua sendo
 * perguntado, `failed` não vira caso novo.
 *
 * ⚠️ `folgaMs` separa os DOIS usos, e a diferença importa:
 *   · o CRON pergunta com folga — o pagamento pode ter entrado no último
 *     segundo de validade e demorar a aparecer na consulta;
 *   · a PÁGINA da cliente (`/pg/<token>`) chama com folga ZERO — mandar
 *     alguém pro checkout já vencido é o 404 sem saída que essa página existe
 *     pra evitar (caso Moema 15/08).
 */
export function linkCheckoutAindaDePe(
  cobranca: { status?: string | null; expiresAt?: Date | string | null },
  agora: number = Date.now(),
  folgaMs: number = FOLGA_POS_VENCIMENTO_MS,
): boolean {
  const status = String(cobranca?.status || 'pending').toLowerCase();
  if (status === 'paid' || status === 'canceled') return false;
  if (status !== 'pending' && status !== 'failed') return false;

  const bruto = cobranca?.expiresAt;
  if (!bruto) return status === 'pending';

  const vence = bruto instanceof Date ? bruto.getTime() : Date.parse(String(bruto));
  if (!Number.isFinite(vence)) return status === 'pending';
  return agora <= vence + folgaMs;
}

/**
 * Corte da consulta do cron: só linha `failed` que vencer DEPOIS deste
 * instante volta pra fila de perguntas. Mantém o volume no chão — link morto
 * de semana passada não vira chamada de API.
 */
export function corteFailedRechecavel(agora: number = Date.now()): Date {
  return new Date(agora - FOLGA_POS_VENCIMENTO_MS);
}
