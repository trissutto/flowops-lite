import {
  BadRequestException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
// @TODO_VALIDATE_VS_LOJA — caminhos podem ter mudado no PC
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

import { LiveBroadcasterService } from './live-broadcaster.service';
import { AddProductDto } from './dto/add-product.dto';
import { CreateLiveDto } from './dto/create-live.dto';
import { SetCurrentProductDto } from './dto/set-current-product.dto';
import { StartLiveDto } from './dto/start-live.dto';

/**
 * LiveService — orquestra o ciclo de vida da live.
 *
 * Responsabilidades:
 *  - CRUD de lives
 *  - Adicionar produtos (busca preço/estoque atual do ERP/WC)
 *  - Trocar produto atual (única operação que dispara mais eventos)
 *  - Snapshot de estoque pra reserva justa durante a live
 *  - Fechamento: gera carts → checkout via WC
 *
 * Não fala com Meta. Não fala com IA. Só estado interno.
 */
@Injectable()
export class LiveService {
  private readonly logger = new Logger(LiveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly broadcaster: LiveBroadcasterService,
  ) {}

  async create(dto: CreateLiveDto) {
    const live = await this.prisma.live.create({
      data: {
        title: dto.title,
        hostUserId: dto.hostUserId,
        status: 'scheduled',
        aiEnabled: dto.aiEnabled ?? true,
      },
    });
    this.logger.log(`Live criada: ${live.id} — "${live.title}"`);
    return live;
  }

  async list(status?: string) {
    return this.prisma.live.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async detail(id: string) {
    const live = await this.prisma.live.findUnique({
      where: { id },
      include: {
        products: {
          orderBy: { position: 'asc' },
        },
      },
    });
    if (!live) throw new NotFoundException('Live não encontrada');
    return live;
  }

  async start(id: string, dto: StartLiveDto) {
    const live = await this.prisma.live.findUnique({ where: { id } });
    if (!live) throw new NotFoundException();
    if (live.status === 'live') {
      throw new BadRequestException('Live já está em andamento');
    }

    const updated = await this.prisma.live.update({
      where: { id },
      data: {
        status: 'live',
        startedAt: new Date(),
        igMediaId: dto.igMediaId ?? live.igMediaId,
      },
    });

    this.broadcaster.emitLiveStatus(id, 'live');
    this.logger.log(`Live iniciada: ${id}`);
    return updated;
  }

  async end(id: string) {
    const live = await this.prisma.live.findUnique({ where: { id } });
    if (!live) throw new NotFoundException();

    const updated = await this.prisma.live.update({
      where: { id },
      data: {
        status: 'ended',
        endedAt: new Date(),
      },
    });

    // Tira destaque de todos os produtos
    await this.prisma.liveProduct.updateMany({
      where: { liveId: id, isCurrent: true },
      data: { isCurrent: false, endedShownAt: new Date() },
    });

    this.broadcaster.emitLiveStatus(id, 'ended');
    this.logger.log(`Live encerrada: ${id}`);

    // O fechamento de carrinhos é feito em endpoint separado pra dar tempo
    // pra equipe revisar antes de disparar DMs.
    return updated;
  }

  async setAiEnabled(id: string, enabled: boolean) {
    return this.prisma.live.update({
      where: { id },
      data: { aiEnabled: enabled },
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // PRODUTOS
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Adiciona um produto à live. Faz snapshot do estoque do ERP no momento
   * do add — esse é o "estoque virtual da live", que vai ser decrementado
   * conforme reservas chegam.
   *
   * @TODO_VALIDATE_VS_LOJA: ErpService no PC pode ter método com nome
   * diferente pra buscar estoque agregado por SKU. Atualizar abaixo se sim.
   */
  async addProduct(liveId: string, dto: AddProductDto) {
    await this.assertLiveExists(liveId);

    // Busca estoque atual no ERP (todas as variações por tamanho).
    // erp.service.ts já tem helpers de SKU; aqui usamos o método que
    // mais se aproxima do que existe — pode precisar ajuste.
    // @TODO_VALIDATE_VS_LOJA: trocar pelo método real do erp.service
    const stockBySize = await (this.erp as any).getStockBySizeForRef
      ? await (this.erp as any).getStockBySizeForRef(dto.refCode)
      : await this.fallbackStockBySize(dto.refCode);

    const sizesPayload = (dto.sizes ?? Object.entries(stockBySize)).map(
      ([size, stock]: any) => ({
        size: String(size),
        stock: Number(stock),
      }),
    );

    const position =
      (await this.prisma.liveProduct.count({ where: { liveId } })) + 1;

    return this.prisma.liveProduct.create({
      data: {
        liveId,
        erpProductId: dto.erpProductId,
        refCode: dto.refCode,
        displayName: dto.displayName,
        priceCents: dto.priceCents,
        promoPriceCents: dto.promoPriceCents,
        wcProductId: dto.wcProductId,
        sizes: sizesPayload,
        position,
      },
    });
  }

  /**
   * Fallback quando não existe método específico no ErpService.
   * Roda query genérica via /erp-query (já existe no projeto).
   *
   * @TODO_VALIDATE_VS_LOJA: ajustar pra usar o método real
   */
  private async fallbackStockBySize(
    refCode: string,
  ): Promise<Record<string, number>> {
    this.logger.warn(
      `Fallback de estoque para refCode=${refCode}. Considere implementar erp.getStockBySizeForRef.`,
    );
    return {};
  }

  async setCurrentProduct(
    liveId: string,
    productId: string,
    _dto: SetCurrentProductDto,
  ) {
    await this.assertLiveExists(liveId);

    // Transação: limpa current anterior + define novo + atualiza shownAt
    const [product] = await this.prisma.$transaction([
      this.prisma.liveProduct.update({
        where: { id: productId },
        data: {
          isCurrent: true,
          shownAt: new Date(),
        },
      }),
      this.prisma.liveProduct.updateMany({
        where: {
          liveId,
          id: { not: productId },
          isCurrent: true,
        },
        data: {
          isCurrent: false,
          endedShownAt: new Date(),
        },
      }),
    ]);

    this.broadcaster.emitProductChange(liveId, product);
    this.logger.log(
      `Produto ao vivo: live=${liveId} ref=${product.refCode}`,
    );
    return product;
  }

  async listProducts(liveId: string) {
    return this.prisma.liveProduct.findMany({
      where: { liveId },
      orderBy: { position: 'asc' },
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // STATS / COMMENTS
  // ─────────────────────────────────────────────────────────────────────

  async realtimeStats(liveId: string) {
    await this.assertLiveExists(liveId);

    const [commentsTotal, commentsLastMin, reservations, sales] =
      await Promise.all([
        this.prisma.comment.count({ where: { liveId } }),
        this.prisma.comment.count({
          where: {
            liveId,
            createdAt: { gte: new Date(Date.now() - 60_000) },
          },
        }),
        this.prisma.reservation.count({
          where: { liveId, status: 'reserved' },
        }),
        this.prisma.reservation.findMany({
          where: { liveId, status: { in: ['paid', 'confirmed'] } },
          select: { priceCents: true, qty: true },
        }),
      ]);

    const revenueCents = sales.reduce(
      (acc, s) => acc + s.priceCents * s.qty,
      0,
    );

    return {
      commentsTotal,
      commentsPerMin: commentsLastMin,
      activeReservations: reservations,
      sales: sales.length,
      revenueCents,
    };
  }

  async listComments(
    liveId: string,
    opts: { intent?: string; limit: number },
  ) {
    return this.prisma.comment.findMany({
      where: {
        liveId,
        ...(opts.intent ? { detectedIntent: opts.intent } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts.limit, 1000),
      include: {
        customer: { select: { id: true, igUsername: true, vipTier: true } },
        liveProduct: { select: { id: true, refCode: true } },
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // FECHAMENTO
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Gera link de checkout pra cada live_cart aberto da live.
   *
   * @TODO_VALIDATE_VS_LOJA: o WoocommerceService no PC tem o método pra
   * criar pedido com múltiplos itens. Substituir o stub abaixo pela
   * chamada real.
   */
  async closeCarts(liveId: string) {
    const carts = await this.prisma.liveCart.findMany({
      where: { liveId, status: 'open' },
      include: {
        customer: { select: { id: true, name: true, igUsername: true } },
      },
    });

    this.logger.log(`Fechando ${carts.length} carrinhos da live ${liveId}`);

    const results: Array<{ cartId: string; checkoutUrl?: string; error?: string }> =
      [];

    for (const cart of carts) {
      try {
        const reservations = await this.prisma.reservation.findMany({
          where: {
            liveId,
            customerId: cart.customerId,
            status: { in: ['reserved', 'confirmed'] },
          },
          include: { liveProduct: true },
        });

        if (reservations.length === 0) continue;

        // @TODO_VALIDATE_VS_LOJA: chamar WoocommerceService.createOrder real
        const checkoutUrl = await this.stubCreateWcOrder(cart, reservations);

        await this.prisma.liveCart.update({
          where: { id: cart.id },
          data: { checkoutUrl, status: 'checked_out' },
        });

        results.push({ cartId: cart.id, checkoutUrl });
      } catch (err: any) {
        this.logger.error(
          `Erro fechando cart ${cart.id}: ${err.message}`,
        );
        results.push({ cartId: cart.id, error: err.message });
      }
    }

    return { closed: results };
  }

  private async stubCreateWcOrder(
    _cart: any,
    _reservations: any[],
  ): Promise<string> {
    // @TODO_VALIDATE_VS_LOJA: substituir pela chamada real ao WoocommerceService
    return 'https://lurds.com.br/checkout?cart=STUB';
  }

  // ─────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────

  private async assertLiveExists(id: string) {
    const exists = await this.prisma.live.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Live não encontrada');
  }
}
