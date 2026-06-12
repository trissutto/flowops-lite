import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { StockMirrorService } from './stock-mirror.service';

/**
 * /admin/stock-mirror — gestão do espelho de estoque pras 5 lojas migradas.
 * Admin only.
 */
@UseGuards(JwtAuthGuard)
@Controller('admin/stock-mirror')
export class StockMirrorController {
  constructor(private readonly svc: StockMirrorService) {}

  private requireAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator') {
      throw new ForbiddenException('Apenas admin/operator');
    }
  }

  /** GET /admin/stock-mirror/summary — totais por loja gerenciada */
  @Get('summary')
  async summary(@Req() req: any) {
    this.requireAdmin(req);
    return {
      managedStores: this.svc.getManagedStores(),
      lojas: await this.svc.summary(),
    };
  }

  /**
   * GET /admin/stock-mirror/list?storeCode=INDAIATUBA&sku=ABC&onlyAvailable=1
   * Lista produtos no estoque dessa loja.
   */
  @Get('list')
  async list(
    @Req() req: any,
    @Query('storeCode') storeCode: string,
    @Query('sku') sku?: string,
    @Query('onlyAvailable') onlyAvailable?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireAdmin(req);
    if (!storeCode) return { error: 'storeCode obrigatório' };
    return this.svc.listStock({
      storeCode,
      sku,
      onlyAvailable: onlyAvailable === '1' || onlyAvailable === 'true',
      limit: limit ? Number(limit) : undefined,
    });
  }

  /**
   * POST /admin/stock-mirror/sync
   * Body: { storeCodes?: string[] }
   * Sync full do Giga pras lojas dadas (ou todas as gerenciadas).
   */
  @Post('sync')
  async sync(@Req() req: any, @Body() body: { storeCodes?: string[] }) {
    this.requireAdmin(req);
    return this.svc.fullSyncFromGiga({ storeCodes: body?.storeCodes });
  }

  /**
   * GET /admin/stock-mirror/movements?storeCode=X&sku=Y
   * Histórico de mudanças (auditoria).
   */
  @Get('movements')
  async movements(
    @Req() req: any,
    @Query('storeCode') storeCode: string,
    @Query('sku') sku?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireAdmin(req);
    if (!storeCode) return { error: 'storeCode obrigatório' };
    return this.svc.historicoMovimentacoes({
      storeCode,
      sku,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
