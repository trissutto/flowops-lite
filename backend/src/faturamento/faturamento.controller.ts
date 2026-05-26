import { Controller, ForbiddenException, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { FaturamentoService } from './faturamento.service';

/**
 * /faturamento — admin only. Tela de gráfico de faturamento por loja.
 */
@UseGuards(JwtAuthGuard)
@Controller('faturamento')
export class FaturamentoController {
  constructor(private readonly svc: FaturamentoService) {}

  private requireAdmin(req: any) {
    if (req?.user?.role !== 'admin' && req?.user?.role !== 'operator') {
      throw new ForbiddenException('Apenas admin/operator');
    }
  }

  /**
   * GET /faturamento/resumo?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=day|week|month
   *
   * Default: this month até hoje, day.
   */
  @Get('resumo')
  async resumo(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('granularity') granularity?: string,
  ) {
    this.requireAdmin(req);
    const today = new Date();
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const f = from || fmt(firstOfMonth);
    const t = to || fmt(today);
    const g = (granularity === 'week' || granularity === 'month') ? granularity : 'day';
    return this.svc.getResumo(f, t, g);
  }
}
