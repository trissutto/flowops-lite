import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StockService } from '../stock/stock.service';
import { RoutingEngine } from './routing.engine';
import { SalesStatsService } from './sales-stats.service';
import { OrderStatus, PickStatus } from '../common/enums';
import { RoutingCedeStats, RoutingResult, StockEntry } from './types';
import { buildWhatsappMessage, buildWhatsappUrl } from './whatsapp-message.util';
import { RealtimeGateway } from '../websocket/realtime.gateway';

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly engine: RoutingEngine,
    private readonly gateway: RealtimeGateway,
    private readonly salesStats: SalesStatsService,
  ) {}

  /**
   * Calcula o roteamento SEM persistir (preview para aprovação manual).
   * Retorna também info de contato das lojas para montar mensagens WhatsApp.
   */
  async previewRoute(orderId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true },
    });
    const stores = await this.prisma.store.findMany({ where: { active: true } });
    const skus = order.items.map((i) => i.sku);
    const stock = await this.stock.getStockFor(skus, stores.map((s) => s.code));

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
      stock,
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
      stock: stockEntries,
      shippingCep: input.address.postcode ?? undefined,
      pickupStoreCode: input.pickupStoreCode ?? null,
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

    // 2) stockMap (storeCode+sku → qty) mutável — decrementa a cada alocação
    const stockMap = new Map<string, number>();
    for (const e of stockEntries) {
      stockMap.set(`${e.storeCode}::${e.sku}`, e.availableQty);
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
