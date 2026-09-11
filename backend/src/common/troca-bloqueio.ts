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
 * A trava E o preço de abrir ela. `motivo` é o "não" que a tela sempre
 * mostrou; `consequencia` é o que a matriz precisa ler ANTES de usar a chave.
 */
export type BloqueioDaTroca = {
  /** Por que não pode — texto pronto pra tela. */
  motivo: string;
  /** O que acontece de fato se a matriz destravar assim mesmo. */
  consequencia: string;
};

/**
 * O bloqueio, com o que acontece SE A MATRIZ DESTRAVAR (10/09/2026).
 *
 * Cada trava daqui tem incidente com nome, e todas continuam valendo. O que
 * mudou é que nenhuma delas é mais o fim da linha: a matriz tem a chave
 * (`common/destrave-matriz.ts`) e, pra usar de olhos abertos, precisa ler o
 * PREÇO do destrave. Por isso a régua devolve as duas coisas juntas — quem
 * mostra só o "não" empurra a operação pro WhatsApp, e quem mostra só o
 * botão faz a matriz descobrir a consequência depois.
 *
 * Null = pode trocar sem chave nenhuma.
 */
export function bloqueioDaTroca(ctx: TrocaCtx): BloqueioDaTroca | null {
  if (PEDIDO_FECHADO.includes(String(ctx.orderStatus))) {
    const entregue = String(ctx.orderStatus) === 'delivered';
    return {
      motivo: 'Pedido já entregue ou cancelado — a troca agora é pelo portal de trocas/devolução.',
      consequencia: entregue
        ? 'A peça está COM A CLIENTE. Trocar aqui muda o item de um pedido fechado: a nota e o dinheiro você acerta por fora.'
        : 'O pedido está CANCELADO. Trocar aqui mexe no item de um pedido morto — se ele vai voltar a viver, reabra o status antes.',
    };
  }

  const card = ctx.card;
  const status = String(card?.status ?? '');
  if (card && CARD_ENVIADO.includes(status)) {
    const loja = nomeDaLoja(card);
    if (status === 'delivered') {
      return {
        motivo: `${loja} já postou esta peça — a troca agora é pelo portal de trocas/devolução.`,
        consequencia:
          'A peça está COM A CLIENTE (card entregue). Forçar troca o item e manda separar a peça nova, ' +
          'mas a velha NÃO volta pro estoque agora — ela entra quando chegar pela devolução.',
      };
    }
    /**
     * Nota autorizada no card postado (LP-001312, 11/09): o "Cancelar nota"
     * da ficha do pedido só aparece em card NÃO postado, e o destrave apaga o
     * card. A ordem que não deixa nota órfã é a da frase: nota primeiro.
     */
    const nota = ctx.notaAutorizada
      ? ` ⚠️ A NF-e nº ${ctx.notaAutorizada.numero} está autorizada com a peça VELHA: cancele ela ANTES — ` +
        `"⇄ Status" no card (volta pra "separated") faz aparecer o "Cancelar nota" (prazo da SEFAZ: 24h da ` +
        `autorização). Sem a nota, a troca nem precisa de chave. Depois do destrave, só pelo Relatório fiscal.`
      : '';
    return {
      motivo: `${loja} já postou esta peça — a troca agora é pelo portal de trocas/devolução.`,
      consequencia:
        `Forçar tira o card da ${loja} do "enviado", DEVOLVE as peças dele ao estoque dessa loja e refaz a ` +
        `separação — a ${loja} continua na disputa pelas peças que tem, e a etiqueta desse card não serve ` +
        `pro pacote novo. Se o pacote saiu mesmo, o estoque vai sobrar: confirme com a loja que a peça ` +
        `ainda está aí antes de destravar.` +
        nota,
    };
  }

  if ((ctx.bipesEnviados ?? 0) > 0) {
    return {
      motivo: 'Esta peça já saiu (bipe de envio ativo, sem estorno) — a troca agora é pelo portal de trocas/devolução.',
      consequencia:
        'O bipe diz que a peça saiu do estoque num card que já foi postado (ou apagado). Forçar troca o ' +
        'item mesmo assim — o acerto do estoque dessa peça fica na sua mão.',
    };
  }

  // Caixa de juntada fechada = peça lacrada a caminho da loja âncora. O card
  // do feeder fica `separated` enquanto a caixa viaja — sem esta trava a
  // liberação do `separated` mandaria trocar uma peça que está na estrada.
  const caixa = String(ctx.caixaDaJuntada?.status ?? '');
  if (caixa && caixa !== 'open' && caixa !== 'cancelled') {
    return {
      motivo: `${nomeDaLoja(card)} já despachou esta peça na caixa da juntada — espere a caixa chegar na loja âncora e trate lá.`,
      consequencia:
        'A peça está LACRADA numa caixa a caminho da loja âncora. Forçar troca o item, mas ninguém abre ' +
        'caixa na estrada: a peça velha vai chegar na âncora sem pedido, e alguém tem que dar entrada nela.',
    };
  }

  if (ctx.notaAutorizada) {
    return {
      motivo: `Já existe NF-e autorizada (nº ${ctx.notaAutorizada.numero}) para esta peça — trocar agora deixaria a nota errada.`,
      consequencia:
        `A NF-e nº ${ctx.notaAutorizada.numero} continua valendo com a peça VELHA, e forçar não mexe nela. ` +
        `O caminho sem chave é cancelar ANTES pelo "Cancelar nota" do card (prazo da SEFAZ: 24h da autorização). ` +
        `Forçando, o card some com o botão e a nota só se cancela pelo Relatório fiscal — sem cancelar, o que ` +
        `viaja não bate com o que foi declarado.`,
    };
  }

  return null;
}

/**
 * Por que ESTA peça não pode ser trocada agora. Null = pode.
 * A ordem é a da operação: o que já saiu fisicamente pesa mais.
 */
export function motivoDeBloqueioDaTroca(ctx: TrocaCtx): string | null {
  return bloqueioDaTroca(ctx)?.motivo ?? null;
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
