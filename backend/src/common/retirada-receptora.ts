/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  O CARD RECEPTOR DA RETIRADA — a loja onde a cliente busca TEM que ver o
 *  pedido, mesmo sem separar nada (26/09/2026, caso LP-001652)
 *
 *  Retirada em SOROCABA com a peça em ANÁLIA FRANCO. O roteamento só cria
 *  card na loja de retirada quando ela cobre ao menos uma peça
 *  (`routePickup`, `pickupCoversItems`): sem peça, o único card era o de
 *  transferência da origem. Sorocaba via SÓ a tarefa "Receber remessa" — sem
 *  número do pedido, sem cliente — e, depois de dar entrada, o pedido não
 *  existia em tela nenhuma dela. Medido em 26/08: 23 de 123 retiradas em 180
 *  dias nessa situação.
 *
 *  Pior: o botão "📦 Enviei pra loja X" da origem manda carrier `Retirada`, e
 *  o fechamento do pedido como ENTREGUE olhava só `isPickup` + carrier. O
 *  LP-001652 constou entregue às 12:39 de 24/09 com a caixa ainda dentro da
 *  Anália Franco — e ninguém em Sorocaba tinha botão pra registrar a retirada
 *  de verdade.
 *
 *  A limpeza de cards vazios (`cleanupEmptyActivePickOrders`) JÁ reconhecia o
 *  "card RECEPTOR vazio na loja de destino" como exceção legítima. Só faltava
 *  alguém criá-lo. Esta régua diz QUANDO ele falta, com que status nasce e
 *  QUEM fecha o pedido como entregue:
 *    - falta quando o pedido tem destino obrigatório (retirada/motoboy),
 *      existe alimentador (`isTransfer`) apontando pra lá e nenhum card
 *      próprio no destino;
 *    - nasce `new` ("aguardando a peça chegar") ou `separated` ("peça chegou")
 *      conforme as caixas dos alimentadores já deram entrada;
 *    - só o card PRÓPRIO da loja de destino fecha o pedido como entregue — o
 *      card de transferência deixa o pedido ENVIADO.
 *
 *  Pura de propósito (padrão de `pedido-completo.ts`): roteamento, "mover
 *  peça", entrada da remessa e `updateStatus` chamam daqui; o teste roda sem
 *  Nest. As funções com banco recebem o `prisma` por parâmetro pra não
 *  amarrar módulo nenhum (realignment ↔ routing ↔ pick-orders).
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { destinoObrigatorioDoPedido } from './destino-obrigatorio';
import { ehItemSemEstoque } from './item-sem-estoque';

export type PedidoComDestino = {
  isPickup?: boolean | null;
  pickupStoreCode?: string | null;
  shippingMethod?: string | null;
};

export type CardParaReceptor = {
  id?: string;
  status: string;
  isTransfer?: boolean | null;
  transferToStoreCode?: string | null;
  /** Código da loja dona do card. */
  storeCode?: string | null;
  storeName?: string | null;
};

const CARD_MORTO = new Set(['cancelled', 'canceled']);
const PEDIDO_ENCERRADO = new Set(['delivered', 'cancelled', 'canceled', 'refunded']);

const vivo = (c: { status: string }) => !CARD_MORTO.has(String(c.status));
const cod = (v: unknown) => String(v ?? '').trim();

/**
 * A loja onde FALTA o card receptor — ou `null` quando não falta.
 *
 * Falta quando: o pedido tem destino obrigatório, algum card VIVO é
 * alimentador desse destino e não existe card próprio (não-transferência)
 * na loja de destino. Card cancelado não conta pra nenhum dos lados.
 */
export function faltaCardReceptor(order: PedidoComDestino, cards: CardParaReceptor[]): string | null {
  const destino = destinoObrigatorioDoPedido(order);
  if (!destino) return null;
  const vivos = cards.filter(vivo);
  const temFeeder = vivos.some((c) => !!c.isTransfer && cod(c.transferToStoreCode) === destino);
  if (!temFeeder) return null;
  const temProprio = vivos.some((c) => !c.isTransfer && cod(c.storeCode) === destino);
  return temProprio ? null : destino;
}

/**
 * Status com que o receptor nasce (ou pra onde avança): `separated` quando
 * TODA caixa dos alimentadores já deu entrada — a peça está na loja, falta a
 * cliente —, `new` enquanto alguma ainda não chegou. Alimentador sem caixa
 * (ainda separando) segura em `new`.
 */
