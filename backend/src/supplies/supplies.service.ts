import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Prisma client ainda não foi regenerado localmente pros novos models (SupplyItem,
// SupplyRequest, SupplyRequestItem). Usamos `as any` nos acessos aos delegates.
// No deploy (Railway), `prisma generate` roda antes do build e tipa corretamente.

export type SupplyItemInput = {
  sku?: string | null;
  name: string;
  category?: string | null;
  unit?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  active?: boolean;
  minQty?: number | null;
};

export type SupplyRequestStatus =
  | 'pending'
  | 'approved'
  | 'separating'
  | 'shipped'
  | 'delivered'
  | 'cancelled';

// Transições válidas. Qualquer outra é rejeitada.
const STATUS_TRANSITIONS: Record<string, string[]> = {
  pending:    ['approved', 'cancelled'],
  approved:   ['separating', 'cancelled'],
  separating: ['shipped', 'cancelled'],
  shipped:    ['delivered'],
  delivered:  [],
  cancelled:  [],
};

@Injectable()
export class SuppliesService {
  constructor(private readonly prisma: PrismaService) {}

  // ============================================================
  // SUPPLY ITEMS (catálogo do almoxarifado)
  // ============================================================

  async listItems(opts?: { onlyActive?: boolean }) {
    const where: any = {};
    if (opts?.onlyActive) where.active = true;
    return (this.prisma as any).supplyItem.findMany({
      where,
      orderBy: [{ active: 'desc' }, { category: 'asc' }, { name: 'asc' }],
    });
  }

  async createItem(body: SupplyItemInput) {
    if (!body?.name || body.name.trim().length < 2) {
      throw new BadRequestException('Nome é obrigatório.');
    }
    return (this.prisma as any).supplyItem.create({
      data: {
        sku: body.sku?.trim() || null,
        name: body.name.trim(),
        category: body.category?.trim() || null,
        unit: (body.unit || 'un').trim(),
        description: body.description?.trim() || null,
        imageUrl: body.imageUrl?.trim() || null,
        active: body.active !== false,
        minQty: typeof body.minQty === 'number' ? body.minQty : null,
      },
    });
  }

  async updateItem(id: string, body: SupplyItemInput) {
    const data: any = {};
    if (body.sku !== undefined) data.sku = body.sku?.trim() || null;
    if (body.name !== undefined) {
      if (body.name.trim().length < 2) throw new BadRequestException('Nome inválido.');
      data.name = body.name.trim();
    }
    if (body.category !== undefined) data.category = body.category?.trim() || null;
    if (body.unit !== undefined) data.unit = (body.unit || 'un').trim();
    if (body.description !== undefined) data.description = body.description?.trim() || null;
    if (body.imageUrl !== undefined) data.imageUrl = body.imageUrl?.trim() || null;
    if (body.active !== undefined) data.active = body.active;
    if (body.minQty !== undefined) data.minQty = typeof body.minQty === 'number' ? body.minQty : null;

    try {
      return await (this.prisma as any).supplyItem.update({ where: { id }, data });
    } catch {
      throw new NotFoundException('Item não encontrado.');
    }
  }

  async deactivateItem(id: string) {
    return (this.prisma as any).supplyItem.update({
      where: { id },
      data: { active: false },
    });
  }

  // ============================================================
  // SUPPLY REQUESTS (pedidos da filial pra matriz)
  // ============================================================

  /**
   * Filial cria um novo pedido. Body: { items: [{supplyItemId, qtyRequested}], note? }
   * StoreId vem do JWT (user.storeId), não aceita do body.
   */
  async createRequest(
    userStoreId: string,
    userId: string | null,
    body: {
      items: { supplyItemId: string; qtyRequested: number }[];
      note?: string | null;
    },
  ) {
    if (!Array.isArray(body?.items) || body.items.length === 0) {
      throw new BadRequestException('Adicione pelo menos 1 item ao pedido.');
    }
    // Valida e deduplica itens (se mesmo item vier 2x, soma as quantidades)
    const map = new Map<string, number>();
    for (const it of body.items) {
      if (!it.supplyItemId) throw new BadRequestException('supplyItemId obrigatório.');
      const qty = Number(it.qtyRequested);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new BadRequestException('qtyRequested deve ser > 0.');
      }
      map.set(it.supplyItemId, (map.get(it.supplyItemId) || 0) + qty);
    }

    // Confirma que os itens existem e estão ativos
    const itemIds = Array.from(map.keys());
    const items = await (this.prisma as any).supplyItem.findMany({
      where: { id: { in: itemIds }, active: true },
    });
    if (items.length !== itemIds.length) {
      throw new BadRequestException('Um ou mais itens não existem ou estão inativos.');
    }

    const created = await (this.prisma as any).supplyRequest.create({
      data: {
        storeId: userStoreId,
        status: 'pending',
        note: body.note?.trim() || null,
        createdByUserId: userId || null,
        items: {
          create: Array.from(map.entries()).map(([supplyItemId, qty]) => ({
            supplyItemId,
            qtyRequested: qty,
          })),
        },
      },
      include: {
        items: { include: { supply: true } },
        store: { select: { id: true, code: true, name: true } },
      },
    });
    return created;
  }

  async listRequests(params: {
    userRole: string;
    userStoreId: string | null;
    status?: string;
    scope?: 'mine' | 'all';
    limit?: number;
  }) {
    const limit = Math.min(Math.max(params.limit || 200, 1), 500);
    const where: any = {};
    const isAdmin = params.userRole === 'admin' || params.userRole === 'operator';

    // Filial só vê os próprios pedidos. Matriz com scope=mine não faz sentido, força all.
    if (!isAdmin) {
      if (!params.userStoreId) return { items: [] };
      where.storeId = params.userStoreId;
    } else if (params.scope === 'mine' && params.userStoreId) {
      where.storeId = params.userStoreId;
    }

    if (params.status) where.status = params.status;

    const items = await (this.prisma as any).supplyRequest.findMany({
      where,
      include: {
        items: { include: { supply: true } },
        store: { select: { id: true, code: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return { items };
  }

  async getRequestById(id: string, userRole: string, userStoreId: string | null) {
    const req = await (this.prisma as any).supplyRequest.findUnique({
      where: { id },
      include: {
        items: { include: { supply: true } },
        store: { select: { id: true, code: true, name: true } },
      },
    });
    if (!req) throw new NotFoundException('Pedido não encontrado.');
    const isAdmin = userRole === 'admin' || userRole === 'operator';
    if (!isAdmin && req.storeId !== userStoreId) {
      throw new NotFoundException('Pedido não encontrado.');
    }
    return req;
  }

  /**
   * Atualiza status (só admin/operator). Valida transição.
   * Body pode trazer: trackingCode, carrier, adminNote, items (qtyApproved/qtyShipped por item).
   */
  async updateRequestStatus(
    id: string,
    toStatus: SupplyRequestStatus,
    body: {
      trackingCode?: string | null;
      carrier?: string | null;
      adminNote?: string | null;
      items?: { id: string; qtyApproved?: number | null; qtyShipped?: number | null }[];
    },
  ) {
    const current = await (this.prisma as any).supplyRequest.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Pedido não encontrado.');

    const allowed = STATUS_TRANSITIONS[current.status] || [];
    if (!allowed.includes(toStatus)) {
      throw new BadRequestException(
        `Transição inválida: ${current.status} → ${toStatus}. Permitidas: ${allowed.join(', ') || 'nenhuma'}.`,
      );
    }

    const data: any = {
      status: toStatus,
      ...(body.trackingCode !== undefined && { trackingCode: body.trackingCode?.trim() || null }),
      ...(body.carrier !== undefined && { carrier: body.carrier?.trim() || null }),
      ...(body.adminNote !== undefined && { adminNote: body.adminNote?.trim() || null }),
      ...(toStatus === 'shipped' && { shippedAt: new Date() }),
      ...(toStatus === 'delivered' && { deliveredAt: new Date() }),
    };

    // Atualiza qtyApproved/qtyShipped por item, se vier no body
    if (Array.isArray(body.items)) {
      for (const patch of body.items) {
        if (!patch.id) continue;
        const itemData: any = {};
        if (patch.qtyApproved !== undefined) itemData.qtyApproved = patch.qtyApproved;
        if (patch.qtyShipped !== undefined) itemData.qtyShipped = patch.qtyShipped;
        if (Object.keys(itemData).length === 0) continue;
        await (this.prisma as any).supplyRequestItem.update({
          where: { id: patch.id },
          data: itemData,
        });
      }
    }

    return (this.prisma as any).supplyRequest.update({
      where: { id },
      data,
      include: {
        items: { include: { supply: true } },
        store: { select: { id: true, code: true, name: true } },
      },
    });
  }

  /**
   * Filial cancela próprio pedido (só se pending).
   */
  async cancelOwnRequest(id: string, userStoreId: string) {
    const current = await (this.prisma as any).supplyRequest.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Pedido não encontrado.');
    if (current.storeId !== userStoreId) {
      throw new NotFoundException('Pedido não encontrado.');
    }
    if (current.status !== 'pending') {
      throw new BadRequestException('Só dá pra cancelar enquanto o pedido está pendente.');
    }
    return (this.prisma as any).supplyRequest.update({
      where: { id },
      data: { status: 'cancelled' },
    });
  }
}
