import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StockService } from '../stock/stock.service';
import { RoutingEngine } from './routing.engine';
import { OrderStatus, PickStatus } from '../common/enums';
import { RoutingResult } from './types';
import { buildWhatsappMessage, buildWhatsappUrl } from './whatsapp-message.util';

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly engine: RoutingEngine,
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
        shippingAddress: order.shippingAddress,
        shippingCep: order.shippingCep,
        totalAmount: order.totalAmount,
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

    await this.prisma.$transaction(async (tx) => {
      for (const a of result.assignments) {
        await tx.pickOrder.create({
          data: {
            orderId,
            storeId: a.storeId,
            status: PickStatus.new,
          },
        });
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
    shippingMethod: string;
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
      });

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
}
