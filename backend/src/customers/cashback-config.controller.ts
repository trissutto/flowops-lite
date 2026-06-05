import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CashbackConfigService, CashbackConfig } from './cashback-config.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';

/**
 * Configuração do programa de cashback.
 * /admin/cashback-config — só matriz vê e altera.
 */
@Controller('admin/cashback-config')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class CashbackConfigController {
  constructor(private readonly svc: CashbackConfigService) {}

  /** GET — config atual */
  @Get()
  async get() {
    return this.svc.getConfig();
  }

  /** POST — atualiza config (qualquer campo opcional) */
  @Post()
  async set(@Body() body: Partial<CashbackConfig>) {
    return this.svc.setConfig(body);
  }
}
