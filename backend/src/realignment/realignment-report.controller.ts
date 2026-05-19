import { Controller, Get, Header, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RealignmentReportService } from './realignment-report.service';

/**
 * /api/transferencias/report — Relatório executivo de transferências entre lojas.
 *
 * Endpoints:
 *  GET /                  → relatório completo (cards, tabela, matriz, evolução)
 *  GET /shipment/:id      → detalhe de uma transferência (itens + timeline)
 *
 * Query params:
 *  ?period=7d|30d|90d|ytd|12m  (default: 90d)
 */
@UseGuards(JwtAuthGuard)
@Controller('transferencias')
export class RealignmentReportController {
  constructor(private readonly report: RealignmentReportService) {}

  @Get('report')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  async getReport(@Query('period') period: string = '90d') {
    return this.report.getReport(period);
  }

  @Get('shipment/:id')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  async getShipment(@Param('id') id: string) {
    return this.report.getShipmentDetail(id);
  }
}
