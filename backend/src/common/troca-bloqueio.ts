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
 *  Por isso cada trava olha o CARD DA PEÇA:
 *    - card dela avançado (separated/ready/shipped) → está na arara ou no
 *      correio: o caminho é devolução/troca;
 *    - bipe ativo do SKU dela → saiu do estoque no bipe (18/08);
 *    - NF-e autorizada do card dela → trocar deixaria a nota errada.
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

/** Card que já saiu da mão da matriz: peça separada, pronta ou postada. */
export const CARD_AVANCADO = ['separated', 'ready', 'shipped', 'delivered'];

/** Pedido inteiro fora de alcance — nem a peça mais parada volta atrás. */
export const PEDIDO_FECHADO = ['shipped', 'delivered', 'cancelled'];

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

/**
 * Por que ESTA peça não pode ser trocada agora. Null = pode.
 * A ordem é a da operação: o que já saiu fisicamente pesa mais.
 */
export function motivoDeBloqueioDaTroca(ctx: {
  orderStatus: string;
  /** O card que está com a peça (null = nenhuma loja pegou ainda). */
  card: CardDaTroca | null;
  /** Bipes ATIVOS (não estornados) do SKU desta peça. */
  bipesDaPeca: number;
  /** NF-e autorizada do envio DESTE card, se houver. */
  notaAutorizada?: { numero?: number | string | null } | null;
}): string | null {
  if (PEDIDO_FECHADO.includes(String(ctx.orderStatus))) {
    return 'Pedido já despachado ou cancelado — a troca agora é pelo portal de trocas/devolução.';
  }

  const card = ctx.card;
  const status = String(card?.status ?? '');
  if (card && CARD_AVANCADO.includes(status)) {
    const loja = nomeDaLoja(card);
    return status === 'shipped' || status === 'delivered'
      ? `${loja} já postou esta peça — a troca agora é pelo portal de trocas/devolução.`
      : `${loja} já finalizou a separação — esta peça está separada fisicamente. Use devolução/troca.`;
  }

  // Bipe ativo = peça na mão da vendedora e estoque já baixado (18/08).
  if (ctx.bipesDaPeca > 0) {
    return 'A loja já bipou esta peça — ela saiu do estoque. Peça pra ela reportar o item ou finalize e trate como devolução.';
  }

  if (ctx.notaAutorizada) {
    return `Já existe NF-e autorizada (nº ${ctx.notaAutorizada.numero}) para esta peça — trocar agora deixaria a nota errada.`;
  }

  return null;
}
