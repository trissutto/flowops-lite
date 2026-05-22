import {
  BadRequestException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// @TODO_VALIDATE_VS_LOJA — caminhos de service podem ter mudado
import { PrismaService } from '../prisma/prisma.service';
import { LiveBroadcasterService } from './live-broadcaster.service';
import { MetaService } from './meta.service';
import { ReserveDto } from './dto/reserve.dto';

/**
 * ReservationService — coração do LIVE OS.
 *
 * Regras de negócio:
 *  - Reserva tem TTL configurável (default 15 min)
 *  - Decrementa estoque virtual em live_products.sizes (não toca no ERP ainda)
 *  - Se cliente já tem reserva ativa do mesmo produto+tamanho, não duplica
 *  - Mantém live_cart aberto agregando reservas da cliente naquela live
 *  - Quando expira: libera estoque virtual de volta + emite evento WS
 *
 * IMPORTANTE: estoque virtual ≠ estoque real do ERP. O ERP só é tocado no
 * momento do checkout final (via WoocommerceService). Isso evita lock no
 * ERP durante a live e permite "soltar" produto se o cliente desistir.
 */
@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly broadcaster: LiveBroadcasterService,
    private readonly meta: MetaService,
  ) {}

  private get defaultTtlMinutes(): number {
    return Number(this.config.get('LIVE_RESERVATION_TTL_MIN') ?? 15);
  }

  /**
   * Tentativa silenciosa de reserva a partir de comentário detectado como "buy".
   * Falhas não jogam exception — só logam (não queremos quebrar fluxo Meta webhook).
   */
  async tryCreateFromComment(opts: {
    liveId: string;
    liveProductId: string;
    customerId: string;
    commentId: string;
    size: string | null;
  }) {
    try {
      if (!opts.size) {
        // Sem tamanho — não dá pra reservar ainda. Marca comment como
        // "pending size" pro operador ver / IA perguntar.
        this.logger.log(
          `Comment ${opts.commentId} buy intent sem tamanho — aguardando`,
        );
        return null;
      }
      return await this.create({
        liveId: opts.liveId,
        liveProductId: opts.liveProductId,
        customerId: opts.customerId,
        commentId: opts.commentId,
        size: opts.size,
        source: 'comment',
      });
    } catch (err: any) {
      this.logger.warn(`tryCreateFromComment falhou: ${err.message}`);
      return null;
    }
  }

  /**
   * Cria reserva (transacional). Faz:
   *  1. Lock no live_product
   *  2. Decrementa stock virtual no JSONB
   *  3. Insere reservation
   *  4. Upsert live_cart + soma total
   *  5. Emite eventos WS
   */
  async create(input: {
    liveId: string;
    liveProductId: string;
    customerId: string;
    commentId?: string;
    size: string;
    qty?: number;
    source?: string;
  }) {
    const ttl = this.defaultTtlMinutes;
    const expiresAt = new Date(Date.now() + ttl * 60_000);
    const qty = input.qty ?? 1;

    // Idempotência: já tem reserva ativa do mesmo produto+tamanho dessa cliente?
    const existing = await this.prisma.reservation.findFirst({
      where: {
        liveId: input.liveId,
        liveProductId: input.liveProductId,
        customerId: input.customerId,
        size: input.size,
        status: 'reserved',
      },
    });
    if (existing) {
      this.logger.log(
        `Reserva já existe (${existing.id}) — extendendo TTL`,
      );
      return this.prisma.reservation.update({
        where: { id: existing.id },
        data: { expiresAt },
      });
    }

    // Transação: decrementa estoque virtual + cria reserva + atualiza cart
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Carregar produto com lock (FOR UPDATE)
      const product = await tx.$queryRaw<any[]>`
        SELECT id, sizes, price_cents, promo_price_cents
        FROM live_products
        WHERE id = ${input.liveProductId}::uuid
        FOR UPDATE
      `;
      if (!product.length) {
        throw new NotFoundException('Produto não encontrado');
      }

      const sizes: Array<{ size: string; stock: number }> =
        product[0].sizes ?? [];
      const sizeEntry = sizes.find((s) => String(s.size) === input.size);
      if (!sizeEntry || sizeEntry.stock < qty) {
        throw new BadRequestException(
          `Sem estoque para tamanho ${input.size}`,
        );
      }

      const newSizes = sizes.map((s) =>
        String(s.size) === input.size
          ? { ...s, stock: s.stock - qty }
          : s,
      );

      // 2. Atualizar estoque virtual
      await tx.liveProduct.update({
        where: { id: input.liveProductId },
        data: {
          sizes: newSizes,
          reservationsCnt: { increment: 1 },
        },
      });

      // 3. Criar reserva
      const priceCents =
        product[0].promo_price_cents ?? product[0].price_cents;
      const reservation = await tx.reservation.create({
        data: {
          liveId: input.liveId,
          liveProductId: input.liveProductId,
          customerId: input.customerId,
          commentId: input.commentId,
          size: input.size,
          qty,
          priceCents,
          expiresAt,
          source: input.source ?? 'comment',
        },
      });

      // 4. Upsert do cart
      await tx.liveCart.upsert({
        where: {
          liveId_customerId: {
            liveId: input.liveId,
            customerId: input.customerId,
          },
        },
        update: {
          totalCents: { increment: priceCents * qty },
        },
        create: {
          liveId: input.liveId,
          customerId: input.customerId,
          totalCents: priceCents * qty,
        },
      });

      return { reservation, newSizes };
    });

    // 5. Eventos WS (fora da transação)
    this.broadcaster.emitReservationCreated(
      input.liveId,
      result.reservation,
    );
    this.broadcaster.emitStockUpdate(input.liveId, {
      liveProductId: input.liveProductId,
      sizes: result.newSizes,
    });

    this.logger.log(
      `Reserva ${result.reservation.id} criada — cliente=${input.customerId} tam=${input.size}`,
    );

    return result.reservation;
  }

  async createManual(liveId: string, dto: ReserveDto) {
    return this.create({
      liveId,
      liveProductId: dto.liveProductId,
      customerId: dto.customerId,
      size: dto.size,
      qty: dto.qty ?? 1,
      source: 'manual',
    });
  }

  async list(liveId: string, status?: string) {
    return this.prisma.reservation.findMany({
      where: {
        liveId,
        ...(status ? { status } : {}),
      },
      include: {
        customer: { select: { id: true, igUsername: true, name: true, vipTier: true } },
        liveProduct: { select: { id: true, refCode: true, displayName: true } },
      },
      orderBy: { reservedAt: 'desc' },
      take: 500,
    });
  }

  async confirm(id: string) {
    return this.prisma.reservation.update({
      where: { id },
      data: { status: 'confirmed', confirmedAt: new Date() },
    });
  }

  async cancel(id: string, reason: 'manual' | 'expired') {
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.reservation.findUnique({ where: { id } });
      if (!res) throw new NotFoundException();
      if (res.status !== 'reserved') {
        // Já está em estado terminal — idempotente
        return res;
      }

      // Libera estoque virtual
      const product = await tx.liveProduct.findUnique({
        where: { id: res.liveProductId },
      });
      if (product) {
        const sizes: Array<{ size: string; stock: number }> =
          (product.sizes as any) ?? [];
        const newSizes = sizes.map((s) =>
          String(s.size) === res.size
            ? { ...s, stock: s.stock + res.qty }
            : s,
        );
        await tx.liveProduct.update({
          where: { id: product.id },
          data: { sizes: newSizes },
        });
        this.broadcaster.emitStockUpdate(res.liveId, {
          liveProductId: product.id,
          sizes: newSizes,
        });
      }

      // Decrementa cart
      await tx.liveCart.updateMany({
        where: {
          liveId: res.liveId,
          customerId: res.customerId,
        },
        data: {
          totalCents: { decrement: res.priceCents * res.qty },
        },
      });

      const updated = await tx.reservation.update({
        where: { id },
        data: {
          status: reason === 'expired' ? 'expired' : 'cancelled',
          cancelledAt: new Date(),
        },
      });

      return updated;
    });
  }
}
