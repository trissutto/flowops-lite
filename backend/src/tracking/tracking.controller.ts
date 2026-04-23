import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { TrackingService } from './tracking.service';

/**
 * GET /tracking/:code?carrier=correios
 *
 * Puxa status em tempo real do código de rastreio. Autenticado (JWT) pra não
 * vazar token de provedor em tráfego público.
 *
 * Uso:
 *   - /pedidos/wc/[id] mostra timeline quando order.trackingCode existe
 *   - /minha-loja lista último status por linha (opcional, sob demanda)
 */
@UseGuards(JwtAuthGuard)
@Controller('tracking')
export class TrackingController {
  constructor(private readonly svc: TrackingService) {}

  @Get(':code')
  async get(@Param('code') code: string, @Query('carrier') carrier?: string) {
    return this.svc.fetchTracking(code, carrier);
  }
}
