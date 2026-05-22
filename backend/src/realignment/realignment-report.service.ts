import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealignmentPricingService } from './realignment-pricing.service';

/**
 * RealignmentReportService — gera o relatório executivo + analítico de
 * transferências entre lojas.
 *
 * Fontes:
 *  - RealignmentShipment (Postgres flowops) — remessas
 *  - TransferOrder       (Postgres flowops) — itens individuais
 *  - Store               (Postgres flowops) — nome/cidade
 *  - produtos.VENDAUN    (MySQL Giga)       — preço de venda em centavos
 *
 * O preço é buscado em BATCH via RealignmentPricingService — uma query
 * massiva pra todos os SKUs do período, depois cacheada no calc.
 *
 * Estrutura do retorno casa com o frontend ReportData.
 */
@Injectable()
export class RealignmentReportService {
  private readonly logger = new Logger(RealignmentReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: RealignmentPricingService,
  ) {}

  /**
   * Calcula período em datas concretas.
   */
  private periodToDates(period: string): { from: Date; to: Date } {
    const to = new Date();
    const from = new Date();
    switch (period) {
      case '7d':
        from.setDate(from.getDate() - 7);
        break;
      case '30d':
        from.setDate(from.getDate() - 30);
        break;
      case 'ytd':
        from.setMonth(0, 1);
        from.setHours(0, 0, 0, 0);
        break;
      case '12m':
        from.setMonth(from.getMonth() - 12);
        break;
      case '90d':
      default:
        from.setDate(from.getDate() - 90);
    }
    return { from, to };
  }

