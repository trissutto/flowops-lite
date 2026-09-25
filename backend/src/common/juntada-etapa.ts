/**
 * ETAPA DE CADA LOJA FEEDER NO CARD DA ÂNCORA — régua única (25/09/2026).
 *
 * O card da loja que JUNTA o pedido mostra uma linha por loja que manda peça
 * pra ela: "ainda separando", "separada", "já saiu", "em trânsito", "chegou".
 * É dessa etapa que sai o `recebidas` do card — e é o `recebidas < total`
 * que esconde o botão "Gerar envio Correios".
 *
 * O CASO QUE OBRIGOU (LP-001508): Itanhaém despachou a caixa pra INDAIATUBA,
 * que era a âncora da hora. Depois a matriz remanejou as peças de Indaiatuba
 * e trocou a âncora pra Anália Franco. A caixa física continuou endereçada à
 * 04 (o `juntarPedido` avisa isso em voz alta e pede pra combinar o
 * reencaminhamento). Só que o card da âncora nova SÓ enxergava caixa
 * `toStoreCode === minha loja`: pra ele a caixa de Itanhaém nunca existiu —
 * a linha dizia "já saiu da loja de origem" pra sempre, `recebidas` ficava
 * 1 de 2 e o botão de etiqueta não apareceu nem depois de as DUAS caixas
 * estarem `received` e a calça já reencaminhada pra Anália Franco.
 *
 * Enquanto isso a PORTA (`travarEnvioAncoraSeFaltamCaixas`) e a retaguarda
 * (`statusJuntada`) casam a caixa pelo `pickOrderId` do feeder, sem olhar o
 * destino — e diziam "completa". Tela e porta discordavam; quem pagou foi a
 * loja, com um pedido pago de 18/09 parado até 25/09.
 *
 * A régua: a caixa do feeder CONTA por `pickOrderId`, igual à porta. A que
 * foi pra OUTRA loja não some — vem marcada (`caixaDesviadaPara`) pro card
 * avisar que o sistema não viu o reencaminhamento e que quem confere se a
 * peça está na mão é a vendedora (a mesma filosofia da retirada composta).
 */

export type EtapaFeeder = 'separando' | 'pronta' | 'problema' | 'a_caminho' | 'chegou';

export interface CaixaDoFeeder {
  /** open · in_transit · received (cancelada nunca chega aqui). */
  status: string;
  toStoreCode?: string | null;
  toStoreName?: string | null;
}

export interface CardFeeder {
  /** new · separating · separated · ready · shipped. */
  status: string;
  issueReason?: string | null;
}

/**
 * Onde a peça da outra loja está, do ponto de vista da âncora. Com caixa, a
 * caixa manda (`received` = chegou, o resto = a caminho). Sem caixa, o sinal
 * é o card da outra loja: problema reportado, já fechado, separado ou ainda
 * separando — a caixa só nasce no Finalizar da bipagem, e retirada composta
 * não gera caixa nenhuma.
 */
export function etapaDoFeeder(caixa: CaixaDoFeeder | null | undefined, card: CardFeeder): EtapaFeeder {
  if (caixa) return caixa.status === 'received' ? 'chegou' : 'a_caminho';
  if (card.issueReason) return 'problema';
  if (card.status === 'shipped') return 'a_caminho';
  if (card.status === 'separated' || card.status === 'ready') return 'pronta';
  return 'separando';
}

/**
 * A caixa foi endereçada a OUTRA loja (a âncora mudou depois do despacho)?
 * Devolve o nome da loja de destino (ou o código, se o nome não veio) — ou
 * `null` quando a caixa vem pra cá, não existe, ou não sei quem sou.
 */
export function caixaDesviadaPara(
  caixa: CaixaDoFeeder | null | undefined,
  minhaLojaCode: string | null | undefined,
): string | null {
  if (!caixa) return null;
  const minha = String(minhaLojaCode ?? '').trim();
  if (!minha) return null;
  const destino = String(caixa.toStoreCode ?? '').trim();
  if (!destino || destino === minha) return null;
  const nome = String(caixa.toStoreName ?? '').trim();
  return nome || destino;
}
