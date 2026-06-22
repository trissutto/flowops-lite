import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LivePdvService } from './live-pdv.service';

/**
 * Cron de expiração de reservas da Live PDV.
 * Roda a cada minuto: libera reservas (status 'reserved') cujo TTL venceu,
 * devolvendo o estoque pra novas vendas da live.
 */
@Injectable()
export class LivePdvExpiryCron {
  private readonly logger = new Logger(LivePdvExpiryCron.name);

  constructor(private readonly svc: LivePdvService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handle() {
    try {
      await this.svc.expireReservations();
    } catch (e) {
      this.logger.warn(`expireReservations falhou: ${(e as Error).message}`);
    }
  }
}