  /**
   * Gera o relatório completo.
   */
  async getReport(period: string = '90d') {
    const { from, to } = this.periodToDates(period);

    // 1. Carrega lojas (pra ter nome/cidade)
    const stores = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true, city: true },
      orderBy: { code: 'asc' },
    });

    // 2. Carrega remessas no período
    const shipments = await this.prisma.realignmentShipment.findMany({
      where: {
        openedAt: { gte: from, lte: to },
        status: { in: ['open', 'in_transit', 'received', 'cancelled'] },
      },
      orderBy: { openedAt: 'desc' },
    });

    // 3. Carrega TransferOrders ligados aos shipments
    const shipmentIds = shipments.map((s) => s.id);
    const orders =
      shipmentIds.length > 0
        ? await this.prisma.transferOrder.findMany({
            where: { shipmentId: { in: shipmentIds } },
          })
        : [];

    // 4. Coleta CODIGOs e REFs únicos pra batch fetch de preço
    const codigos = Array.from(
      new Set(
        orders
          .map((o) => (o.codigoBipado || '').trim())
          .filter((c) => c.length > 0),
      ),
    );
    const refs = Array.from(
      new Set(
        orders
          .map((o) => (o.refCode || '').trim())
          .filter((r) => r.length > 0),
      ),
    );

    // 5. Busca preços (VENDAUN) em batch no Giga
    const priceMap = await this.pricing.getPricesByCodigos(codigos);
    const refPriceMap = await this.pricing.getPricesByRefs(refs);

    // 6. Computa preço de cada ordem
    const orderPrices = new Map<string, number>();
    let withoutPriceCount = 0;
    for (const o of orders) {
      const codigo = (o.codigoBipado || '').trim();
      const ref = (o.refCode || '').trim();
      let preco = codigo ? priceMap.get(codigo) || 0 : 0;
      if (preco === 0 && ref) preco = refPriceMap.get(ref) || 0;
      if (preco === 0) withoutPriceCount++;
      orderPrices.set(o.id, preco);
    }
    this.logger.log(
      `getReport ${period}: ${shipments.length} remessas, ${orders.length} itens, ` +
        `${withoutPriceCount} sem preço (${Math.round((withoutPriceCount / Math.max(orders.length, 1)) * 100)}%)`,
    );

    // 7. Agrega por loja
    const storeMap = new Map<
      string,
      {
        code: string;
        name: string;
        city: string;
        sentQty: number;
        sentValue: number;
        receivedQty: number;
        receivedValue: number;
        shipmentsCount: number;
      }
    >();
    for (const s of stores) {
      storeMap.set(s.code, {
        code: s.code,
        name: s.name,
        city: s.city || s.name,
        sentQty: 0,
        sentValue: 0,
        receivedQty: 0,
        receivedValue: 0,
        shipmentsCount: 0,
      });
    }

    // Map shipmentId → { fromCode, toCode } pra resolver origem/destino dos orders
    const shipmentInfoMap = new Map<string, { from: string; to: string }>();
    for (const ship of shipments) {
      shipmentInfoMap.set(ship.id, {
        from: ship.fromStoreCode,
        to: ship.toStoreCode,
      });
    }

    // Conta shipments por loja (1 shipment afeta 2 lojas: origem + destino)
    const shipsCountByStore = new Map<string, number>();
    for (const ship of shipments) {
      if (ship.status === 'cancelled') continue;
      shipsCountByStore.set(ship.fromStoreCode, (shipsCountByStore.get(ship.fromStoreCode) || 0) + 1);
      shipsCountByStore.set(ship.toStoreCode, (shipsCountByStore.get(ship.toStoreCode) || 0) + 1);
    }
    for (const [code, count] of shipsCountByStore.entries()) {
      const st = storeMap.get(code);
      if (st) st.shipmentsCount = count;
    }

    // Soma qty e valor por loja (origem soma sent*, destino soma received*)
    for (const o of orders) {
      const info = shipmentInfoMap.get(o.shipmentId || '');
      if (!info) continue;
      const price = orderPrices.get(o.id) || 0;
      const qty = o.qtyOrigem || 0;
      const value = qty * price;

      // Origem: enviou
      const from = storeMap.get(info.from);
      if (from && o.realignmentStatus !== 'cancelled') {
        from.sentQty += qty;
        from.sentValue += value;
      }
      // Destino: recebeu (só se foi efetivamente recebido)
      if (o.realignmentStatus === 'received') {
        const to = storeMap.get(info.to);
        if (to) {
          to.receivedQty += qty;
          to.receivedValue += value;
        }
      }
    }

    const storeAggregates = Array.from(storeMap.values()).map((s) => ({
      ...s,
      balanceQty: s.receivedQty - s.sentQty,
      balanceValue: s.receivedValue - s.sentValue,
    }));

    // 8. Calcula totais e top
    const totalShipments = shipments.filter((s) => s.status !== 'cancelled').length;
    const totalQty = storeAggregates.reduce((sum, s) => sum + s.sentQty, 0);
    const totalValue = storeAggregates.reduce((sum, s) => sum + s.sentValue, 0);
    const sortedBySent = [...storeAggregates].sort((a, b) => b.sentQty - a.sentQty);
    const sortedByReceived = [...storeAggregates].sort((a, b) => b.receivedQty - a.receivedQty);
    const topSender = sortedBySent[0] || { code: '—', name: '—', sentQty: 0 };
    const topReceiver = sortedByReceived[0] || { code: '—', name: '—', receivedQty: 0 };
    const divergencyQty = shipments.reduce((sum, s) => sum + (s.missingQty || 0), 0);
    const pendingShipments = shipments.filter(
      (s) => s.status === 'open' || s.status === 'in_transit',
    ).length;

    // 9. Lista de transferências (pra tabela)
    const shipmentRows = shipments.map((s) => {
      // Calcula valor total da remessa (soma dos itens)
      const ordersOfShip = orders.filter((o) => o.shipmentId === s.id);
      const totalValueShip = ordersOfShip.reduce(
        (sum, o) => sum + (o.qtyOrigem || 0) * (orderPrices.get(o.id) || 0),
        0,
      );
      return {
        id: s.id,
        code: s.code,
        fromStoreCode: s.fromStoreCode,
        fromStoreName: s.fromStoreName,
        toStoreCode: s.toStoreCode,
        toStoreName: s.toStoreName,
        status: s.status as 'open' | 'in_transit' | 'received' | 'cancelled',
        totalQty: s.totalQty,
        receivedQty: s.receivedQty,
        missingQty: s.missingQty,
        totalValue: Math.round(totalValueShip * 100) / 100,
        openedAt: s.openedAt.toISOString(),
        sentAt: s.sentAt ? s.sentAt.toISOString() : null,
        receivedAt: s.receivedAt ? s.receivedAt.toISOString() : null,
        userResponsible: '—', // poderia buscar do user, simplificando por ora
      };
    });

    // 10. Matriz origem×destino
    const matrixMap = new Map<string, { qty: number; value: number }>();
    for (const o of orders) {
      const info = shipmentInfoMap.get(o.shipmentId || '');
      if (!info || info.from === info.to) continue;
      const key = `${info.from}->${info.to}`;
      const price = orderPrices.get(o.id) || 0;
      const qty = o.qtyOrigem || 0;
      const cur = matrixMap.get(key) || { qty: 0, value: 0 };
      cur.qty += qty;
      cur.value += qty * price;
      matrixMap.set(key, cur);
    }
    const matrix = Array.from(matrixMap.entries()).map(([key, v]) => {
      const [from, to] = key.split('->');
      return { from, to, qty: v.qty, value: Math.round(v.value * 100) / 100 };
    });

    // 11. Evolução mensal (últimos 12 meses pra ter linha completa)
    const monthlyEvolution = this.calculateMonthly(shipments, orders, orderPrices, shipmentInfoMap);

    return {
      period: {
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
      },
      summary: {
        totalShipments,
        totalQty,
        totalValue: Math.round(totalValue * 100) / 100,
        topSender: {
          code: topSender.code,
          name: topSender.name,
          qty: topSender.sentQty,
        },
        topReceiver: {
          code: topReceiver.code,
          name: topReceiver.name,
          qty: topReceiver.receivedQty,
        },
        divergencyQty,
        pendingShipments,
      },
      stores: storeAggregates,
      shipments: shipmentRows,
      monthlyEvolution,
      matrix,
      meta: {
        ordersWithoutPrice: withoutPriceCount,
        ordersTotal: orders.length,
      },
    };
  }

  /**
   * Calcula evolução mensal (últimos 12 meses) — independente do período
   * selecionado, pro gráfico ter contexto.
   */
  private async calculateMonthly(
    shipments: any[],
    orders: any[],
    prices: Map<string, number>,
    shipmentInfoMap: Map<string, { from: string; to: string }>,
  ) {
    const monthNames = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const result: Array<{ month: string; sent: number; received: number; value: number }> = [];
    const now = new Date();

    for (let i = 11; i >= 0; i--) {
      const target = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const next = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const monthShipments = shipments.filter(
        (s) => s.openedAt >= target && s.openedAt < next && s.status !== 'cancelled',
      );
      const monthOrderIds = new Set(
        orders
          .filter((o) => monthShipments.some((s) => s.id === o.shipmentId))
          .map((o) => o.id),
      );
      let sent = 0;
      let received = 0;
      let value = 0;
      for (const o of orders) {
        if (!monthOrderIds.has(o.id)) continue;
        const qty = o.qtyOrigem || 0;
        const price = prices.get(o.id) || 0;
        sent += qty;
        value += qty * price;
        if (o.realignmentStatus === 'received') received += qty;
      }
      result.push({
        month: monthNames[target.getMonth()],
        sent,
        received,
        value: Math.round(value),
      });
    }
    return result;
  }

  /**
   * Detalhe completo de uma transferência específica (modal Nível 3).
   */
  async getShipmentDetail(shipmentId: string) {
    const ship = await this.prisma.realignmentShipment.findUnique({
      where: { id: shipmentId },
    });
    if (!ship) return null;

    const orders = await this.prisma.transferOrder.findMany({
      where: { shipmentId },
      orderBy: { createdAt: 'asc' },
    });

    const codigos = Array.from(
      new Set(orders.map((o) => (o.codigoBipado || '').trim()).filter(Boolean)),
    );
    const refs = Array.from(
      new Set(orders.map((o) => (o.refCode || '').trim()).filter(Boolean)),
    );
    const priceMap = await this.pricing.getPricesByCodigos(codigos);
    const refPriceMap = await this.pricing.getPricesByRefs(refs);

    return {
      shipment: {
        id: ship.id,
        code: ship.code,
        fromStoreCode: ship.fromStoreCode,
        fromStoreName: ship.fromStoreName,
        toStoreCode: ship.toStoreCode,
        toStoreName: ship.toStoreName,
        status: ship.status,
        openedAt: ship.openedAt,
        sentAt: ship.sentAt,
        receivedAt: ship.receivedAt,
        totalQty: ship.totalQty,
        receivedQty: ship.receivedQty,
        missingQty: ship.missingQty,
        notes: ship.notes,
      },
      items: orders.map((o) => {
        const codigo = (o.codigoBipado || '').trim();
        const ref = (o.refCode || '').trim();
        let preco = codigo ? priceMap.get(codigo) || 0 : 0;
        if (preco === 0 && ref) preco = refPriceMap.get(ref) || 0;
        return {
          sku: codigo || ref,
          ref,
          productName: o.descricao || '—',
          cor: o.cor || '—',
          tamanho: o.tamanho || '—',
          qty: o.qtyOrigem,
          receivedQty: o.realignmentStatus === 'received' ? o.qtyOrigem : 0,
          unitCost: preco,
          total: preco * o.qtyOrigem,
          status: o.realignmentStatus || 'pending',
        };
      }),
    };
  }
}
