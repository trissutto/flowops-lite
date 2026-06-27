import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { PromoConfigService, PromoConfig } from './promo-config.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';

/**
 * Configuração das promoções do PDV.
 * /admin/promo-config — só matriz vê e altera.
 */
@Controller('admin/promo-config')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class PromoConfigController {
  constructor(private readonly svc: PromoConfigService) {}

  /** GET — config atual */
  @Get()
  async get() {
    return this.svc.getConfig();
  }

  /** POST — atualiza config (qualquer campo opcional) */
  @Post()
  async set(@Body() body: Partial<PromoConfig>) {
    return this.svc.setConfig(body);
  }
}
