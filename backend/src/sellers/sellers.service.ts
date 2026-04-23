import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SellersService — CRUD de vendedoras + atribuição de pedido + relatório.
 *
 * Regra de negócio:
 *   - Soft-delete via `active=false` (mantém histórico das vendas atribuídas)
 *   - Nome é UNIQUE (Prisma) — a service normaliza pra evitar "Karine" vs "KARINE"
 *   - Atribuir pedido: grava sellerId + sellerName (cache) + quem/quando
 *   - Relatório: agrupa pedidos por sellerId no período, soma totalAmount e conta
 */
@Injectable()
export class SellersService {
  private readonly logger = new Logger(SellersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Lista vendedoras — por default só ativas. `includeInactive=true` pra admin. */
  async list(includeInactive = false) {
    return this.prisma.seller.findMany({
      where: includeInactive ? undefined : { active: true },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
  }

  async create(input: { name: string; whatsapp?: string }) {
    const name = (input.name || '').trim();
    if (!name) throw new BadRequestException('Nome é obrigatório.');
    if (name.length > 60) throw new BadRequestException('Nome muito longo (máx 60).');

    // Normaliza: primeira letra maiúscula em cada palavra
    const normalized = name
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    try {
      return await this.prisma.seller.create({
        data: {
          name: normalized,
          whatsapp: input.whatsapp?.trim() || null,
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new BadRequestException(`Já existe uma vendedora com o nome "${normalized}".`);
      }
      throw e;
    }
  }

  async update(id: string, input: { name?: string; whatsapp?: string | null; active?: boolean }) {
    const seller = await this.prisma.seller.findUnique({ where: { id } });
    if (!seller) throw new NotFoundException('Vendedora não encontrada.');

    const data: any = {};
    if (input.name != null) {
      const n = input.name.trim();
      if (!n) throw new BadRequestException('Nome vazio.');
      data.name = n
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }
    if (input.whatsapp !== undefined) data.whatsapp = input.whatsapp?.trim() || null;
    if (input.active !== undefined) data.active = !!input.active;

    try {
      return await this.prisma.seller.update({ where: { id }, data });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new BadRequestException('Já existe uma vendedora com esse nome.');
      }
      throw e;
    }
  }

  /**
   * Atribui uma vendedora a um pedido WC. `sellerId=null` desatribui.
   * Mantém um "cache" do nome em Order.sellerName pra relatórios não dependerem
   * de JOIN (e pra preservar histórico se a vendedora for renomeada depois).
   */
  async assignToOrder(wcOrderId: number, sellerId: string | null, assignedBy?: string) {
    const order = await this.prisma.order.findUnique({ where: { wcOrderId } });
    if (!order) throw new NotFoundException(`Pedido WC #${wcOrderId} não encontrado no sistema.`);

    if (sellerId === null) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          sellerId: null,
          sellerName: null,
          sellerAssignedAt: null,
          sellerAssignedBy: null,
        },
      });
      this.logger.log(`[seller] pedido #${wcOrderId} DESATRIBUIDO por ${assignedBy || '?'}`);
      return { ok: true, seller: null };
    }

    const seller = await this.prisma.seller.findUnique({ where: { id: sellerId } });
    if (!seller) throw new NotFoundException('Vendedora não encontrada.');
    if (!seller.active) throw new BadRequestException('Vendedora está desativada.');

    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        sellerId: seller.id,
        sellerName: seller.name,
        sellerAssignedAt: new Date(),
        sellerAssignedBy: assignedBy || null,
      },
    });

    this.logger.log(`[seller] pedido #${wcOrderId} → ${seller.name} (por ${assignedBy || '?'})`);

    return { ok: true, seller: { id: seller.id, name: seller.name } };
  }

  /**
   * Relatório: pedidos atribuídos no período.
   *
   * Critério de "venda": pedido com status em ['processing','separacao','separated','shipped','completed']
   * — ou seja, não conta pedido cancelado/reembolsado. Período é sobre `wcDateCreated`
   * (data real da venda no site), não sobre `sellerAssignedAt`.
   *
   * Retorna lista agrupada:
   *   [ { sellerId, sellerName, orderCount, totalAmount } ]
   *
   * Inclui linha "Sem atribuição" com pedidos do período que não tem sellerId.
   */
  async report(from: Date, to: Date) {
    const VALID_STATUSES = ['processing', 'separacao', 'separated', 'shipped', 'completed'];

    // Pedidos do período com status válido
    const orders = await this.prisma.order.findMany({
      where: {
        status: { in: VALID_STATUSES },
        OR: [
          { wcDateCreated: { gte: from, lte: to } },
          // fallback: se wcDateCreated for null, usa createdAt
          { AND: [{ wcDateCreated: null }, { createdAt: { gte: from, lte: to } }] },
        ],
      },
      select: {
        id: true,
        wcOrderNumber: true,
        sellerId: true,
        sellerName: true,
        totalAmount: true,
        wcDateCreated: true,
        createdAt: true,
        customerName: true,
      },
      orderBy: { wcDateCreated: 'desc' },
    });

    // Agrupa
    const bucket = new Map<string, { sellerId: string | null; sellerName: string; orderCount: number; totalAmount: number }>();
    for (const o of orders) {
      const key = o.sellerId || '__none__';
      const name = o.sellerName || 'Sem atribuição';
      const cur = bucket.get(key) || { sellerId: o.sellerId, sellerName: name, orderCount: 0, totalAmount: 0 };
      cur.orderCount += 1;
      cur.totalAmount += Number(o.totalAmount || 0);
      bucket.set(key, cur);
    }

    const sellers = Array.from(bucket.values()).sort((a, b) => b.totalAmount - a.totalAmount);

    const totals = {
      orderCount: orders.length,
      totalAmount: orders.reduce((a, o) => a + Number(o.totalAmount || 0), 0),
    };

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      totals,
      sellers,
      orders: orders.map((o) => ({
        wcOrderNumber: o.wcOrderNumber,
        customerName: o.customerName,
        sellerId: o.sellerId,
        sellerName: o.sellerName,
        totalAmount: Number(o.totalAmount || 0),
        date: o.wcDateCreated || o.createdAt,
      })),
    };
  }
}
