import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { SellersService } from './sellers.service';

/**
 * Rotas de vendedoras.
 *
 *   GET  /sellers?includeInactive=0|1        → lista (default só ativas)
 *   POST /sellers                            → { name, whatsapp? } cria
 *   PATCH /sellers/:id                       → { name?, whatsapp?, active? } edita
 *   PATCH /sellers/assign/:wcOrderId         → { sellerId: string | null } atribui
 *   GET  /sellers/report?from=ISO&to=ISO     → relatório do período
 */
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@Controller('sellers')
export class SellersController {
  constructor(private readonly svc: SellersService) {}

  @Get()
  list(@Query('includeInactive') includeInactive?: string) {
    return this.svc.list(includeInactive === '1' || includeInactive === 'true');
  }

  @Post()
  @AdminOnly()
  create(@Body() body: { name: string; whatsapp?: string }) {
    return this.svc.create(body);
  }

  /**
   * Importa funcionarias do PdvActiveSeller (whitelist do PDV das lojas)
   * pra Seller. Idempotente. Resultado: cria como cargo=VENDEDORA;
   * admin ajusta cargo + loja responsavel depois pra Lideres/Gerentes.
   */
  @Post('import-from-pdv-active')
  @AdminOnly()
  importFromPdvActive() {
    return this.svc.importFromPdvActive();
  }

  @Patch(':id')
  @AdminOnly()
  update(
    @Param('id') id: string,
    @Body() body: { name?: string; whatsapp?: string | null; active?: boolean; cargo?: string; responsibleStoreId?: string | null },
  ) {
    return this.svc.update(id, body);
  }

  @Patch('assign/:wcOrderId')
  assign(
    @Param('wcOrderId') wcOrderId: string,
    @Body() body: { sellerId: string | null },
    @Req() req: any,
  ) {
    const by = req?.user?.email || req?.user?.id || 'unknown';
    return this.svc.assignToOrder(Number(wcOrderId), body?.sellerId ?? null, by);
  }

  @Get('report')
  report(@Query('from') from?: string, @Query('to') to?: string) {
    // Default: mês corrente
    const now = new Date();
    const defFrom = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const defTo = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const f = from ? new Date(from) : defFrom;
    const t = to ? new Date(to) : defTo;

    return this.svc.report(f, t);
  }
}
