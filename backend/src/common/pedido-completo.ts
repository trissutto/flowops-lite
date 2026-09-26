/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  O PEDIDO PODE FECHAR? — a régua da peça pendente (26/08)
 *
 *  ORDEM DO DONO: "não deixar em hipótese alguma pedidos colocados como
 *  concluídos sendo que foram parcialmente entregues e ficaram peças ainda
 *  em aguardando".
 *
 *  O buraco era estrutural: quem fechava o pedido contava CARDS ("todos os
 *  pick-orders shipped?") ou CÓDIGOS de rastreio ("todas as caixas
 *  entregues?"). Peça REPORTADA sai do card (`assignedStoreId` vira null),
 *  peça de card apagado não tem código — e as duas somem da conta. Resultado:
 *  a loja posta a parte dela, o pedido inteiro vira "shipped"/"delivered", e
 *  a peça que ninguém tem some das filas com a cliente esperando.
 *
 *  Esta régua conta PEÇAS. Pendente é todo item que:
 *    - não foi cancelado/creditado (`cancelledAt`),
 *    - não é linha de frete/ajuste (`ehItemSemEstoque`),
 *    - e NÃO tem prova de envio: card da loja dona em shipped/delivered, ou
 *      (sem dono) bipe de envio não estornado que sobre pra cobrir a peça.
 *
 *  Report aberto (`PickOrderItemReport.resolvedAt = null`) marca a peça como
 *  pendente-reportada mesmo sem dono — é a fila de decisão da matriz.
 *
 *  ⚠️ CAIXA DE FEEDER NÃO É ENVIO PRA CLIENTE (26/09). Na juntada e na
 *  retirada dividida o card `isTransfer` posta a peça pra OUTRA LOJA (a
 *  âncora), não pra cliente. Quem prova que a peça saiu de verdade é o card
 *  da âncora. Caso LP-001264: Itanhaém mandou 3 peças pra Santos, a matriz
 *  removeu o card de Santos e o pedido ficou "Enviado" com as 3 peças na
 *  prateleira de outra loja e ninguém pra postar.
 *
 *  Pura de propósito (mesmo padrão de `troca-bloqueio.ts`): quem fecha pedido
 *  chama daqui; o teste roda sem Nest.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { ehItemSemEstoque } from './item-sem-estoque';

export type ItemDoPedido = {
  id: string;
  sku?: string | null;
  ref?: string | null;
  cor?: string | null;
  tamanho?: string | null;
  productName?: string | null;
  quantity?: number | null;
  cancelledAt?: Date | string | null;
  assignedStoreId?: string | null;
};

export type CardDoPedido = {
  storeId?: string | null;
  /** Código da loja do card — é por ele que o feeder aponta a âncora (`transferToStoreCode`). */
  storeCode?: string | null;
  status: string;
  /** Card FEEDER: manda a peça pra OUTRA loja (juntada / retirada dividida), não pra cliente. */
  isTransfer?: boolean | null;
  transferToStoreCode?: string | null;
  carrier?: string | null;
  trackingCode?: string | null;
  /** Quando o card mudou pela última vez — pra card postado, é o carimbo do despacho. */
  updatedAt?: Date | string | null;
};

export type ReportAberto = {
  orderItemId?: string | null;
  sku?: string | null;
};

export type PecaPendente = {
  itemId: string;
  sku: string;
  rotulo: string;
  motivo: 'reportada' | 'sem_dono' | 'aguardando_loja' | 'na_loja_ancora';
};

const CARD_ENVIADO = ['shipped', 'delivered'];
/** Card que ainda pede alguma coisa da loja — arara, bipe ou postagem. */
const CARD_ABERTO = ['new', 'separating', 'separated', 'ready'];
/** Pedido que já teve desfecho: não se fecha de novo nem se reabre por aqui. */
const PEDIDO_JA_FECHADO = ['shipped', 'delivered', 'cancelled'];

function rotuloDaPeca(it: ItemDoPedido): string {
  return (
    [it.ref || it.sku, it.cor, it.tamanho].filter(Boolean).join(' ').trim() ||
    it.productName ||
    String(it.sku || it.id)
  );
}

function codigoLoja(v: unknown): string {
  return String(v ?? '').trim().toUpperCase();
}

/**
 * As peças deste pedido que AINDA NÃO SAÍRAM nem foram acertadas.
 * Lista vazia = pode fechar. Cada linha diz por quê.
 *
 * `bipesEnviadosPorSku` (opcional): quantas unidades de cada SKU têm bipe de
 * envio ativo (não estornado) em card postado — é a prova que sobra quando o
 * card foi apagado depois de postar. Sem essa prova, peça sem dono conta como
 * pendente: melhor um pedido preso e visível que um fechado por suposição.
 */
export function pecasPendentesDoPedido(ctx: {
  items: ItemDoPedido[];
  cards: CardDoPedido[];
  reportsAbertos?: ReportAberto[];
  bipesEnviadosPorSku?: Record<string, number>;
}): PecaPendente[] {
  const cards = ctx.cards ?? [];
  const reports = ctx.reportsAbertos ?? [];
  const sobraBipe: Record<string, number> = { ...(ctx.bipesEnviadosPorSku ?? {}) };

  const pendentes: PecaPendente[] = [];
  for (const it of ctx.items ?? []) {
    if (it.cancelledAt) continue;
    if (ehItemSemEstoque(it)) continue;

    const sku = String(it.sku || '').trim();
    const qty = Math.max(1, Number(it.quantity) || 1);

    // Prova de envio nº 1: o card da loja DONA da peça já postou.
    const dono = it.assignedStoreId || null;
    const cardDono = dono ? cards.find((c) => c.storeId === dono) ?? null : null;
    let enviadaPeloCard = !!cardDono && CARD_ENVIADO.includes(String(cardDono.status));

    // Card FEEDER postado = a peça foi pra loja ÂNCORA, não pra cliente. Só
    // conta como enviada quando o card (não-feeder) da âncora também postou.
    // Sem card na âncora — removido na mão, nunca criado — a peça está numa
    // caixa em outra loja e ninguém vai postá-la: pendente, e visível.
    let presaNaAncora = false;
    if (enviadaPeloCard && cardDono?.isTransfer) {
      const destino = codigoLoja(cardDono.transferToStoreCode);
      const cardAncora = destino
        ? cards.find((c) => !c.isTransfer && codigoLoja(c.storeCode) === destino) ?? null
        : null;
      enviadaPeloCard = !!cardAncora && CARD_ENVIADO.includes(String(cardAncora.status));
      presaNaAncora = !enviadaPeloCard;
    }

    // Prova nº 2 (peça sem dono): bipe de envio ativo que ainda sobre pra ela.
    let enviadaPorBipe = false;
    if (!dono && sku && (sobraBipe[sku] ?? 0) >= qty) {
      sobraBipe[sku] -= qty;
      enviadaPorBipe = true;
    }

    if (enviadaPeloCard || enviadaPorBipe) continue;

    const reportada = reports.some((r) =>
      r.orderItemId ? r.orderItemId === it.id : sku && String(r.sku || '').trim() === sku,
    );

    pendentes.push({
      itemId: it.id,
      sku,
      rotulo: rotuloDaPeca(it),
      motivo: reportada
        ? 'reportada'
        : presaNaAncora
          ? 'na_loja_ancora'
          : !dono || !cardDono
            ? 'sem_dono'
            : 'aguardando_loja',
    });
  }
  return pendentes;
}

/**
 * O PEDIDO FECHA AGORA? — a decisão única de encerramento (26/09).
 *
 * Até aqui só o ramo `shipped` do `updateStatus` do card fechava pedido, e só
 * naquele instante. Se a última caixa postava com uma peça pendente, o pedido
 * ficava aberto — certo — mas NADA reavaliava depois: a matriz cancelava a
 * peça com crédito, o card feeder virava `shipped` pelo cron da juntada, o
 * cron da postagem dos Correios marcava o card postado… e o pedido seguia
 * "Em separação" pra sempre, com a cliente já de posse da sacola. Medido em
 * 26/09: 16 dos 21 pedidos da aba "Em separação" estavam assim, o mais velho
 * com 33 dias.
 *
 * Esta função é a régua; quem grava é `PickOrdersService.tentarFecharPedido`,
 * e TODO desfecho de peça ou de card chama ele. Pura: recebe o que já foi
 * lido do banco.
 *
 *  - pedido já fechado/cancelado → não mexe (nunca reabre, nunca duplica);
 *  - sem card → não fecha (pedido sem loja é fila da matriz, não desfecho);
 *  - qualquer card ainda aberto → não fecha;
 *  - peça pendente (régua acima) → não fecha, e é AQUI que "peça ≠ caixa" vale;
 *  - senão fecha: `delivered` quando é retirada e a loja que entrega marcou
 *    "Cliente retirou" (carrier retirada — a entrega aconteceu na frente da
 *    vendedora), `shipped` no resto. `despachoEm` é o carimbo do ÚLTIMO card
 *    que entrega (não é `now()`: quem fecha atrasado não pode inventar data —
 *    é dela que corre a janela do rastreio e o prazo de troca).
 */
export type DecisaoFechamento =
  | { fecha: false; motivo: 'ja_fechado' | 'sem_card' | 'card_aberto' | 'pendencia' }
  | { fecha: true; como: 'shipped' | 'delivered'; despachoEm: Date };

export function decidirFechamento(ctx: {
  status: string;
  isPickup?: boolean | null;
  cards: CardDoPedido[];
  pendentes: PecaPendente[];
  /** Só pra teste — o "agora" usado quando nenhum card tem carimbo. */
  agora?: Date;
}): DecisaoFechamento {
  if (PEDIDO_JA_FECHADO.includes(String(ctx.status))) return { fecha: false, motivo: 'ja_fechado' };

  const vivos = (ctx.cards ?? []).filter((c) => String(c.status) !== 'cancelled');
  if (!vivos.length) return { fecha: false, motivo: 'sem_card' };
  const algumAberto = vivos.some(
    (c) => CARD_ABERTO.includes(String(c.status)) || !CARD_ENVIADO.includes(String(c.status)),
  );
  if (algumAberto) return { fecha: false, motivo: 'card_aberto' };
  if ((ctx.pendentes ?? []).length) return { fecha: false, motivo: 'pendencia' };

  // Quem ENTREGA pra cliente é o card não-feeder; o feeder só alimenta a âncora.
  const finais = vivos.filter((c) => !c.isTransfer);
  const quemEntrega = finais.length ? finais : vivos;
  const retirada = !!ctx.isPickup && quemEntrega.some((c) => /retirada/i.test(String(c.carrier || '')));
  const carimbos = quemEntrega
    .map((c) => (c.updatedAt ? new Date(c.updatedAt) : null))
    .filter((d): d is Date => !!d && !Number.isNaN(+d))
    .sort((a, b) => +b - +a);
  const despachoEm = carimbos[0] ?? ctx.agora ?? new Date();
  return { fecha: true, como: retirada ? 'delivered' : 'shipped', despachoEm };
}

/**
 * Carrega tudo que a régua precisa: cards (com loja e destino do feeder) e
 * as pendências de um pedido.
 *
 * Fica aqui (e não em cada service) pra régua ter UMA leitura do banco: quem
 * fecha pedido — card da loja, botão Concluído, cron do rastreio, varredura —
 * conta as mesmas peças do mesmo jeito. `prisma` chega por parâmetro porque o
 * common não participa da injeção do Nest (mesma razão do resto do arquivo ser
 * puro).
 *
 * Bipe de envio: um scan não estornado cujo card POSTOU — ou sumiu (card
 * apagado depois do fato; a linha órfã é a evidência que sobrou) — conta como
 * prova de que a peça saiu, uma unidade por linha.
 */
export async function carregarFechamento(
  prisma: any,
  orderId: string,
): Promise<{ cards: CardDoPedido[]; pendentes: PecaPendente[] }> {
  const [items, cardsCrus, reports] = await Promise.all([
    prisma.orderItem.findMany({
      where: { orderId },
      select: {
        id: true, sku: true, ref: true, cor: true, tamanho: true, productName: true,
        quantity: true, cancelledAt: true, assignedStoreId: true,
      },
    }),
    prisma.pickOrder.findMany({
      where: { orderId },
      select: {
        id: true, storeId: true, status: true, isTransfer: true, transferToStoreCode: true,
        carrier: true, trackingCode: true, updatedAt: true, store: { select: { code: true } },
      },
    }),
    prisma.pickOrderItemReport
      .findMany({ where: { orderId, resolvedAt: null }, select: { orderItemId: true, sku: true } })
      .catch(() => []),
  ]);
  const cards: Array<CardDoPedido & { id: string }> = (cardsCrus as any[]).map((c) => ({
    id: c.id,
    storeId: c.storeId ?? null,
    storeCode: c.store?.code ?? null,
    status: String(c.status),
    isTransfer: !!c.isTransfer,
    transferToStoreCode: c.transferToStoreCode ?? null,
    carrier: c.carrier ?? null,
    trackingCode: c.trackingCode ?? null,
    updatedAt: c.updatedAt ?? null,
  }));

  const bipes: Record<string, number> = {};
  try {
    const scans: Array<{ sku: string; pickOrderId: string }> = await prisma.pickOrderScan.findMany({
      where: { orderId, revertedAt: null },
      select: { sku: true, pickOrderId: true },
    });
    const statusPorCard = new Map(cards.map((c) => [c.id, String(c.status)]));
    for (const s of scans) {
      const st = statusPorCard.get(s.pickOrderId);
      if (st && st !== 'shipped' && st !== 'delivered') continue; // bipe de card ainda aberto não é envio
      const sku = String(s.sku || '').trim();
      if (!sku) continue;
      bipes[sku] = (bipes[sku] ?? 0) + 1;
    }
  } catch {
    /* sem a prova do bipe a régua só fica mais rígida — nunca mais frouxa */
  }

  const pendentes = pecasPendentesDoPedido({
    items,
    cards,
    reportsAbertos: reports,
    bipesEnviadosPorSku: bipes,
  });
  return { cards, pendentes };
}

/** Só as pendências — o que a maioria das portas precisa. */
export async function carregarPecasPendentes(prisma: any, orderId: string): Promise<PecaPendente[]> {
  return (await carregarFechamento(prisma, orderId)).pendentes;
}

/** Frase pronta pra história/erro: "BMM-008 PRETO 50 (reportada) · VLM-222 …". */
export function descreverPendentes(pendentes: PecaPendente[], max = 3): string {
  const nomes = pendentes.slice(0, max).map((p) => {
    const motivo =
      p.motivo === 'reportada'
        ? 'reportada, aguardando decisão'
        : p.motivo === 'sem_dono'
          ? 'sem loja definida'
          : p.motivo === 'na_loja_ancora'
            ? 'na loja âncora, sem card pra postar'
            : 'ainda com a loja';
    return `${p.rotulo} (${motivo})`;
  });
  const resto = pendentes.length - nomes.length;
  return nomes.join(' · ') + (resto > 0 ? ` · +${resto} peça(s)` : '');
}
