import { Controller, Get, Query, Req, UseGuards, ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { SiteSaidasReportService, SiteSaidasFilters } from './site-saidas.service';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class SiteSaidasController {
  constructor(private readonly svc: SiteSaidasReportService) {}

  /**
   * GET /reports/site-saidas?storeCode=11&ref=BRASIL ROYAL&tamanho=54&from=2026-01-01&to=2026-12-31
   *
   * Acesso: admin/operator/supervisor (matriz).
   *
   * Filtros (todos opcionais):
   *   storeCode  — código da loja que cedeu (ex: '11' Limeira)
   *   ref        — referência do produto (busca parcial, case-insensitive)
   *   tamanho    — tamanho exato (44, 46, 48, 50, 52, 54...)
   *   cor        — cor (busca parcial)
   *   from / to  — período (YYYY-MM-DD) baseado em Order.wcDateCreated
   *   status     — CSV (default 'shipped,delivered')
   */
  @Get('site-saidas')
  async getSiteSaidas(
    @Req() req: any,
    @Query('storeCode') storeCode?: string,
    @Query('ref') ref?: string,
    @Query('tamanho') tamanho?: string,
    @Query('cor') cor?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
  ) {
    this.requireMatriz(req);

    const filters: SiteSaidasFilters = {
      storeCode: storeCode?.trim() || undefined,
      ref: ref?.trim() || undefined,
      tamanho: tamanho?.trim() || undefined,
      cor: cor?.trim() || undefined,
      from: from?.trim() || undefined,
      to: to?.trim() || undefined,
      status: status?.trim()
        ? status.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined,
    };

    return this.svc.getReport(filters);
  }

  private requireMatriz(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator' && role !== 'supervisor') {
      throw new ForbiddenException('Apenas matriz (admin/operator/supervisor)');
    }
  }
}
