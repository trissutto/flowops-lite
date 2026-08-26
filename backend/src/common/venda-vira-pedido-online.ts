/**
 * Decide se uma venda FINALIZADA do PDV vira PEDIDO ONLINE (Order no trilho
 * do site: card de separação, roteamento, acerto fornecedora→vendedora) ou
 * segue o fluxo legado de balcão (baixa de estoque na própria loja, sem card).
 *
 * A régua antiga era "TODAS as payments são 'venda_online'" — e derrubava a
 * TROCA ONLINE: o crédito da troca entra como pagamento 'vale_troca' junto do
 * 'venda_online' da diferença, o every() falhava e a venda inteira caía no
 * balcão. Caso real (loja 08 São José, 25/08/2026): troca online de R$ 739,40
 * pra São Sebastião — vale_troca R$ 279,80 + link externo R$ 459,60, SEDEX
 * escolhido. O caixa fechou, o outbox baixou o estoque na vendedora e NENHUM
 * card nasceu: ninguém separa, cliente esperando, e nada avisa.
 *
 * Régua:
 * 1. QUALQUER pagamento 'venda_online' prova o fluxo online — só a tela de
 *    venda online cria esse método (PIX PagBank, link Pagar.me, PIX recebido,
 *    link externo). Vale/pix misturado no meio não muda a logística: a peça
 *    continua precisando viajar. Sem exigir entregaTipo, de propósito: venda
 *    fechada pelo cron do link fica com a entrega em branco (ON-000105) e o
 *    pedido precisa nascer mesmo assim, como "Entrega (não informada)".
 * 2. Venda 100% 'vale_troca' (troca par, sem diferença a cobrar) é online
 *    quando a loja escolheu forma de ENVIO (entregaTipo) — troca par de
 *    balcão, sem entrega, fica no balcão.
 * 3. Pagamento de balcão (pix/dinheiro/cartão) com entregaTipo preenchido NÃO
 *    vira pedido: entregaTipo pode ter ficado pra trás de um fluxo online
 *    abandonado, e card de peça que a cliente levou na mão é alarme falso na
 *    fila da loja.
 * 4. Venda sem pagamento nenhum nunca vira pedido (o every() vacuoso da régua
 *    antiga dizia que sim).
 */
export function vendaViraPedidoOnline(
  payments: Array<{ method?: string | null }> | null | undefined,
  entregaTipo?: string | null,
): boolean {
  const metodos = (payments ?? []).map((p) =>
    String(p?.method || '').trim().toLowerCase(),
  );
  if (!metodos.length) return false;
  if (metodos.some((m) => m === 'venda_online')) return true;
  return metodos.every((m) => m === 'vale_troca') && !!String(entregaTipo || '').trim();
}
