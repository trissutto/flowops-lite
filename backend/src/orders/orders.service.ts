import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus } from '../common/enums';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert de pedido vindo do WooCommerce.
   * Retorna o id interno + se deve disparar roteamento.
   */
  async upsertFromWooCommerce(wc: any): Promise<{ orderId: string; shouldRoute: boolean; wasCreated: boolean }> {
    const wcOrderId = Number(wc.id);
    const items = (wc.line_items ?? []).map((li: any) => ({
      sku: String(li.sku || `wc-${li.product_id}`),
      productName: li.name,
      quantity: Number(li.quantity),
      unitPrice: li.price ? Number(li.price) : null,
    }));

    const shipping = wc.shipping ?? {};
    const status = this.mapStatus(wc.status);

    // Data real do WC (quando o cliente fez o pedido no site)
    const wcCreated = wc.date_created_gmt
      ? new Date(wc.date_created_gmt + 'Z')
      : wc.date_created
      ? new Date(wc.date_created)
      : null;

    const payload = {
      wcOrderNumber: String(wc.number ?? wc.id),
      status,
      customerName: `${shipping.first_name ?? ''} ${shipping.last_name ?? ''}`.trim() ||
                    `${wc.billing?.first_name ?? ''} ${wc.billing?.last_name ?? ''}`.trim(),
      customerEmail: wc.billing?.email,
      customerPhone: wc.billing?.phone,
      shippingCep: (shipping.postcode ?? wc.billing?.postcode ?? '').replace(/\D/g, ''),
      shippingAddress: JSON.stringify(shipping),
      totalAmount: wc.total ? Number(wc.total) : null,
      wcDateCreated: wcCreated,
    };

    const existing = await this.prisma.order.findUnique({ where: { wcOrderId } });

    if (existing) {
      // Pode sobrescrever o status se ainda não começou o fluxo operacional.
      // Se já está em separating/ready/shipped/delivered, NÃO mexe.
      const canOverwriteStatus = ['pending', 'processing', 'awaiting_stock', 'cancelled', 'failed'].includes(existing.status);
      const nextStatus = canOverwriteStatus ? status : existing.status;

      await this.prisma.order.update({
        where: { id: existing.id },
        data: { ...payload, status: nextStatus },
      });
      this.logger.log(`Order #${wc.id} atualizado (${existing.status} → ${nextStatus}).`);
      return {
        orderId: existing.id,
        shouldRoute: canOverwriteStatus && nextStatus === OrderStatus.processing,
        wasCreated: false,
      };
    }

    const created = await this.prisma.order.create({
      data: {
        wcOrderId,
        ...payload,
        items: { create: items },
      },
    });
    this.logger.log(`Order #${wc.id} criado (internal ${created.id}, ${items.length} itens, status ${status}).`);
    return {
      orderId: created.id,
      shouldRoute: status === OrderStatus.processing,
      wasCreated: true,
    };
  }

  /**
   * Mapeia status do WooCommerce para status interno do FlowOps.
   *
   * Diferença crítica:
   *   pending    → aguardando pagamento (NÃO separar)
   *   processing → pago, precisa separar (✓ dispara roteamento)
   */
  private mapStatus(wcStatus: string): OrderStatus {
    const s = (wcStatus ?? '').toLowerCase().replace(/^wc-/, '');

    if (['completed', 'delivered', 'entregue', 'finished'].includes(s)) return OrderStatus.delivered;
    if (['cancelled', 'canceled', 'refunded', 'expired', 'pix-expired', 'boleto-expired', 'trash'].includes(s)) return OrderStatus.cancelled;
    if (['failed', 'malsucedido'].includes(s)) return OrderStatus.failed;
    if (['shipped', 'sent', 'enviado', 'dispatched'].includes(s)) return OrderStatus.shipped;
    if (['ready', 'ready-to-ship', 'pronto'].includes(s)) return OrderStatus.ready;

    // PAGOS — prontos pra separação
    if (['processing', 'pago', 'paid', 'approved', 'em-separacao'].includes(s)) return OrderStatus.processing;

    // AGUARDANDO PAGAMENTO
    if (['pending', 'on-hold', 'checkout-draft', 'pending-payment', 'pix-pending', 'boleto-pending', 'aguardando'].includes(s)) return OrderStatus.pending;

    this.logger.debug(`Status WC desconhecido: "${wcStatus}" → mapeado para pending`);
    return OrderStatus.pending;
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.prisma.order.groupBy({
      by: ['status'],
      _count: { status: true },
    });
    const result: Record<string, number> = {};
    for (const r of rows) result[r.status] = r._count.status;
    return result;
  }

  async list(params: { status?: OrderStatus; page?: number; limit?: number }) {
    const take = params.limit ?? 20;
    const skip = ((params.page ?? 1) - 1) * take;
    const where = params.status ? { status: params.status } : {};
    const [data, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where, skip, take,
        orderBy: { createdAt: 'desc' },
        include: { items: true, pickOrders: { include: { store: true } } },
      }),
      this.prisma.order.count({ where }),
    ]);
    return { data, total, page: params.page ?? 1, limit: take };
  }

  async getById(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        items: { include: { assignedStore: true } },
        pickOrders: { include: { store: true } },
        history: { orderBy: { createdAt: 'desc' }, include: { user: true } },
      },
    });
    if (!order) throw new NotFoundException('Pedido não encontrado');
    return order;
  }
}
