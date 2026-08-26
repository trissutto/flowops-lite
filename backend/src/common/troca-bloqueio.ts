/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PODE TROCAR ESTA PEÇA? — a régua é POR PEÇA, não por pedido (26/08)
 *
 *  Pedido dividido é o normal da casa. No LP-000239 a SOROCABA levou 2 peças
 *  (bipadas, NF-e 689 autorizada, postadas às 12h05) e a terceira — BMM-008
 *  PRETO 50 — ficou rodando a rede inteira sem ninguém ter. A cliente
 *  combinou com a matriz trocar por LARANJA, e a tela recusou: "a loja já
 *  finalizou a separação". Tinha finalizado, sim: a de SOROCABA, das OUTRAS
 *  duas peças. A peça da troca não estava separada, nem bipada, nem em nota
 *  nenhuma — e a troca ficou impossível pelo sistema por causa de um card que
 *  não fala por ela.
 *
 *  ORDEM DO DONO (26/08, tarde): "liberar a qualquer tempo a troca de peças
 *  que não foram enviadas". Separada, pronta ou bipada NÃO trava mais — o
 *  fluxo de aplicar cancela o card da peça, ESTORNA o bipe (a peça volta ao
 *  estoque) e re-roteia; a vendedora vê o card sumir e devolve a peça pra
 *  arara. O que trava é só o ponto sem volta:
 *    - card dela POSTADO (shipped/delivered) → está no correio: devolução;
 *    - caixa de juntada FECHADA com a peça dentro → lacrada a caminho da
 *      âncora, ninguém abre caixa na estrada;
 *    - NF-e autorizada do card dela → trocar deixaria a nota errada (cancele
 *      a nota primeiro, se for o caso).
 *
 *  A régua mora no `common` pelo mesmo motivo do `diferenca-troca.ts`: quem
 *  decide é o `TrocaPecaService`, mas o teste dela não pode depender de meio
 *  Nest pra rodar.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Card só de leitura — o que a régua precisa saber de um pick-order. */
export type CardDaTroca = {
  id: string;
  status: string;
  storeId?: string | null;
  store?: { code?: string | null; name?: string | null } | null;
};

/** Card que a loja ainda não fechou — dá pra mexer sem mexer com peça física. */
export const CARD_ATIVO = ['new', 'separating'];

/** Separada/pronta mas AINDA NA LOJA — troca liberada (com estorno do bipe). */
export const CARD_SEPARADO = ['separated', 'ready'];

/** Peça que já SAIU da loja — daqui em diante o caminho é devolução/troca. */
export const CARD_ENVIADO = ['shipped', 'delivered'];

/** Pedido inteiro fora de alcance. `shipped` saiu daqui de propósito: pedido
 *  dividido vira `shipped` com caixa de UMA loja na rua, e a peça que ficou
 *  pra trás continua trocável — quem fala por ela é o card DELA. */
export const PEDIDO_FECHADO = ['delivered', 'cancelled'];

/**
 * De quem é esta peça. `assignedStoreId` é o vínculo (é assim que o card da
 * loja monta a lista dele); quando a peça está sem dono, só dá pra afirmar
 * alguma coisa se o pedido tiver UM card só — o mesmo `soUmaLoja` que o
 * `pick-orders.service` usa pra mostrar item sem loja no card.
 */
export function cardDaPeca<T extends CardDaTroca>(
  cards: T[] | null | undefined,
  item: { assignedStoreId?: string | null } | null | undefined,
): T | null {
  const lista = cards ?? [];
  const dono = item?.assignedStoreId;
  if (dono) return lista.find((c) => c.storeId === dono) ?? null;
  return lista.length === 1 ? lista[0] : null;
}

/** Nome curto da loja pra mensagem ("06/SOROCABA" vira "SOROCABA"). */
function nomeDaLoja(card: CardDaTroca | null): string {
  const s = card?.store;
  const nome = (s?.name || '').trim();
  const code = (s?.code || '').trim();
  return nome || (code ? `loja ${code}` : 'A loja');
}

export type TrocaCtx = {
  orderStatus: string;
  /** O card que está com a peça (null = nenhuma loja pegou ainda). */
  card: CardDaTroca | null;
  /** Bipes ATIVOS (não estornados) do SKU desta peça em card ainda aberto. */
  bipesDaPeca: number;
  /**
   * Bipes não estornados em card POSTADO ou APAGADO — a prova que sobra de
   * que a peça saiu quando o card já não conta a história (ON-000106).
   */
  bipesEnviados?: number;
  /** NF-e autorizada do envio DESTE card, se houver. */
  notaAutorizada?: { numero?: number | string | null } | null;
  /** Caixa de juntada nascida DESTE card (feeder), se houver. */
  caixaDaJuntada?: { status?: string | null } | null;
};

/**
 * Por que ESTA peça não pode ser trocada agora. Null = pode.
 * A ordem é a da operação: o que já saiu fisicamente pesa mais.
 */
export function motivoDeBloqueioDaTroca(ctx: TrocaCtx): string | null {
  if (PEDIDO_FECHADO.includes(String(ctx.orderStatus))) {
    return 'Pedido já entregue ou cancelado — a troca agora é pelo portal de trocas/devolução.';
  }

  const card = ctx.card;
  const status = String(card?.status ?? '');
  if (card && CARD_ENVIADO.includes(status)) {
    return `${nomeDaLoja(card)} já postou esta peça — a troca agora é pelo portal de trocas/devolução.`;
  }

  if ((ctx.bipesEnviados ?? 0) > 0) {
    return 'Esta peça já saiu (bipe de envio ativo, sem estorno) — a troca agora é pelo portal de trocas/devolução.';
  }

  // Caixa de juntada fechada = peça lacrada a caminho da loja âncora. O card
  // do feeder fica `separated` enquanto a caixa viaja — sem esta trava a
  // liberação do `separated` mandaria trocar uma peça que está na estrada.
  const caixa = String(ctx.caixaDaJuntada?.status ?? '');
  if (caixa && caixa !== 'open' && caixa !== 'cancelled') {
    return `${nomeDaLoja(card)} já despachou esta peça na caixa da juntada — espere a caixa chegar na loja âncora e trate lá.`;
  }

  if (ctx.notaAutorizada) {
    return `Já existe NF-e autorizada (nº ${ctx.notaAutorizada.numero}) para esta peça — trocar agora deixaria a nota errada.`;
  }

  return null;
}

/**
 * Aviso pra matriz confirmar de olhos abertos — NÃO bloqueia (26/08). A peça
 * separada/bipada volta pro estoque sozinha quando a troca cancela o card;
 * o aviso existe pra ninguém se surpreender com o card sumindo da loja.
 */
export function avisoDaTroca(ctx: TrocaCtx): string | null {
  const card = ctx.card;
  const status = String(card?.status ?? '');
  if (card && CARD_SEPARADO.includes(status)) {
    return `${nomeDaLoja(card)} já separou esta peça — trocar desfaz a separação, devolve a peça ao estoque e refaz o card da loja.`;
  }
  if (ctx.bipesDaPeca > 0) {
    return 'A loja já bipou esta peça — trocar estorna o bipe (a peça volta ao estoque) e refaz o card da loja.';
  }
  return null;
}
