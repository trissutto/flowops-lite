import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StockService } from '../stock/stock.service';
import { RoutingEngine } from './routing.engine';
import { SalesStatsService } from './sales-stats.service';
import { OrderStatus, PickStatus } from '../common/enums';
import { RoutingCedeStats, RoutingResult, StockEntry } from './types';
import { buildWhatsappMessage, buildWhatsappUrl } from './whatsapp-message.util';
import { RealtimeGateway } from '../websocket/realtime.gateway';
import { ErpService } from '../erp/erp.service';

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly engine: RoutingEngine,
    private readonly gateway: RealtimeGateway,
    private readonly salesStats: SalesStatsService,
    private readonly erp: ErpService,
  ) {}

  /**
   * Calcula o roteamento SEM persistir (preview para aprovação manual).
   * Retorna também info de contato das lojas para montar mensagens WhatsApp.
   */
  async previewRoute(orderId: string, opts?: { excludeStoreCodes?: string[] }) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: true,
        pickOrders: { select: { id: true } }, // pra excluir do `committed` ao recalcular
      },
    });
    const excludeCodes = (opts?.excludeStoreCodes ?? []).filter(Boolean);
    const stores = await this.prisma.store.findMany({
      where: {
        active: true,
        ...(excludeCodes.length ? { code: { notIn: excludeCodes } } : {}),
      },
    });
    const skus = order.items.map((i) => i.sku);
    const storeCodes = stores.map((s) => s.code);
    const stock = await this.stock.getStockFor(skus, storeCodes);

    // Estoque comprometido em pick-orders ativos de OUTROS pedidos (exclui o próprio,
    // pra não descontar a si mesmo se já tinha sido roteado antes — caso de recalcular).
    const ownPickOrderIds = order.pickOrders.map((p) => p.id);
    const committed = await this.getCommittedStock(skus, storeCodes, ownPickOrderIds);
    const liquidStock = this.subtractCommitted(stock, committed);

    const result = this.engine.route({
      items: order.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
      stores: stores.map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        cep: s.cep,
        priorityScore: s.priorityScore,
        active: s.active,
      })),
      stock: liquidStock,
      shippingCep: order.shippingCep,
      pickupStoreCode: order.pickupStoreCode, // ativa lógica de retirada em loja se preenchido
    });

    // enriquece assignments com dados da loja (whatsapp, contato)
    const storeById = new Map(stores.map((s) => [s.id, s]));
    const assignmentsEnriched = result.assignments.map((a) => {
      const s = storeById.get(a.storeId);
      return {
        ...a,
        whatsapp: s?.whatsapp ?? null,
        contactName: s?.contactName ?? null,
        city: s?.city ?? null,
        state: s?.state ?? null,
      };
    });

    return {
      ...result,
      assignments: assignmentsEnriched,
      order: {
        id: order.id,
        wcOrderNumber: order.wcOrderNumber,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        customerCpf: order.customerCpf,
        customerEmail: order.customerEmail,
        shippingAddress: order.shippingAddress,
        shippingCep: order.shippingCep,
        totalAmount: order.totalAmount,
        isPickup: order.isPickup,
        pickupStoreCode: order.pickupStoreCode,
        shippingMethod: order.shippingMethod,
      },
    };
  }

  /**
   * Confirma o resultado de um routing já calculado e persiste no banco.
   * Recebe o result pra garantir que o que o usuário viu é o que foi gravado.
   */
  async confirmRoute(orderId: string, result: RoutingResult) {
    if (!result.success) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.awaiting_stock, routingResult: JSON.stringify(result) },
      });
      return { persisted: false };
    }

    const createdPickOrders: Array<{ id: string; storeId: string }> = [];

    // Snapshot do cliente pra loja fonte saber pra quem enviar (em caso de transferência)
    const orderForSnapshot = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        wcOrderId: true,
        wcOrderNumber: true,
        customerName: true,
        customerCpf: true,
        customerEmail: true,
        customerPhone: true,
        pickupStoreCode: true,
        shippingMethod: true,
      },
    });
    const customerSnapshotJson = JSON.stringify({
      name: orderForSnapshot.customerName,
      cpf: orderForSnapshot.customerCpf,
      email: orderForSnapshot.customerEmail,
      phone: orderForSnapshot.customerPhone,
      pickupStoreCode: orderForSnapshot.pickupStoreCode,
      shippingMethod: orderForSnapshot.shippingMethod,
      wcOrderId: orderForSnapshot.wcOrderId,
      wcOrderNumber: orderForSnapshot.wcOrderNumber,
    });

    await this.prisma.$transaction(async (tx) => {
      for (const a of result.assignments) {
        const po = await tx.pickOrder.create({
          data: {
            orderId,
            storeId: a.storeId,
            status: PickStatus.new,
            isTransfer: a.isTransfer ?? false,
            transferToStoreCode: a.transferToStoreCode ?? null,
            // Snapshot pra loja fonte atender cliente que vai retirar em outra loja
            customerSnapshot: a.isTransfer ? customerSnapshotJson : null,
          },
        });
        createdPickOrders.push({ id: po.id, storeId: a.storeId });
        for (const item of a.items) {
          await tx.orderItem.updateMany({
            where: { orderId, sku: item.sku },
            data: { assignedStoreId: a.storeId },
          });
        }
      }

      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.separating, routingResult: JSON.stringify(result) },
      });

      await tx.orderHistory.create({
        data: {
          orderId,
          fromStatus: OrderStatus.pending,
          toStatus: OrderStatus.separating,
          note: `Aprovado e enviado para ${result.assignments.length} loja(s) via ${result.strategy}.`,
        },
      });
    });

    // Emite por socket pra cada loja — dispara notificação + impressão no app desktop
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          wcOrderId: true,
          wcOrderNumber: true,
          customerName: true,
          customerPhone: true,
          shippingCep: true,
          shippingAddress: true,
          totalAmount: true,
          wcDateCreated: true,
        },
      });

      for (const po of createdPickOrders) {
        const assignment = result.assignments.find((a) => a.storeId === po.storeId);
        const items = await this.prisma.orderItem.findMany({
          where: { orderId, assignedStoreId: po.storeId },
        });

        this.gateway.emitPickOrderToStore(po.storeId, {
          id: po.id,
          status: PickStatus.new,
          storeId: po.storeId,
          orderId,
          order: {
            ...order,
            items,
          },
          strategy: result.strategy,
          storeCode: assignment?.storeCode,
          storeName: assignment?.storeName,
          // ── pickup / transferência ──
          isTransfer: assignment?.isTransfer ?? false,
          transferToStoreCode: assignment?.transferToStoreCode ?? null,
          transferToStoreName: assignment?.transferToStoreName ?? null,
          pickupStoreCode: result.pickupStoreCode ?? null,
          pickupStoreName: result.pickupStoreName ?? null,
        });
      }
    } catch (err: any) {
      this.logger.warn(`Falha ao emitir socket de pick-order novo: ${err?.message ?? err}`);
    }

    return { persisted: true, assignments: result.assignments.length };
  }

  /**
   * Atalho: calcula e persiste em uma única operação (modo automático).
   */
  async routeOrder(orderId: string) {
    const preview = await this.previewRoute(orderId);
    await this.confirmRoute(orderId, preview as any);
    return preview;
  }

  /**
   * RECALCULA a separação de um pedido já roteado.
   *
   * Por que existe: o `confirmSeparation` é idempotente (se já tem pick-order, retorna ele).
   * Quando a matriz quer reatribuir loja (ex: estoque sumiu, peça quebrada, loja offline),
   * precisamos:
   *   1. Cancelar pick-orders ATIVOS (status new/separating) — não mexe em separated/ready/shipped
   *   2. Limpar assignedStoreId dos items
   *   3. Rerodar routing (já considera estoque virtual de OUTROS pedidos)
   *   4. Criar novos pick-orders + emitir socket pras lojas
   *
   * Se o pick-order já estiver em `separated`/`ready`/`shipped` (loja já bipou ou
   * postou), bloqueia recalcular — não dá pra reatribuir uma peça que já saiu.
   *
   * Retorna { ok, cancelledCount, ... } ou { ok: false, reason }.
   */
  async recalculateForWc(
    orderId: string,
    opts?: { excludeStoreIds?: string[]; excludeStoreCodes?: string[]; forceStoreCode?: string },
  ) {
    // Se o caller passou codes (ex: ["MOEMA"]), converte pra IDs antes de seguir.
    // Mantemos o parâmetro original excludeStoreIds pra compat com chamadas internas.
    let extraExcludeIds: string[] = [];
    if (opts?.excludeStoreCodes && opts.excludeStoreCodes.length > 0) {
      const stores = await this.prisma.store.findMany({
        where: { code: { in: opts.excludeStoreCodes } },
        select: { id: true },
      });
      extraExcludeIds = stores.map((s) => s.id);
    }
    const mergedExcludeIds = Array.from(
      new Set([...(opts?.excludeStoreIds ?? []), ...extraExcludeIds]),
    );
    opts = { ...(opts ?? {}), excludeStoreIds: mergedExcludeIds };
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        pickOrders: {
          select: {
            id: true,
            status: true,
            storeId: true,
            issueReason: true,
          } as any,
        },
      },
    });

    // Bloqueio: tem pick-order que já passou de "ativo"
    //
    // EXCEÇÃO: se veio forceStoreCode (escolha manual livre da retaguarda),
    // NÃO bloqueia — vamos mexer só nos pick-orders new/separating, deixando
    // os avançados (shipped/delivered/etc) intactos. Caso típico: pedido com
    // 4 lojas, 1 já enviou (MOEMA), 3 reportaram sem estoque — retaguarda
    // quer consolidar essas 3 numa loja só sem afetar quem já enviou.
    const advanced = order.pickOrders.filter(
      (p) => !['new', 'separating'].includes(p.status),
    );
    if (advanced.length > 0 && !opts?.forceStoreCode) {
      return {
        ok: false as const,
        reason: 'advanced-status',
        message:
          `Não dá pra recalcular: ${advanced.length} pick-order(s) já passaram de "separando" ` +
          `(status: ${[...new Set(advanced.map((a) => a.status))].join(', ')}). ` +
          `Cancele/rejeite manualmente antes de reatribuir. ` +
          `(Pra forçar uma loja específica nos pick-orders ainda em "new/separating", use Escolher loja manualmente.)`,
      };
    }

    // AUTO-EXCLUSÃO: lojas que reportaram problema NESTE pedido são excluídas
    // do recalc (pra não mandar de volta pra mesma loja que disse "sem estoque").
    // Combina com excludeStoreIds opcional vindo do admin (reforço manual).
    const issueReporterStoreIds = order.pickOrders
      .filter((p) => (p as any).issueReason)
      .map((p) => p.storeId);
    const allExcludedStoreIds = Array.from(
      new Set([...(opts?.excludeStoreIds ?? []), ...issueReporterStoreIds]),
    );
    const excludedStores = allExcludedStoreIds.length
      ? await this.prisma.store.findMany({
          where: { id: { in: allExcludedStoreIds } },
          select: { id: true, code: true },
        })
      : [];
    const excludeStoreCodes = excludedStores.map((s) => s.code).filter(Boolean);

    const cancellableIds = order.pickOrders
      .filter((p) => ['new', 'separating'].includes(p.status))
      .map((p) => p.id);
    const advancedStoreIds = advanced.map((p) => p.storeId);

    // Notifica lojas afetadas pra retirar o card do app /minha-loja
    // (só as canceladas — as avançadas continuam com o card delas)
    const cancelledStoreIds = [...new Set(
      order.pickOrders
        .filter((p) => ['new', 'separating'].includes(p.status))
        .map((p) => p.storeId),
    )];

    // 1) Cancela pick-orders cancelaveis + limpa assignedStoreId APENAS dos
    //    items que estavam neles. Items dos pick-orders avançados (já enviados)
    //    ficam intocados. Order volta pra pending pra reatribuir.
    await this.prisma.$transaction(async (tx) => {
      if (cancellableIds.length > 0) {
        await tx.pickOrder.deleteMany({ where: { id: { in: cancellableIds } } });
      }
      // Limpa assignedStoreId só dos items NÃO atribuídos a lojas avançadas
      // (que precisam preservar o vínculo).
      if (advancedStoreIds.length > 0) {
        await tx.orderItem.updateMany({
          where: {
            orderId,
            OR: [
              { assignedStoreId: null },
              { assignedStoreId: { notIn: advancedStoreIds } },
            ],
          },
          data: { assignedStoreId: null },
        });
      } else {
        await tx.orderItem.updateMany({
          where: { orderId },
          data: { assignedStoreId: null },
        });
      }
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.pending, routingResult: null },
      });
      await tx.orderHistory.create({
        data: {
          orderId,
          fromStatus: OrderStatus.separating,
          toStatus: OrderStatus.pending,
          note: `Recalcular separação: ${cancellableIds.length} pick-order(s) cancelado(s) pra reatribuir` +
                (advanced.length > 0 ? ` (${advanced.length} já avançado(s) preservado(s))` : '') + '.',
        },
      });
    });

    // 2) Emite socket pras lojas antigas pra remover o card
    for (const storeId of cancelledStoreIds) {
      try {
        this.gateway.emitPickOrderRemoved?.(storeId, { orderId });
      } catch (err: any) {
        this.logger.warn(`Falha ao emitir remoção de pick-order: ${err?.message ?? err}`);
      }
    }

    // 3a) FORÇA loja específica (escolha manual livre, mesmo SEM estoque).
    // Bypassa o routing — cria 1 pick-order pra loja escolhida.
    //
    // Items que vão pra loja forçada: APENAS os ÓRFÃOS (assignedStoreId = null).
    // Items dos pick-orders avançados (ex: MOEMA já enviou) ficam preservados.
    if (opts?.forceStoreCode) {
      const forcedStore = await this.prisma.store.findFirst({
        where: { code: opts.forceStoreCode },
        select: { id: true, code: true, name: true },
      });
      if (!forcedStore) {
        return {
          ok: false as const,
          reason: 'force-store-not-found',
          message: `Loja ${opts.forceStoreCode} não encontrada/ativa.`,
        };
      }
      // Pega apenas items SEM atribuição (órfãos pós-cancelamento dos new/separating).
      // Items das lojas avançadas continuam com assignedStoreId preservado.
      const orphanItems = await this.prisma.orderItem.findMany({
        where: { orderId, assignedStoreId: null },
        select: { sku: true, quantity: true },
      });
      if (orphanItems.length === 0) {
        return {
          ok: false as const,
          reason: 'no-orphan-items',
          message: 'Não há items disponíveis pra reatribuir — todos já estão em pick-orders avançados.',
        };
      }
      const fakeResult: any = {
        success: true,
        strategy: 'force-manual',
        assignments: [
          {
            storeId: forcedStore.id,
            isTransfer: false,
            items: orphanItems.map((it) => ({ sku: it.sku, qty: it.quantity })),
          },
        ],
      };
      await this.confirmRoute(orderId, fakeResult);
      const newPickOrders = await this.prisma.pickOrder.findMany({
        where: { orderId },
        include: { store: { select: { code: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      return {
        ok: true as const,
        cancelledCount: cancellableIds.length,
        strategy: 'force-manual',
        forcedStoreCode: forcedStore.code,
        excludedStoreCodes: [],
        pickOrders: newPickOrders.map((p) => ({
          id: p.id,
          status: p.status,
          storeCode: p.store.code,
          storeName: p.store.name,
        })),
      };
    }

    // 3b) Roda routing fresco (já considera commited de OUTROS pedidos) + exclui
    // lojas que reportaram problema nesse pedido
    const preview = await this.previewRoute(orderId, { excludeStoreCodes });

    if (!preview.success) {
      return {
        ok: false as const,
        reason: excludeStoreCodes.length ? 'sem-estoque-excluindo-loja' : 'sem-estoque',
        message: excludeStoreCodes.length
          ? `Recalculei excluindo ${excludeStoreCodes.join(', ')} (que reportaram problema) ` +
            `e nenhuma OUTRA loja tem estoque suficiente. Pedido ficou pending — ` +
            `verifique estoque ou divida manualmente.`
          : 'Recalculei e nenhuma loja tem estoque suficiente agora. ' +
            'O pedido voltou pra pending — verifique estoque ou divida manualmente.',
        missing: preview.missing,
        cancelledCount: cancellableIds.length,
        excludedStoreCodes: excludeStoreCodes,
      };
    }

    // 4) Confirma → cria novos pick-orders + emite socket pras lojas novas
    await this.confirmRoute(orderId, preview as any);

    const newPickOrders = await this.prisma.pickOrder.findMany({
      where: { orderId },
      include: { store: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return {
      ok: true as const,
      cancelledCount: cancellableIds.length,
      strategy: preview.strategy,
      excludedStoreCodes: excludeStoreCodes,
      pickOrders: newPickOrders.map((p) => ({
        id: p.id,
        status: p.status,
        storeCode: p.store.code,
        storeName: p.store.name,
      })),
    };
  }

  /**
   * SWAP CIRÚRGICO de UM pick-order específico.
   *
   * Caso de uso: pedido tem split em N lojas, uma delas (ex: Sorocaba) já enviou,
   * outra (ex: Vinhedo) reportou problema e precisa trocar. Um recalc total
   * cancelaria tudo (incluindo Sorocaba que já está shipped). Esse método
   * cancela APENAS o pick-order específico e re-roteia SOMENTE os items que
   * estavam atribuídos pra ele.
   *
   * Pré-condições:
   *  - O pick-order alvo está em new/separating (não pode trocar quem já bipou/enviou)
   *  - Os outros pick-orders do mesmo Order ficam INTOCADOS
   *
   * Steps:
   *  1. Carrega o pick-order alvo + valida status
   *  2. Identifica items atribuídos pra essa loja
   *  3. Cancela o pick-order alvo (delete) + desatribui items (assignedStoreId=null)
   *  4. Roda routing SÓ pros items órfãos, excluindo loja alvo + lojas que reportaram problema
   *  5. Cria novo(s) pick-order(s) pros items órfãos
   *  6. Mantém os outros pick-orders intactos
   *
   * Retorna { ok, newPickOrders, oldStoreCode } ou { ok: false, reason }.
   */
  async swapSinglePickOrder(
    pickOrderId: string,
    opts?: { excludeStoreCodes?: string[]; forceAdvanced?: boolean; forceStoreCode?: string },
  ) {
    const pickOrder = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      include: {
        store: { select: { id: true, code: true, name: true } },
        order: { select: { id: true } },
      },
    });
    if (!pickOrder) {
      return {
        ok: false as const,
        reason: 'pick-order-not-found',
        message: 'Pick-order não encontrado.',
      };
    }

    // Status que requerem ação ESPECIAL antes de trocar:
    //   - separated  → loja bipou mas não enviou. Sem efeito no Giga (baixa
    //                  só rola no shipped). Só apaga pick-order.
    //   - ready      → idem
    //   - shipped    → loja já postou e Giga JÁ FOI BAIXADO. Precisa estornar
    //                  Giga (increaseStock) antes de trocar pra outra loja
    //                  fazer a baixa lá.
    //
    // Permite trocar a qualquer momento — o caller (frontend) já avisou o
    // operador das consequências antes de chamar.
    const ADVANCED_NEEDING_REVERSE = ['shipped', 'delivered'];
    const needsErpReverse = ADVANCED_NEEDING_REVERSE.includes(pickOrder.status);

    const orderId = pickOrder.order.id;
    const oldStoreCode = pickOrder.store.code;
    const oldStoreId = pickOrder.store.id;

    // Items atribuídos pra essa loja (pra re-rotear só eles)
    const itemsAssigned = await this.prisma.orderItem.findMany({
      where: { orderId, assignedStoreId: oldStoreId },
      select: { id: true, sku: true, quantity: true },
    });

    if (itemsAssigned.length === 0) {
      // Pick-order existe mas sem items vinculados — só apaga o pick-order
      await this.prisma.pickOrder.delete({ where: { id: pickOrderId } });
      try {
        this.gateway.emitPickOrderRemoved?.(oldStoreId, { orderId });
      } catch {}
      return {
        ok: false as const,
        reason: 'no-items',
        message: 'Esta loja não tinha items atribuídos. Pick-order removido sem realocação.',
      };
    }

    // Lojas a excluir: alvo (sempre) + lojas que reportaram problema neste pedido
    // + opcionais do admin
    const otherPickOrdersOfOrder = await this.prisma.pickOrder.findMany({
      where: { orderId, id: { not: pickOrderId } },
      select: { storeId: true, status: true, issueReason: true } as any,
    });
    const issueReporterStoreIds = (otherPickOrdersOfOrder as any[])
      .filter((p) => p.issueReason)
      .map((p) => p.storeId);
    // Também exclui lojas que JÁ ESTÃO atendendo o mesmo pedido (não duplica peça)
    const otherActiveStoreIds = (otherPickOrdersOfOrder as any[])
      .filter((p) => ['new', 'separating', 'separated', 'ready', 'shipped'].includes(p.status))
      .map((p) => p.storeId);

    const allExcludedStoreIds = Array.from(
      new Set([oldStoreId, ...issueReporterStoreIds, ...otherActiveStoreIds]),
    );
    const excludedStores = await this.prisma.store.findMany({
      where: { id: { in: allExcludedStoreIds } },
      select: { id: true, code: true },
    });
    const excludeStoreCodes = Array.from(
      new Set([
        ...excludedStores.map((s) => s.code).filter(Boolean),
        ...(opts?.excludeStoreCodes ?? []),
      ]),
    );

    // 1.0) Se loja JÁ ENVIOU (shipped/delivered) → estorna Giga primeiro.
    // Senão a peça fica fantasma em duas lojas (a antiga continua sem ela
    // fisicamente mas Giga acha que foi vendida; a nova vai dar baixa de
    // novo no shipped).
    let erpReverseResult: any = null;
    if (needsErpReverse) {
      try {
        const stockItems = itemsAssigned.map((it: any) => ({
          sku: it.sku,
          qty: it.quantity || 1,
          storeCode: oldStoreCode,
        }));
        erpReverseResult = await this.erp.increaseStock(stockItems);
        if (erpReverseResult.success) {
          this.logger.log(
            `[swap] estorno Giga OK pra loja ${oldStoreCode}: ${itemsAssigned.length} item(ns) voltaram pro estoque`,
          );
        } else {
          this.logger.warn(
            `[swap] estorno Giga FALHOU pra loja ${oldStoreCode}: ${erpReverseResult.error}. Continuando swap mesmo assim — operador deve corrigir manualmente.`,
          );
        }
      } catch (e: any) {
        this.logger.error(`[swap] estorno Giga exception: ${e?.message || e}`);
      }
    }

    // 1) Cancela o pick-order alvo + desatribui SOMENTE os items dele
    await this.prisma.$transaction(async (tx) => {
      await tx.pickOrder.delete({ where: { id: pickOrderId } });
      await tx.orderItem.updateMany({
        where: { orderId, assignedStoreId: oldStoreId },
        data: { assignedStoreId: null },
      });
      await tx.orderHistory.create({
        data: {
          orderId,
          fromStatus: pickOrder.status,
          toStatus: 'separating',
          note:
            `Swap cirúrgico: pick-order da loja ${oldStoreCode} cancelado (status era "${pickOrder.status}") pra reatribuir ` +
            `${itemsAssigned.length} item(ns). ` +
            (needsErpReverse
              ? `Estorno Giga: ${erpReverseResult?.success ? 'OK' : 'FALHOU (' + (erpReverseResult?.error || 'erro') + ')'}. `
              : '') +
            `Outros pick-orders intactos.`,
        },
      });
    });

    // 2) Notifica loja antiga pra remover o card do app
    try {
      this.gateway.emitPickOrderRemoved?.(oldStoreId, { orderId });
    } catch (err: any) {
      this.logger.warn(`Falha ao emitir remoção de pick-order: ${err?.message ?? err}`);
    }

    // 3) Roteamento: se forceStoreCode foi passado (escolha manual livre da
    // retaguarda), bypassa o routing e cria pick-order direto pra essa loja
    // com os items órfãos. Senão, usa previewRoute normal.
    if (opts?.forceStoreCode) {
      const forcedStore = await this.prisma.store.findFirst({
        where: { code: opts.forceStoreCode },
        select: { id: true, code: true, name: true },
      });
      if (!forcedStore) {
        return {
          ok: false as const,
          reason: 'force-store-not-found',
          message: `Loja ${opts.forceStoreCode} não encontrada/ativa.`,
        };
      }
      const fakeResult: any = {
        success: true,
        strategy: 'swap-force-manual',
        assignments: [
          {
            storeId: forcedStore.id,
            isTransfer: false,
            items: itemsAssigned.map((it: any) => ({ sku: it.sku, qty: it.quantity })),
          },
        ],
      };
      await this.confirmRoute(orderId, fakeResult);
      const newPickOrders = await this.prisma.pickOrder.findMany({
        where: { orderId, storeId: forcedStore.id },
        include: { store: { select: { code: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      return {
        ok: true as const,
        oldStoreCode,
        forcedStoreCode: forcedStore.code,
        itemsReassigned: itemsAssigned.length,
        pickOrders: newPickOrders.map((p) => ({
          id: p.id,
          status: p.status,
          storeCode: p.store.code,
          storeName: p.store.name,
        })),
      };
    }

    // Senão: routing automático (busca loja com estoque, exclui as problemáticas)
    const preview = await this.previewRoute(orderId, { excludeStoreCodes });

    if (!preview.success) {
      return {
        ok: false as const,
        reason: 'sem-estoque-excluindo-loja',
        message:
          `Cancelei o pick-order da ${oldStoreCode} mas nenhuma OUTRA loja tem ` +
          `estoque pra ${itemsAssigned.length} item(ns). Items ficaram sem loja — ` +
          `verifique estoque ou divida manualmente.`,
        missing: preview.missing,
        oldStoreCode,
        excludedStoreCodes: excludeStoreCodes,
      };
    }

    // 4) Confirma criando APENAS pick-orders pra items que ainda não estão atribuídos
    // (preserva os pick-orders das outras lojas que já estavam OK)
    await this.confirmRoute(orderId, preview as any);

    const newPickOrders = await this.prisma.pickOrder.findMany({
      where: {
        orderId,
        storeId: { not: oldStoreId },
        // Pega só os pick-orders criados agora (created após início do método)
      },
      include: { store: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return {
      ok: true as const,
      oldStoreCode,
      excludedStoreCodes: excludeStoreCodes,
      itemsReassigned: itemsAssigned.length,
      pickOrders: newPickOrders.map((p) => ({
        id: p.id,
        status: p.status,
        storeCode: p.store.code,
        storeName: p.store.name,
      })),
    };
  }

  /**
   * ESTOQUE COMPROMETIDO em pick-orders ATIVOS (status new/separating/separated).
   *
   * Pra cada (storeCode, sku), retorna a soma de quantidades já alocadas em
   * pick-orders que ainda NÃO foram baixados (separated ainda aguarda matriz aprovar).
   * Quando pick-order vai pra `ready` (após approve-debit) ou `shipped`, o estoque já
   * caiu no Giga (ou cai logo, se ERP_WRITE_ENABLED), então não conta mais.
   *
   * `excludePickOrderIds` permite ignorar pick-orders do próprio pedido sendo recalculado
   * (pra não descontar a si mesmo do estoque disponível).
   *
   * RETORNO: Map com chave `${storeCode}::${sku}` → qty comprometida
   */
  async getCommittedStock(
    skus: string[],
    storeCodes: string[],
    excludePickOrderIds: string[] = [],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!skus.length || !storeCodes.length) return out;

    // FLAG GLOBAL: anti-overbooking desligado por padrão.
    // Justificativa: lojista prefere PROMETER a venda (peça pode estar fisicamente
    // disponível mesmo "comprometida" — pedido conflitante pode ser cancelado,
    // pode haver divergência ERP×físico, etc). Routing usa estoque REAL do Giga.
    // Pra ativar proteção contra overbooking, setar `ROUTING_ANTI_OVERBOOKING=true`.
    if (process.env.ROUTING_ANTI_OVERBOOKING !== 'true') {
      return out; // map vazio → subtractCommitted não tira nada → liquid = real
    }

    // Map storeId → storeCode (engine trabalha com storeCode mas FK é storeId)
    const stores = await this.prisma.store.findMany({
      where: { code: { in: storeCodes } },
      select: { id: true, code: true },
    });
    const codeByStoreId = new Map(stores.map((s) => [s.id, s.code]));
    const storeIds = stores.map((s) => s.id);
    if (storeIds.length === 0) return out;

    // Pick-orders ATIVOS (não enviados / não baixados)
    const activePickOrders = await this.prisma.pickOrder.findMany({
      where: {
        storeId: { in: storeIds },
        status: { in: ['new', 'separating', 'separated'] },
        ...(excludePickOrderIds.length > 0 ? { id: { notIn: excludePickOrderIds } } : {}),
      },
      select: { id: true, orderId: true, storeId: true },
    });
    if (activePickOrders.length === 0) return out;

    const orderIds = [...new Set(activePickOrders.map((p) => p.orderId))];

    // Items desses pedidos com SKU dentro do conjunto pedido
    const items = await this.prisma.orderItem.findMany({
      where: {
        orderId: { in: orderIds },
        sku: { in: skus },
      },
      select: { orderId: true, sku: true, quantity: true, assignedStoreId: true },
    });

    // Agrupa por (storeCode, sku):
    //   - se item tem assignedStoreId → usa esse (split pode ter ido pra outra loja)
    //   - senão, usa storeId do pick-order daquele orderId (fallback)
    const pickStoreByOrderId = new Map<string, string>();
    for (const po of activePickOrders) {
      // Quando o pedido está em múltiplas lojas, mantemos o último (ou primeiro), o
      // ramo abaixo só é usado quando assignedStoreId está null — e nesse caso o pedido
      // não foi splitado (1 loja só), então qualquer pick-order serve.
      pickStoreByOrderId.set(po.orderId, po.storeId);
    }

    for (const it of items) {
      const targetStoreId = it.assignedStoreId ?? pickStoreByOrderId.get(it.orderId) ?? null;
      if (!targetStoreId) continue;
      const code = codeByStoreId.get(targetStoreId);
      if (!code) continue;
      const key = `${code}::${it.sku}`;
      out.set(key, (out.get(key) ?? 0) + it.quantity);
    }

    return out;
  }

  /**
   * Aplica `committed` num array de StockEntry, retornando estoque LÍQUIDO (real - reservado).
   * Linhas que ficariam com qty <= 0 são removidas pra não confundir o engine.
   */
  private subtractCommitted(
    stockEntries: StockEntry[],
    committed: Map<string, number>,
  ): StockEntry[] {
    if (committed.size === 0) return stockEntries;
    const out: StockEntry[] = [];
    for (const e of stockEntries) {
      const reserved = committed.get(`${e.storeCode}::${e.sku}`) ?? 0;
      const liquid = e.availableQty - reserved;
      if (liquid > 0) out.push({ ...e, availableQty: liquid });
    }
    return out;
  }

  /**
   * Pick-orders ATIVOS do pedido WC informado (pode não existir Order local ainda → []).
   * Usado pra excluir o próprio pedido do `committed` ao rodar preview/recalcular.
   */
  private async findOwnPickOrderIdsForWc(wcOrderId: number): Promise<string[]> {
    const order = await this.prisma.order.findFirst({
      where: { wcOrderId },
      select: {
        pickOrders: {
          where: { status: { in: ['new', 'separating', 'separated'] } },
          select: { id: true },
        },
      },
    });
    return order?.pickOrders.map((p) => p.id) ?? [];
  }

  /**
   * Preview de separação para um pedido que veio direto do WooCommerce
   * (sem passar pelo banco local). Usa a mesma engine: tenta 1 loja só,
   * se não der, divide entre múltiplas lojas.
   *
   * Recebe os dados já extraídos do WC pra não criar dep circular com
   * WooCommerceService (o controller de orders faz o fetch).
   */
  async previewSeparationForWc(input: {
    wcOrderId: number;
    wcOrderNumber: string;
    orderDateIso: string;
    totalAmount: number;
    paymentMethod: string;
    items: Array<{ sku: string; quantity: number; productName: string; variant?: string }>;
    customerName: string;
    customerPhone?: string | null;
    customerEmail?: string | null;
    customerCpf?: string | null;
    shippingMethod: string;
    /** Se preenchido, força retirada em loja nessa store (já resolvido pelo controller). */
    pickupStoreCode?: string | null;
    isPickup?: boolean;
    /**
     * Loja preferida (override manual via radio button). Se cobrir todos os
     * itens, vira a loja escolhida em vez do pickBest automático.
     */
    preferStoreCode?: string | null;
    address: {
      street?: string | null;
      number?: string | null;
      complement?: string | null;
      neighborhood?: string | null;
      city?: string | null;
      state?: string | null;
      postcode?: string | null;
    };
    orderUrl?: string;
  }) {
    const validItems = input.items.filter((i) => i.sku?.trim());
    if (validItems.length === 0) {
      throw new BadRequestException(
        'Nenhum item do pedido tem SKU preenchido. Não dá pra localizar estoque.',
      );
    }

    const stores = await this.prisma.store.findMany({ where: { active: true } });
    if (stores.length === 0) {
      throw new BadRequestException(
        'Nenhuma loja ativa cadastrada. Cadastra pelo menos uma em /lojas.',
      );
    }

    const skus = [...new Set(validItems.map((i) => i.sku))];
    const storeCodes = stores.map((s) => s.code);
    const stockEntries = await this.stock.getStockFor(skus, storeCodes);

    // Estoque comprometido em pick-orders ativos de OUTROS pedidos (mesma engine
    // do previewRoute pra evitar prometer a mesma peça duas vezes). Quando esse
    // preview é pra recalcular um pedido WC já roteado, descontamos os pick-orders
    // do próprio (vão ser cancelados/recriados pelo recalcular).
    const ownPickOrderIds = await this.findOwnPickOrderIdsForWc(input.wcOrderId);
    const committed = await this.getCommittedStock(skus, storeCodes, ownPickOrderIds);
    const liquidStock = this.subtractCommitted(stockEntries, committed);

    const result = this.engine.route({
      items: validItems.map((i) => ({ sku: i.sku, quantity: i.quantity })),
      stores: stores.map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        cep: s.cep,
        priorityScore: s.priorityScore,
        active: s.active,
      })),
      stock: liquidStock,
      shippingCep: input.address.postcode ?? undefined,
      pickupStoreCode: input.pickupStoreCode ?? null,
      preferStoreCode: input.preferStoreCode ?? null,
    });

    // Enriquece cada grupo com dados da loja + itens completos + mensagem WhatsApp
    const storeById = new Map(stores.map((s) => [s.id, s]));
    const itemBySku = new Map(validItems.map((i) => [i.sku, i]));

    const groups = result.assignments.map((a) => {
      const store = storeById.get(a.storeId);
      const groupItems = a.items.map((ai) => {
        const full = itemBySku.get(ai.sku);
        return {
          sku: ai.sku,
          quantity: ai.quantity,
          productName: full?.productName ?? '',
          variant: full?.variant,
        };
      });

      const message = buildWhatsappMessage({
        wcOrderNumber: input.wcOrderNumber,
        orderDateIso: input.orderDateIso,
        totalAmount: input.totalAmount,
        paymentMethod: input.paymentMethod,
        items: groupItems,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        shippingMethod: input.shippingMethod,
        address: input.address,
        storeName: store?.name,
        orderUrl: input.orderUrl,
        // Sinaliza transferência na própria mensagem pra loja fonte saber
        isTransfer: a.isTransfer ?? false,
        transferToStoreName: a.transferToStoreName ?? null,
        customerCpf: input.customerCpf ?? null,
        customerEmail: input.customerEmail ?? null,
      } as any);

      return {
        storeId: a.storeId,
        storeCode: a.storeCode,
        storeName: a.storeName,
        storeCity: store?.city ?? null,
        storeState: store?.state ?? null,
        whatsapp: store?.whatsapp ?? null,
        contactName: store?.contactName ?? null,
        items: groupItems,
        whatsappMessage: message,
        whatsappUrl: buildWhatsappUrl(store?.whatsapp, message),
        // ── pickup / transferência ──
        isTransfer: a.isTransfer ?? false,
        transferToStoreCode: a.transferToStoreCode ?? null,
        transferToStoreName: a.transferToStoreName ?? null,
      };
    });

    // Lojas alternativas (que também têm estoque) pra override manual
    const alternativesBySku: Record<string, Array<{ storeId: string; storeCode: string; storeName: string; availableQty: number; whatsapp: string | null }>> = {};
    for (const sku of skus) {
      alternativesBySku[sku] = stores
        .map((s) => {
          const stk = stockEntries.find((e) => e.storeCode === s.code && e.sku === sku);
          return {
            storeId: s.id,
            storeCode: s.code,
            storeName: s.name,
            availableQty: stk?.availableQty ?? 0,
            whatsapp: s.whatsapp ?? null,
          };
        })
        .filter((x) => x.availableQty > 0)
        .sort((a, b) => b.availableQty - a.availableQty);
    }

    // ── Lojas alternativas que TAMBÉM cobrem o pedido inteiro ──
    // Pega TODAS as lojas marcadas como fullCoverage=true no scoreBreakdown,
    // remove a loja escolhida (groups[0].storeCode) e devolve as top 5 ordenadas
    // por estoque disponível (pra UI mostrar como radio buttons "outras opções").
    // Só faz sentido em single-store — em multi/pickup/insufficient deixa vazio.
    const chosenStoreCode = groups[0]?.storeCode;
    const alternativeFullStores =
      result.strategy === 'single-store'
        ? (result.scoreBreakdown || [])
            .filter((sb) => sb.fullCoverage && sb.storeCode !== chosenStoreCode)
            .sort((a, b) => b.stockBuffer - a.stockBuffer)
            .slice(0, 5)
            .map((sb) => ({
              storeCode: sb.storeCode,
              storeName: sb.storeName,
              stockBuffer: sb.stockBuffer,
              finalScore: sb.finalScore,
            }))
        : [];

    return {
      success: result.success,
      strategy: result.strategy,
      shippingMethod: input.shippingMethod,
      isPickup: input.isPickup ?? false,
      pickupStoreCode: result.pickupStoreCode ?? input.pickupStoreCode ?? null,
      pickupStoreName: result.pickupStoreName ?? null,
      customer: {
        name: input.customerName,
        cpf: input.customerCpf ?? null,
        email: input.customerEmail ?? null,
        phone: input.customerPhone ?? null,
      },
      groups,
      missing: result.missing.map((m) => {
        const full = itemBySku.get(m.sku);
        return {
          sku: m.sku,
          quantity: m.quantity,
          productName: full?.productName ?? '',
        };
      }),
      alternativesBySku,
      alternativeFullStores,
      scoreBreakdown: result.scoreBreakdown ?? [],
    };
  }

  /**
   * BATELADA DE PEDIDOS — rota N pedidos de uma vez com:
   *   1. ESTOQUE VIRTUAL compartilhado (a mesma peça não é alocada pra 2 pedidos)
   *   2. PROPORCIONALIDADE INVERSA baseada em venda 30d (cede quem vendeu menos)
   *
   * Uso esperado: matriz clica "Separar todos os pedidos de hoje" na tela da fila
   * WC. Em vez de chamar previewSeparationForWc N vezes (cada uma com estoque
   * fresco), esse método roda N em sequência mantendo:
   *   - um `stockMap` que decrementa a cada assignment feito (memoria local)
   *   - um `cedeStats` que incrementa `currentCedeByStore` a cada peça alocada
   *
   * Retorna uma lista de preview[] — cada item é estruturalmente igual ao
   * retorno de previewSeparationForWc (groups/missing/scoreBreakdown...).
   *
   * Não persiste — preview pra aprovação manual antes de chamar confirmRoute
   * batch ou confirmSeparationForWc por pedido.
   */
  async previewBatchForWc(
    orders: Array<Parameters<RoutingService['previewSeparationForWc']>[0]>,
  ) {
    if (!orders?.length) return { previews: [], cedeSummary: null };

    const stores = await this.prisma.store.findMany({ where: { active: true } });
    if (stores.length === 0) {
      throw new BadRequestException(
        'Nenhuma loja ativa cadastrada. Cadastra pelo menos uma em /lojas.',
      );
    }
    const storeCodes = stores.map((s) => s.code);

    // 1) coleta TODOS os SKUs da batelada pra fazer UM fetch só de estoque
    const allSkus = new Set<string>();
    for (const o of orders) {
      for (const it of o.items) {
        if (it.sku && it.sku.trim()) allSkus.add(it.sku.trim());
      }
    }
    const stockEntries = await this.stock.getStockFor([...allSkus], storeCodes);

    // Estoque comprometido em pick-orders ativos de pedidos FORA da batelada (excluindo
    // os pick-orders dos próprios pedidos WC sendo recalculados, se existirem).
    const ownPickOrderIdsArr = await Promise.all(
      orders.map((o) => this.findOwnPickOrderIdsForWc(o.wcOrderId)),
    );
    const ownPickOrderIds = ownPickOrderIdsArr.flat();
    const committedExternal = await this.getCommittedStock(
      [...allSkus],
      storeCodes,
      ownPickOrderIds,
    );

    // 2) stockMap (storeCode+sku → qty) mutável — decrementa a cada alocação INTERNA
    //    da batelada. O baseline JÁ vem reduzido pelo committed externo.
    const stockMap = new Map<string, number>();
    for (const e of stockEntries) {
      const reserved = committedExternal.get(`${e.storeCode}::${e.sku}`) ?? 0;
      const liquid = Math.max(0, e.availableQty - reserved);
      stockMap.set(`${e.storeCode}::${e.sku}`, liquid);
    }
    const getStock = (storeCode: string, sku: string) =>
      stockMap.get(`${storeCode}::${sku}`) ?? 0;

    // 3) calcula targetQuota por loja (elegíveis = todas ativas)
    const quotas = await this.salesStats.getCedeQuotas(storeCodes, 30);
    const cedeStats: RoutingCedeStats = {
      targetQuotaByStore: quotas.targetQuotaByStore,
      salesShareByStore: quotas.salesShareByStore,
      currentCedeByStore: Object.fromEntries(storeCodes.map((c) => [c, 0])),
      totalCedeSoFar: 0,
      windowDays: quotas.windowDays,
    };

    const previews: any[] = [];

    // 4) roda pedido por pedido usando o mesmo stockMap + cedeStats
    for (const input of orders) {
      const validItems = input.items.filter((i) => i.sku?.trim());
      if (validItems.length === 0) {
        previews.push({
          wcOrderNumber: input.wcOrderNumber,
          success: false,
          strategy: 'insufficient-stock',
          missing: input.items.map((i) => ({
            sku: i.sku,
            quantity: i.quantity,
            productName: i.productName,
          })),
          groups: [],
          error: 'Nenhum item tem SKU.',
        });
        continue;
      }

      // reconstrói stock entries a partir do stockMap ATUALIZADO (pra esse pedido
      // enxergar as baixas virtuais dos pedidos anteriores da batelada).
      const skusThis = [...new Set(validItems.map((i) => i.sku.trim()))];
      const stockForEngine: StockEntry[] = [];
      for (const sku of skusThis) {
        for (const code of storeCodes) {
          const qty = getStock(code, sku);
          if (qty > 0) {
            stockForEngine.push({ storeCode: code, sku, availableQty: qty });
          }
        }
      }

      const result = this.engine.route({
        items: validItems.map((i) => ({ sku: i.sku, quantity: i.quantity })),
        stores: stores.map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          cep: s.cep,
          priorityScore: s.priorityScore,
          active: s.active,
        })),
        stock: stockForEngine,
        shippingCep: input.address?.postcode ?? undefined,
        pickupStoreCode: input.pickupStoreCode ?? null,
        cedeStats, // <-- HABILITA proporcionalidade
      });

      // 5) DECREMENTA stock virtual + incrementa cede counters
      //    (só faz isso nos assignments que são VENDA SITE = não-transfer pickup;
      //    transfer-to-pickup também debita porque a peça sai do estoque da loja fonte)
      for (const a of result.assignments) {
        for (const it of a.items) {
          const key = `${a.storeCode}::${it.sku}`;
          const cur = stockMap.get(key) ?? 0;
          const next = Math.max(0, cur - it.quantity);
          stockMap.set(key, next);
        }

        // Só conta como "cessão" quando a loja está atendendo pedido de ENVIO (site),
        // não quando o cliente escolheu RETIRAR na própria loja (pickup-lock),
        // porque nesse caso a peça é vendida LOCALMENTE, não cedida ao e-commerce.
        const isPickupLockAtSelf = result.strategy === 'pickup-lock';
        if (!isPickupLockAtSelf) {
          const qtyCedida = a.items.reduce((s, it) => s + it.quantity, 0);
          cedeStats.currentCedeByStore[a.storeCode] =
            (cedeStats.currentCedeByStore[a.storeCode] ?? 0) + qtyCedida;
          cedeStats.totalCedeSoFar += qtyCedida;
        }
      }

      // 6) monta preview igual ao previewSeparationForWc
      const storeById = new Map(stores.map((s) => [s.id, s]));
      const itemBySku = new Map(validItems.map((i) => [i.sku, i]));
      const groups = result.assignments.map((a) => {
        const store = storeById.get(a.storeId);
        const groupItems = a.items.map((ai) => {
          const full = itemBySku.get(ai.sku);
          return {
            sku: ai.sku,
            quantity: ai.quantity,
            productName: full?.productName ?? '',
            variant: full?.variant,
          };
        });
        const message = buildWhatsappMessage({
          wcOrderNumber: input.wcOrderNumber,
          orderDateIso: input.orderDateIso,
          totalAmount: input.totalAmount,
          paymentMethod: input.paymentMethod,
          items: groupItems,
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          shippingMethod: input.shippingMethod,
          address: input.address,
          storeName: store?.name,
          orderUrl: input.orderUrl,
          isTransfer: a.isTransfer ?? false,
          transferToStoreName: a.transferToStoreName ?? null,
          customerCpf: input.customerCpf ?? null,
          customerEmail: input.customerEmail ?? null,
        } as any);
        return {
          storeId: a.storeId,
          storeCode: a.storeCode,
          storeName: a.storeName,
          storeCity: store?.city ?? null,
          storeState: store?.state ?? null,
          whatsapp: store?.whatsapp ?? null,
          contactName: store?.contactName ?? null,
          items: groupItems,
          whatsappMessage: message,
          whatsappUrl: buildWhatsappUrl(store?.whatsapp, message),
          isTransfer: a.isTransfer ?? false,
          transferToStoreCode: a.transferToStoreCode ?? null,
          transferToStoreName: a.transferToStoreName ?? null,
        };
      });

      previews.push({
        wcOrderId: input.wcOrderId,
        wcOrderNumber: input.wcOrderNumber,
        success: result.success,
        strategy: result.strategy,
        shippingMethod: input.shippingMethod,
        isPickup: input.isPickup ?? false,
        pickupStoreCode: result.pickupStoreCode ?? input.pickupStoreCode ?? null,
        pickupStoreName: result.pickupStoreName ?? null,
        customer: {
          name: input.customerName,
          cpf: input.customerCpf ?? null,
          email: input.customerEmail ?? null,
          phone: input.customerPhone ?? null,
        },
        groups,
        missing: result.missing.map((m) => {
          const full = itemBySku.get(m.sku);
          return {
            sku: m.sku,
            quantity: m.quantity,
            productName: full?.productName ?? '',
          };
        }),
        scoreBreakdown: result.scoreBreakdown ?? [],
      });
    }

    // 7) Snapshot final do cedeStats pra UI mostrar equilíbrio alcançado
    const cedeSummary = {
      windowDays: cedeStats.windowDays ?? 30,
      totalCedeSoFar: cedeStats.totalCedeSoFar,
      byStore: storeCodes.map((code) => {
        const ceded = cedeStats.currentCedeByStore[code] ?? 0;
        const quota = cedeStats.targetQuotaByStore[code] ?? 0;
        const salesShare = cedeStats.salesShareByStore?.[code] ?? 0;
        const actualShare = cedeStats.totalCedeSoFar > 0 ? ceded / cedeStats.totalCedeSoFar : 0;
        const store = stores.find((s) => s.code === code);
        return {
          storeCode: code,
          storeName: store?.name ?? code,
          salesShare: Number(salesShare.toFixed(4)),
          targetQuota: Number(quota.toFixed(4)),
          ceded,
          actualShare: Number(actualShare.toFixed(4)),
          delta: Number((quota - actualShare).toFixed(4)),
        };
      }),
    };

    return { previews, cedeSummary };
  }
}