export function statusDoReceptor(
  feeders: Array<{ id: string; status?: string | null }>,
  caixas: Array<{ pickOrderId?: string | null; status: string }>,
): 'new' | 'separated' {
  if (!feeders.length) return 'new';
  const porPick = new Map<string, { status: string }>();
  for (const c of caixas) {
    if (c.status === 'cancelled') continue;
    porPick.set(cod(c.pickOrderId), c);
  }
  /**
   * SEM CAIXA NO SISTEMA (revisão de 26/09): a origem pode ter fechado o card
   * no "📦 Enviei pra loja X" sem nunca tirar a etiqueta — a caixa não existe
   * e nunca vai dar entrada (33 cards assim desde abril, medido em 27/08).
   * Esperar `received` deixaria o receptor em "aguardando a peça" pra
   * sempre, com a peça na mão da vendedora e sem botão. Alimentador
   * `shipped` SEM caixa viva conta como "a origem mandou": o receptor libera
   * o "Cliente retirou", e a porta pede a confirmação do gerente (a caixa não
   * deu entrada — quem confere a peça é quem está lá). Com caixa viva, é a
   * caixa que manda: só `received` conta.
   */
  const chegou = (f: { id: string; status?: string | null }) => {
    const cx = porPick.get(f.id);
    return cx ? cx.status === 'received' : String(f.status ?? '') === 'shipped';
  };
  return feeders.every(chegou) ? 'separated' : 'new';
}

/**
 * Este card é o RECEPTOR? Card próprio (não-transferência) da loja de
 * destino obrigatório, SEM peça própria — tudo chega por transferência.
 * Card da loja de destino que TEM peça é um card comum (bipa, finaliza) que
 * também recebe caixa: a retirada composta de 26/08.
 */
export function ehCardReceptor(
  card: { isTransfer?: boolean | null; storeCode?: string | null },
  order: PedidoComDestino,
  temItensProprios: boolean,
): boolean {
  if (card.isTransfer || temItensProprios) return false;
  const destino = destinoObrigatorioDoPedido(order);
  return !!destino && cod(card.storeCode) === destino;
}

/**
 * "Cliente retirou" fecha o pedido como ENTREGUE — mas só no card de quem
 * ENTREGA. O card de transferência (`isTransfer`) com carrier `Retirada` é o
 * "📦 Enviei pra loja X" da origem: a peça saiu dali, não chegou na mão da
 * cliente. Esse deixa o pedido ENVIADO; quem entrega é a loja de retirada.
 */
export function fechaComoEntregue(
  card: { isTransfer?: boolean | null } | null | undefined,
  order: { isPickup?: boolean | null } | null | undefined,
  carrier: string | null | undefined,
): boolean {
  if (!order?.isPickup) return false;
  if (card?.isTransfer) return false;
  return /retirada/i.test(cod(carrier));
}

// ─────────────────────────────────────────────────────────────────────────
//  Com banco — `prisma` por parâmetro (mesmo padrão de `carregarPecasPendentes`)
// ─────────────────────────────────────────────────────────────────────────

export type ReceptorCriado = {
  criado: true;
  pickOrderId: string;
  storeId: string;
  storeCode: string;
  storeName: string;
  status: 'new' | 'separated';
  /** Nomes das lojas que mandam peça pro receptor. */
  origens: string[];
};

export type ReceptorNaoCriado = { criado: false; porque: string };

const SELECT_PEDIDO = {
  id: true,
  status: true,
  wcOrderNumber: true,
  isPickup: true,
  pickupStoreCode: true,
  shippingMethod: true,
  pickOrders: {
    select: {
      id: true,
      status: true,
      storeId: true,
      isTransfer: true,
      transferToStoreCode: true,
      store: { select: { code: true, name: true } },
    },
  },
} as const;

function cardsDoPedido(order: any): Array<CardParaReceptor & { id: string; storeId: string }> {
  return (order?.pickOrders ?? []).map((p: any) => ({
    id: p.id,
    storeId: p.storeId,
    status: p.status,
    isTransfer: p.isTransfer,
    transferToStoreCode: p.transferToStoreCode,
    storeCode: p.store?.code ?? null,
    storeName: p.store?.name ?? null,
  }));
}

type CaixaDoFeeder = { pickOrderId: string | null; status: string; code: string };

async function caixasDosFeeders(prisma: any, feederIds: string[]): Promise<CaixaDoFeeder[]> {
  if (!feederIds.length) return [];
  const rows: CaixaDoFeeder[] = await prisma.realignmentShipment.findMany({
    where: { pickOrderId: { in: feederIds }, status: { not: 'cancelled' } },
    select: { pickOrderId: true, status: true, code: true },
  });
  return rows;
}

/**
 * Garante o card receptor do pedido. Idempotente: devolve `criado: false`
 * (com o porquê) quando não falta, quando o pedido já encerrou ou quando a
 * loja de destino não existe. NÃO emite socket nem push — quem chama decide
 * (roteamento avisa a loja; entrada da remessa também).
 */
