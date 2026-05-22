import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service'; // @TODO_VALIDATE_VS_LOJA
import { ReservationService } from './reservation.service';
import { LiveBroadcasterService } from './live-broadcaster.service';

/**
 * Cron que varre reservas expiradas e libera estoque virtual.
 *
 * Roda a cada 30 segundos. Em escala, o índice
 * idx_reservations_pending_expiry (parcial) garante que essa varredura
 * fica em O(N expiradas) sem tocar nas outras.
 *
 * @TODO_VALIDATE_VS_LOJA: ScheduleModule.forRoot() já está importado no
 * AppModule do flowops-lite. Se mudou, verificar.
 */
@Injectable()
export class ReservationExpiryCron {
  private readonly logger = new Logger(ReservationExpiryCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservation: ReservationService,
    private readonly broadcaster: LiveBroadcasterService,
  ) {}

  @Cron('*/30 * * * * *') // a cada 30s
  async sweep() {
    const now = new Date();
    const expired = await this.prisma.reservation.findMany({
      where: {
        status: 'reserved',
        expiresAt: { lte: now },
      },
      select: { id: true, liveId: true, customerId: true },
      take: 100, // batch
    });

    if (expired.length === 0) return;

    this.logger.log(`Expirando ${expired.length} reservas`);

    for (const r of expired) {
      try {
        await this.reservation.cancel(r.id, 'expired');
        this.broadcaster.emitReservationExpired(r.liveId, r.customerId, r.id);
      } catch (err: any) {
        this.logger.warn(`Falha ao expirar reserva ${r.id}: ${err.message}`);
      }
    }
  }
}
