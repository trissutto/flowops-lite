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
  status: string;
};

export type ReportAberto = {
  orderItemId?: string | null;
  sku?: string | null;
};

export type PecaPendente = {
  itemId: string;
  sku: string;
  rotulo: string;
  motivo: 'reportada' | 'sem_dono' | 'aguardando_loja';
};

const CARD_ENVIADO = ['shipped', 'delivered'];

function rotuloDaPeca(it: ItemDoPedido): string {
  return (
    [it.ref || it.sku, it.cor, it.tamanho].filter(Boolean).join(' ').trim() ||
    it.productName ||
    String(it.sku || it.id)
  );
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
    const enviadaPeloCard = !!cardDono && CARD_ENVIADO.includes(String(cardDono.status));

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
      motivo: reportada ? 'reportada' : !dono || !cardDono ? 'sem_dono' : 'aguardando_loja',
    });
  }
  return pendentes;
}

/**
 * Carrega tudo que a régua precisa e devolve as pendências de um pedido.
 *
 * Fica aqui (e não em cada service) pra régua ter UMA leitura do banco: quem
 * fecha pedido — card da loja, botão Concluído, cron do rastreio — conta as
 * mesmas peças do mesmo jeito. `prisma` chega por parâmetro porque o common
 * não participa da injeção do Nest (mesma razão do resto do arquivo ser puro).
 *
 * Bipe de envio: um scan não estornado cujo card POSTOU — ou sumiu (card
 * apagado depois do fato; a linha órfã é a evidência que sobrou) — conta como
 * prova de que a peça saiu, uma unidade por linha.
 */
export async function carregarPecasPendentes(prisma: any, orderId: string): Promise<PecaPendente[]> {
  const [items, cards, reports] = await Promise.all([
    prisma.orderItem.findMany({
      where: { orderId },
      select: {
        id: true, sku: true, ref: true, cor: true, tamanho: true, productName: true,
        quantity: true, cancelledAt: true, assignedStoreId: true,
      },
    }),
    prisma.pickOrder.findMany({
      where: { orderId },
      select: { id: true, storeId: true, status: true },
    }),
    prisma.pickOrderItemReport
      .findMany({ where: { orderId, resolvedAt: null }, select: { orderItemId: true, sku: true } })
      .catch(() => []),
  ]);

  const bipes: Record<string, number> = {};
  try {
    const scans: Array<{ sku: string; pickOrderId: string }> = await prisma.pickOrderScan.findMany({
      where: { orderId, revertedAt: null },
      select: { sku: true, pickOrderId: true },
    });
    const statusPorCard = new Map((cards as any[]).map((c) => [c.id, String(c.status)]));
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

  return pecasPendentesDoPedido({
    items,
    cards,
    reportsAbertos: reports,
    bipesEnviadosPorSku: bipes,
  });
}

/** Frase pronta pra história/erro: "BMM-008 PRETO 50 (reportada) · VLM-222 …". */
export function descreverPendentes(pendentes: PecaPendente[], max = 3): string {
  const nomes = pendentes.slice(0, max).map((p) => {
    const motivo =
      p.motivo === 'reportada'
        ? 'reportada, aguardando decisão'
        : p.motivo === 'sem_dono'
          ? 'sem loja definida'
          : 'ainda com a loja';
    return `${p.rotulo} (${motivo})`;
  });
  const resto = pendentes.length - nomes.length;
  return nomes.join(' · ') + (resto > 0 ? ` · +${resto} peça(s)` : '');
}