export async function garantirCardReceptor(
  prisma: any,
  orderId: string,
  opts?: { motivo?: string | null; userId?: string | null; nome?: string | null },
): Promise<ReceptorCriado | ReceptorNaoCriado> {
  const order: any = await prisma.order.findUnique({ where: { id: orderId }, select: SELECT_PEDIDO });
  if (!order) return { criado: false, porque: 'pedido não existe' };
  if (PEDIDO_ENCERRADO.has(String(order.status))) return { criado: false, porque: `pedido ${order.status}` };

  const cards = cardsDoPedido(order);
  const destino = faltaCardReceptor(order, cards);
  if (!destino) return { criado: false, porque: 'não falta card receptor' };

  const loja: any = await prisma.store.findUnique({
    where: { code: destino },
    select: { id: true, code: true, name: true },
  });
  if (!loja) return { criado: false, porque: `loja de destino ${destino} não existe` };

  const feeders = cards.filter((c) => vivo(c) && !!c.isTransfer && cod(c.transferToStoreCode) === destino);
  const caixas = await caixasDosFeeders(prisma, feeders.map((f) => f.id));
  const status = statusDoReceptor(feeders, caixas);
  const origens = [...new Set(feeders.map((f) => f.storeName || f.storeCode || 'outra loja'))];

  const po: any = await prisma.pickOrder.create({
    data: { orderId, storeId: loja.id, status, isTransfer: false, transferToStoreCode: null },
  });
  await prisma.orderHistory
    .create({
      data: {
        orderId,
        fromStatus: order.status,
        toStatus: order.status,
        userId: opts?.userId ?? null,
        note:
          `🏬 Card de RETIRADA criado na loja ${loja.name} (${loja.code}): a cliente busca lá e nenhuma ` +
          `peça é de lá — ${origens.join(', ')} manda(m) por transferência. ` +
          (status === 'separated'
            ? 'As caixas já deram entrada: falta a cliente buscar.'
            : 'Fica "aguardando a peça chegar" até a caixa dar entrada.') +
          (opts?.motivo ? ` · ${opts.motivo}` : '') +
          (opts?.nome ? ` · por ${opts.nome}` : ''),
      },
    })
    .catch(() => null);

  return { criado: true, pickOrderId: po.id, storeId: loja.id, storeCode: loja.code, storeName: loja.name, status, origens };
}

export type ReceptorAvancado = { pickOrderId: string; storeId: string; storeCode: string; storeName: string; caixas: string[] };

/**
 * A caixa deu entrada na loja de retirada: o receptor sai de "aguardando a
 * peça" pra "peça chegou" (`separated`) quando TODAS as caixas dos
 * alimentadores já chegaram. Só mexe no receptor de verdade — card da loja
 * de destino que tem peça própria segue o bipe normal. Devolve o card
 * avançado, ou `null` quando não havia o que avançar.
 */
export async function avancarReceptorSeCaixasChegaram(prisma: any, orderId: string): Promise<ReceptorAvancado | null> {
  const order: any = await prisma.order.findUnique({ where: { id: orderId }, select: SELECT_PEDIDO });
  if (!order) return null;
  const destino = destinoObrigatorioDoPedido(order);
  if (!destino) return null;

  const cards = cardsDoPedido(order).filter(vivo);
  const receptor = cards.find(
    (c) => !c.isTransfer && cod(c.storeCode) === destino && ['new', 'separating'].includes(String(c.status)),
  );
  if (!receptor) return null;

  const proprias: any[] = await prisma.orderItem.findMany({
    where: { orderId, assignedStoreId: receptor.storeId, cancelledAt: null },
    select: { sku: true, productName: true, quantity: true },
  });
  if (proprias.some((i) => !ehItemSemEstoque(i))) return null; // card comum, não receptor

  const feeders = cards.filter((c) => !!c.isTransfer && cod(c.transferToStoreCode) === destino);
  const caixas = await caixasDosFeeders(prisma, feeders.map((f) => f.id));
  if (statusDoReceptor(feeders, caixas) !== 'separated') return null;

  await prisma.pickOrder.update({ where: { id: receptor.id }, data: { status: 'separated' } });
  const codigos = caixas.map((c) => c.code).filter(Boolean);
  await prisma.orderHistory
    .create({
      data: {
        orderId,
        fromStatus: order.status,
        toStatus: order.status,
        note:
          `📦 ${codigos.length > 1 ? 'Caixas' : 'Caixa'} ${codigos.join(', ')} ${codigos.length > 1 ? 'deram' : 'deu'} entrada na ` +
          `loja de retirada ${receptor.storeName ?? destino} — a peça está lá, falta a cliente buscar. ` +
          'O card liberou "Cliente retirou".',
      },
    })
    .catch(() => null);

  return {
    pickOrderId: receptor.id,
    storeId: receptor.storeId,
    storeCode: destino,
    storeName: receptor.storeName ?? destino,
    caixas: codigos,
  };
}
