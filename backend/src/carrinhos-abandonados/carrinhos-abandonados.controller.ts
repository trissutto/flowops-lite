import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CarrinhosAbandonadosService } from './carrinhos-abandonados.service';

@Controller('carrinhos-abandonados')
@UseGuards(JwtAuthGuard)
export class CarrinhosAbandonadosController {
  constructor(private readonly svc: CarrinhosAbandonadosService) {}

  @Get('list')
  async list(@Query('dias') dias?: string, @Query('status') status?: string) {
    const d = Math.min(90, Math.max(1, Number(dias) || 7));
    const s = status === 'completed' || status === 'all' ? status : 'abandoned';
    return this.svc.list({ dias: d, status: s as any });
  }

  @Get('resumo')
  async resumo(@Query('dias') dias?: string) {
    const d = Math.min(90, Math.max(1, Number(dias) || 7));
    return this.svc.resumo({ dias: d });
  }

  @Get('diag')
  async diag() {
    return this.svc.diag();
  }
}
