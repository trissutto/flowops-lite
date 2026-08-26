/**
 * O PEDIDO DE MOTOBOY NASCE FECHADO OU ABRE SEPARAÇÃO?
 *
 * Regra pura, fora do `PedidoOnlineService`, porque ela decide duas coisas
 * caras de errar: se alguém vai procurar na arara uma peça que já saiu, e se
 * o estoque baixa agora ou só quando alguém bipar.
 *
 * ⚠️ SÓ MOTOBOY nasce fechado. A régua não é "a loja tem a peça", é "sobra
 * artefato do sistema pra alguém":
 *   - MOTOBOY   → sai da mão da vendedora. Sem etiqueta, sem rastreio, nada.
 *   - SEDEX/PAC → card na loja: é DENTRO dele que ela gera a pré-postagem e
 *                 imprime a NF. Sem card, a peça fica na arara e o pedido diz
 *                 "enviado" — a cliente pagou e não recebe nada, em silêncio.
 *   - RETIRADA  → card na loja: separar e guardar pro balcão é tarefa real.
 *
 * E quem responde "a moto já saiu?" é a PESSOA NO CAIXA, não o saldo do
 * espelho (26/08, caso ON-000164 — Piracicaba entregou 4 peças de moto na
 * hora e o pedido abriu roteamento assim mesmo, porque o espelho achava que
 * faltava peça). Por isso `pecasNaMao` ganha do estoque nos dois sentidos:
 * SIM fecha mesmo sem saldo, NÃO abre separação mesmo com saldo.
 */
export function fechaMotoboySemSeparacao(input: {
  /** Forma de entrega normalizada: 'motoboy' | 'sedex' | 'pac' | 'retirada'. */
  kind: string;
  /** A entrega foi atribuída a OUTRA loja (não a vendedora)? */
  outraLojaAtende: boolean;
  /**
   * Resposta da vendedora a "as peças já estão aqui?". `null` = ninguém
   * perguntou (outra loja entrega, venda fechada pelo cron do PIX) — aí
   * decide o estoque, como antes de 26/08.
   */
  pecasNaMao: boolean | null;
  /** O espelho diz que a loja vendedora cobre a sacola inteira? */
  lojaTemTudo: boolean;
}): boolean {
  if (input.kind !== 'motoboy') return false;
  // Outra loja manda a moto: a peça não está na mão de quem fechou a venda —
  // a loja escolhida precisa do card (e das transferências) pra entregar.
  if (input.outraLojaAtende) return false;
  return input.pecasNaMao === null ? input.lojaTemTudo : input.pecasNaMao;
}
