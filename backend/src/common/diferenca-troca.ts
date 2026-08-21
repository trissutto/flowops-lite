/**
 * A DIFERENÇA DA TROCA DE PEÇA — a régua, num lugar só (21/08).
 *
 * Quando a matriz troca uma peça do pedido por outra mais cara, a cliente
 * recebe um link pra pagar a diferença e o pedido fica esperando o dinheiro.
 * Duas portas precisam decidir IGUAL:
 *   - a trava da separação (`RoutingService.confirmRoute`);
 *   - a tela do pedido (`TrocaPecaService.listar`).
 *
 * Mora aqui, e não num service, porque o routing não pode importar o módulo
 * de orders (fecharia ciclo) — mesmo motivo do `prova-pagamento.ts`.
 *
 * "Pago" é o que o gateway diz: o webhook da Pagar.me grava `paid` em
 * `pagarme_payments`, e é isso que a gente lê. Palavra de quem clicou não
 * conta (a mesma lição do ON-000049).
 */

/** A trava está ligada? `TROCA_PECA_TRAVA=0` desliga. */
export function trocaTravaLigada(): boolean {
  return String(process.env.TROCA_PECA_TRAVA ?? '').trim() !== '0';
}

/**
 * Cobrança paga no gateway vira `settled` (idempotente). Devolve o swap
 * atualizado — ou o mesmo, quando ainda não pagou.
 */
export async function conferirDiferencaNoGateway(prisma: any, swap: any): Promise<any> {
  if (swap?.tipo !== 'cobranca' || swap?.status !== 'pending' || !swap?.pagarmeOrderId) return swap;
  const pago = await prisma.pagarmePayment
    .findFirst({ where: { pagarmeOrderId: swap.pagarmeOrderId, status: 'paid' } })
    .catch(() => null);
  if (!pago) return swap;

  const atualizado = await prisma.orderItemSwap.update({
    where: { id: swap.id },
    data: { status: 'settled', settledAt: pago.paidAt ?? new Date() },
  });
  await prisma.orderHistory
    .create({
      data: {
        orderId: swap.orderId,
        note:
          `Diferença da troca (R$ ${(swap.diffCents / 100).toFixed(2)}) paga pela cliente — ` +
          'separação liberada.',
      },
    })
    .catch(() => null);
  return atualizado;
}

/**
 * Este pedido tem diferença de troca ESPERANDO pagamento? Confere no gateway
 * antes de responder — link pago com webhook atrasado não pode travar loja.
 */
export async function diferencaDeTrocaPendente(
  prisma: any,
  orderId: string,
): Promise<{ travado: boolean; motivo?: string }> {
  if (!trocaTravaLigada()) return { travado: false };

  const pendentes: any[] = await prisma.orderItemSwap
    .findMany({ where: { orderId, tipo: 'cobranca', status: 'pending' } })
    .catch(() => []);
  if (!pendentes.length) return { travado: false };

  for (const s of pendentes) {
    const fresco = await conferirDiferencaNoGateway(prisma, s);
    if (fresco.status === 'pending') {
      return {
        travado: true,
        motivo:
          `Troca de peça com diferença de R$ ${(fresco.diffCents / 100).toFixed(2)} ainda NÃO PAGA ` +
          `(${fresco.oldSku} → ${fresco.newSku}). O link de pagamento foi gerado pra cliente; a ` +
          'separação libera sozinha quando o dinheiro cair. Se a casa decidiu absorver, use ' +
          '"Liberar sem cobrar" na tela do pedido.',
      };
    }
  }
  return { travado: false };
}
