import { Controller, ForbiddenException, Get, Query, Req, UseGuards } from '@nestjs/common';
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

  // POST /admin/stock-mirror/sync saiu em 09/26, com o fullSyncFromGiga que
  // ele chamava. Era o sync full Giga→tabela `stock` de 2026-06; a tela
  // /retaguarda/estoque já tinha largado o botão, ele vivia atrás de
  // ERP_STOCK_WRITEBACK_GIGA=1 (desligada) e o MySQL do Giga está morto desde
  // 27/08. O que sobrou aqui — summary, list e movements — lê só o Postgres.

  /**
   * GET /admin/stock-mirror/movements?storeCode=X&sku=Y&skus=a,b,c
   *
   * Histórico de mudanças (auditoria). `storeCode` deixou de ser obrigatório em
   * 21/08: a ficha do produto pergunta pela PEÇA na rede toda, e um dos dois —
   * loja ou SKU — basta. `skus` aceita a lista de códigos de uma REF (cor ×
   * tamanho) numa chamada só, em vez de uma por variação.
   */
  @Get('movements')
  async movements(
    @Req() req: any,
    @Query('storeCode') storeCode?: string,
    @Query('sku') sku?: string,
    @Query('skus') skus?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireAdmin(req);
    const lista = (skus || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!storeCode && !sku && !lista.length) {
      return { error: 'Informe storeCode ou sku' };
    }
    return this.svc.historicoMovimentacoes({
      storeCode,
      sku,
      skus: lista,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
