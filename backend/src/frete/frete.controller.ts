import { Body, Controller, Get, Header, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { FreteReportService } from './frete-report.service';

/** Gestão › Frete — relatório cobrado × pago dos envios (cliente + entre lojas). */
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
@Controller('frete')
export class FreteController {
  constructor(private readonly svc: FreteReportService) {}

  private range(from?: string, to?: string) {
    const now = new Date();
    const defFrom = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const defTo = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    const f = from ? new Date(from) : defFrom;
    const t = to ? new Date(to) : defTo;
    return { from: isNaN(+f) ? defFrom : f, to: isNaN(+t) ? defTo : t };
  }

  @Get('report')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  report(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('tipo') tipo?: 'all' | 'cliente' | 'loja',
    @Query('storeCode') storeCode?: string,
  ) {
    const r = this.range(from, to);
    return this.svc.report(r.from, r.to, { tipo: tipo || 'all', storeCode });
  }

  /** Recota (preço de HOJE) os envios do intervalo que ainda não têm custo gravado. */
  @Post('recotar')
  recotar(@Body() body: { from?: string; to?: string; limit?: number }) {
    const r = this.range(body?.from, body?.to);
    return this.svc.recotarPendentes(r.from, r.to, Number(body?.limit) || 25);
  }

  /** Custo PAGO digitado da fatura (null limpa). */
  @Patch(':kind/:id/pago')
  setPago(@Param('kind') kind: 'pick' | 'remessa', @Param('id') id: string, @Body() body: { valorReais: number | null }) {
    return this.svc.setPagoManual(kind === 'remessa' ? 'remessa' : 'pick', id, body?.valorReais == null ? null : Number(body.valorReais));
  }
}
