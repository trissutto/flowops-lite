import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus } from '../common/enums';
import { extractCpf, detectPickup } from '../woocommerce/wc-order-extract.util';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cache em memória das lojas ativas (TTL 5 min).
   * Evita um findMany em CADA import de pedido (webhook + cada item do poller).
   * Lojas mudam raríssimas vezes; 5 min de defasagem é aceitável.
   */
  private activeStoresCache: { data: Array<{ code: string; name: string; city: string | null }>; expires: number } | null = null;
  private static readonly ACTIVE_STORES_TTL = 5 * 60_000;

  private async getActiveStores() {
    const now = Date.now();
    if (this.activeStoresCache && this.activeStoresCache.expires > now) {
      return this.activeStoresCache.data;
    }
    const data = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true, city: true },
    });
    this.activeStoresCache = { data, expires: now + OrdersService.ACTIVE_STORES_TTL };
    return data;
  }

  /** Invalida o cache de lojas ativas (chamar após criar/editar/desativar loja). */
  invalidateActiveStoresCache() {
    this.activeStoresCache = null;
  }

  /**
   * Upsert de pedido vindo do WooCommerce.
   * Retorna o id interno + se deve disparar roteamento.
   * Quando shouldRoute=true, devolve também os campos usados na emissão WS
   * (evita um findUnique redundante no poller).
   */
  async upsertFromWooCommerce(wc: any): Promise<{
    orderId: string;
    shouldRoute: boolean;
    wasCreated: boolean;
    order?: { id: string; wcOrderNumber: string | null; customerName: string | null; totalAmount: number | null; status: string; createdAt: Date };
  }> {
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

    // CPF do cliente (extraído de meta_data do WC conforme plugin utilizado)
    const customerCpf = extractCpf(wc);

    // Detecta retirada em loja — precisa das stores ativas pra mapear a loja escolhida
    // (cacheado em memória; ver getActiveStores)
    const activeStores = await this.getActiveStores();
    const pickup = detectPickup(wc, activeStores);

    if (pickup.isPickup && !pickup.pickupStoreCode) {
      this.logger.warn(
        `Pedido WC #${wc.id} é retirada em loja mas não mapeou store. ` +
          `Cidade detectada: "${pickup.unresolvedCityName ?? 'nenhuma'}". ` +
          `Método: "${pickup.shippingMethodTitle}". ` +
          `Cadastre a Store correspondente em /lojas.`,
      );
    }

    const payload = {
      wcOrderNumber: String(wc.number ?? wc.id),
      status,
      customerName: `${shipping.first_name ?? ''} ${shipping.last_name ?? ''}`.trim() ||
                    `${wc.billing?.first_name ?? ''} ${wc.billing?.last_name ?? ''}`.trim(),
      customerEmail: wc.billing?.email,
      customerPhone: wc.billing?.phone,
      customerCpf,
      shippingCep: (shipping.postcode ?? wc.billing?.postcode ?? '').replace(/\D/g, ''),
      shippingAddress: JSON.stringify(shipping),
      totalAmount: wc.total ? Number(wc.total) : null,
      isPickup: pickup.isPickup,
      pickupStoreCode: pickup.pickupStoreCode,
      shippingMethod: pickup.shippingMethodTitle,
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
      const shouldRoute = canOverwriteStatus && nextStatus === OrderStatus.processing;
      return {
        orderId: existing.id,
        shouldRoute,
        wasCreated: false,
        order: shouldRoute
          ? {
              id: existing.id,
              wcOrderNumber: payload.wcOrderNumber,
              customerName: payload.customerName,
              totalAmount: payload.totalAmount,
              status: nextStatus,
              createdAt: existing.createdAt,
            }
          : undefined,
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
    const shouldRouteCreated = status === OrderStatus.processing;
    return {
      orderId: created.id,
      shouldRoute: shouldRouteCreated,
      wasCreated: true,
      order: shouldRouteCreated
        ? {
            id: created.id,
            wcOrderNumber: created.wcOrderNumber,
            customerName: created.customerName,
            totalAmount: created.totalAmount,
            status: created.status,
            createdAt: created.createdAt,
          }
        : undefined,
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

  /**
   * Financeiro/Analítico: agrega pedidos no intervalo [from, to] (inclusive).
   *
   * Fonte de verdade: tabela local `orders` (espelho do WC alimentado pelo webhook+poll).
   * Data usada: wcDateCreated (quando o cliente fez o pedido no site). Fallback pra createdAt
   * se wcDateCreated estiver null (pedidos antigos antes do fix).
   *
   * Retorna KPIs agregados + breakdowns (por status / loja / dia / produto / pickup).
   * Pickups, transferências e fretes separados pra o CEO ter visibilidade de origem e destino.
   */
  async analytics(fromStr: string, toStr: string) {
    // Parse das datas do query string (formato YYYY-MM-DD).
    // Usa timezone America/Sao_Paulo (-03:00) porque o CEO pensa em horário local,
    // não em UTC. from = 00:00 de from; to = 23:59:59.999 de to.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toStr)) {
      throw new Error('from e to devem estar no formato YYYY-MM-DD');
    }
    const from = new Date(`${fromStr}T00:00:00-03:00`);
    const to   = new Date(`${toStr}T23:59:59.999-03:00`);
    if (to < from) {
      throw new Error('to deve ser >= from');
    }

    // Coalesce: wcDateCreated se existe, senão createdAt. Filtra inclusive.
    const whereDate = {
      OR: [
        { wcDateCreated: { gte: from, lte: to } },
        { AND: [{ wcDateCreated: null }, { createdAt: { gte: from, lte: to } }] },
      ],
    };

    // 1) Puxa pedidos do período com items e pick-orders (pra saber loja que separou)
    const orders = await this.prisma.order.findMany({
      where: whereDate,
      include: {
        items: true,
        pickOrders: { include: { store: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Cancelados/malsucedidos não contam no faturamento. Quem conta:
    // everything que não for cancelled/failed/refunded (status locais após mapStatus).
    const isFinancial = (s: string) => !['cancelled', 'failed'].includes(s);
    // "Enviado" = tem pelo menos 1 pick-order com status shipped OU order.status shipped/delivered
    const isShipped = (o: typeof orders[number]) =>
      ['shipped', 'delivered'].includes(o.status) ||
      o.pickOrders.some((p) => ['shipped', 'delivered'].includes(p.status));

    // 2) KPIs agregados
    let totalOrders = 0;
    let totalRevenue = 0;
    let cancelledCount = 0;
    let cancelledRevenue = 0;
    let shippedCount = 0;
    let shippedRevenue = 0;
    let pickupCount = 0;
    let pickupRevenue = 0;
    let shippingCount = 0;       // frete (não pickup)
    let shippingRevenue = 0;
    let transferCount = 0;       // pedidos com pelo menos 1 pick-order de transferência
    let inProgressCount = 0;     // ainda não enviado, não cancelado

    for (const o of orders) {
      const amt = Number(o.totalAmount ?? 0);
      totalOrders++;
      if (!isFinancial(o.status)) {
        cancelledCount++;
        cancelledRevenue += amt;
        continue;
      }
      totalRevenue += amt;
      if (isShipped(o)) {
        shippedCount++;
        shippedRevenue += amt;
      } else {
        inProgressCount++;
      }
      if (o.isPickup) {
        pickupCount++;
        pickupRevenue += amt;
      } else {
        shippingCount++;
        shippingRevenue += amt;
      }
      if (o.pickOrders.some((p) => p.isTransfer)) transferCount++;
    }

    // 3) Breakdown por status local
    const byStatusMap = new Map<string, { count: number; revenue: number }>();
    for (const o of orders) {
      const k = o.status;
      const cur = byStatusMap.get(k) ?? { count: 0, revenue: 0 };
      cur.count++;
      cur.revenue += Number(o.totalAmount ?? 0);
      byStatusMap.set(k, cur);
    }
    const byStatus = Array.from(byStatusMap.entries())
      .map(([status, v]) => ({ status, ...v }))
      .sort((a, b) => b.count - a.count);

    // 4) Breakdown por loja que separou (pick-orders não-transferência)
    //    Uma order pode render 1+ pick-orders. Contamos o pick-order, não a order,
    //    pra refletir esforço real de cada loja. Valor: rateado proporcional a itens.
    const byStoreMap = new Map<string, {
      storeCode: string;
      storeName: string;
      pickOrders: number;         // qtd de ordens de separação recebidas
      shipped: number;             // qtd enviadas
      transferOut: number;         // qtd separadas pra transferir pra outra loja
      revenue: number;             // soma do valor dos pedidos (sem ratear)
      approved: number;            // pick-orders com baixa aprovada
    }>();
    for (const o of orders) {
      if (!isFinancial(o.status)) continue;
      const amt = Number(o.totalAmount ?? 0);
      // Dedup: se um pedido tem 2 pick-orders na mesma loja, ainda conta só 1 na revenue da loja.
      const storesHit = new Set<string>();
      for (const p of o.pickOrders) {
        const code = p.store.code;
        const name = p.store.name;
        const cur = byStoreMap.get(code) ?? {
          storeCode: code, storeName: name,
          pickOrders: 0, shipped: 0, transferOut: 0, revenue: 0, approved: 0,
        };
        cur.pickOrders++;
        if (['shipped', 'delivered'].includes(p.status)) cur.shipped++;
        if (p.isTransfer) cur.transferOut++;
        if (p.debitApprovedAt) cur.approved++;
        if (!storesHit.has(code)) {
          cur.revenue += amt / Math.max(1, o.pickOrders.length); // rateia se multi-loja
          storesHit.add(code);
        }
        byStoreMap.set(code, cur);
      }
    }
    const byStore = Array.from(byStoreMap.values())
      .sort((a, b) => b.pickOrders - a.pickOrders);

    // 5) Breakdown por dia (série temporal pra gráfico de linha)
    const byDayMap = new Map<string, { count: number; revenue: number }>();
    for (const o of orders) {
      if (!isFinancial(o.status)) continue;
      const date = o.wcDateCreated ?? o.createdAt;
      // Converte pra YYYY-MM-DD em horário de SP (-03:00)
      const key = new Date(date.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
      const cur = byDayMap.get(key) ?? { count: 0, revenue: 0 };
      cur.count++;
      cur.revenue += Number(o.totalAmount ?? 0);
      byDayMap.set(key, cur);
    }
    const byDay = Array.from(byDayMap.entries())
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // 6) Top produtos (soma quantidade + valor estimado por unitPrice)
    const byProductMap = new Map<string, { sku: string; productName: string; quantity: number; revenue: number }>();
    for (const o of orders) {
      if (!isFinancial(o.status)) continue;
      for (const it of o.items) {
        const cur = byProductMap.get(it.sku) ?? {
          sku: it.sku,
          productName: it.productName ?? '(sem nome)',
          quantity: 0,
          revenue: 0,
        };
        cur.quantity += it.quantity;
        cur.revenue += Number(it.unitPrice ?? 0) * it.quantity;
        byProductMap.set(it.sku, cur);
      }
    }
    const topProducts = Array.from(byProductMap.values())
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 20);

    const avgTicket = totalRevenue > 0 && (totalOrders - cancelledCount) > 0
      ? totalRevenue / (totalOrders - cancelledCount)
      : 0;

    const shipmentRate = (totalOrders - cancelledCount) > 0
      ? shippedCount / (totalOrders - cancelledCount)
      : 0;

    return {
      period: {
        from: fromStr,
        to: toStr,
        days: Math.round((to.getTime() - from.getTime()) / 86400000) + 1,
      },
      kpis: {
        totalOrders,
        totalRevenue,
        avgTicket,
        cancelledCount,
        cancelledRevenue,
        shippedCount,
        shippedRevenue,
        inProgressCount,
        pickupCount,
        pickupRevenue,
        shippingCount,
        shippingRevenue,
        transferCount,
        shipmentRate,
      },
      byStatus,
      byStore,
      byDay,
      topProducts,
    };
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
