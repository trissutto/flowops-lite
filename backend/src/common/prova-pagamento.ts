/**
 * PROVA DE PAGAMENTO da venda online do PDV — a régua, num lugar só (20/08).
 *
 * "Prova" = TODOS os payments da venda têm registro PAGO num gateway da casa
 * (`pagarme_payments`/`pagbank_payments`), casado pelos ids que o payment
 * gravou. "PIX recebido" e "Link externo" não gravam id nenhum — são a
 * palavra da vendedora, e palavra não é prova (caso ON-000049: "recebemos o
 * seu pagamento" pra cliente que não tinha pago).
 *
 * Usada por três portões que precisam decidir IGUAL:
 *   - o aviso de "pagamento confirmado" (PedidoOnlineService);
 *   - a trava de separação (RoutingService.confirmRoute);
 *   - a tela Conferência de Vendas (versão em lote própria, mesmo critério).
 */

/** A trava de conferência está ligada? `CONFERENCIA_TRAVA=0` desliga. */
export function conferenciaTravaLigada(): boolean {
  return String(process.env.CONFERENCIA_TRAVA ?? '').trim() !== '0';
}

/** TODOS os payments da venda têm gateway PAGO por trás? */
export async function vendaOnlineTemProva(prisma: any, saleId: string | null | undefined): Promise<boolean> {
  if (!saleId) return false;
  const payments: any[] = await prisma.pdvSalePayment.findMany({
    where: { saleId },
    select: { details: true },
  });
  if (!payments.length) return false;

  for (const p of payments) {
    let det: any = null;
    try {
      det = typeof p.details === 'string' ? JSON.parse(p.details) : p.details;
    } catch {
      det = null;
    }

    const pagarmeId = String(det?.pagarmeOrderId || '').trim();
    if (pagarmeId) {
      const r = await prisma.pagarmePayment.findFirst({
        where: { pagarmeOrderId: pagarmeId, status: 'paid' },
        select: { pagarmeOrderId: true },
      });
      if (r) continue;
    }

    const pagbankId = String(det?.pagbankOrderId || det?.pixTxid || '').trim();
    if (pagbankId) {
      const r = await prisma.pagbankPayment.findFirst({
        where: { pagbankOrderId: pagbankId, status: 'paid' },
        select: { pagbankOrderId: true },
      });
      if (r) continue;
    }

    // Split com metade sem prova = sem prova: na dúvida, trava.
    return false;
  }
  return true;
}

/**
 * O pedido pdv_online está LIBERADO pra virar separação/envio?
 * Liberado = tem prova no gateway OU alguém carimbou a conferência.
 */
export async function pedidoOnlineLiberado(
  prisma: any,
  order: { source?: string | null; vendaConferidaEm?: Date | null; checkoutInfo?: string | null },
): Promise<boolean> {
  if (order?.source !== 'pdv_online') return true; // trava é só da venda online do PDV
  if (!conferenciaTravaLigada()) return true;
  if (order?.vendaConferidaEm) return true;
  let saleId: string | null = null;
  try {
    saleId = JSON.parse(order?.checkoutInfo || '{}')?.pdvSaleId ?? null;
  } catch {
    saleId = null;
  }
  return vendaOnlineTemProva(prisma, saleId);
}
