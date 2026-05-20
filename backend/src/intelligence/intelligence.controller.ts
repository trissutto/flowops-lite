import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { IntelligenceService } from './intelligence.service';
import { ErpService } from '../erp/erp.service';

/**
 * /intelligence — admin-only. Endpoints pra dashboard de inteligência de
 * estoque (/retaguarda/inteligencia-estoque).
 *
 * Todos endpoints aceitam ?from=YYYY-MM-DD&to=YYYY-MM-DD&plusSize=true.
 * Se omitido, default = últimos 30 dias.
 */
@UseGuards(JwtAuthGuard)
@Controller('intelligence')
export class IntelligenceController {
  constructor(
    private readonly svc: IntelligenceService,
    private readonly erp: ErpService,
  ) {}

  private requireAdmin(req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
  }

  private parseBool(v?: string): boolean {
    return v === 'true' || v === '1';
  }

  @Get('overview')
  overview(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('plusSize') plusSize?: string,
    @Query('year') year?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.getStoresOverview({
      from,
      to,
      plusSize: this.parseBool(plusSize),
      year: year || undefined,
    });
  }

  @Get('top-sellers')
  topSellers(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('storeCode') storeCode?: string,
    @Query('plusSize') plusSize?: string,
    @Query('orderBy') orderBy?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.getTopSellers({
      from,
      to,
      storeCode: storeCode || null,
      plusSize: this.parseBool(plusSize),
      orderBy: orderBy === 'valor' ? 'valor' : 'pecas',
      limit: limit ? Number(limit) : 10,
    });
  }

  @Get('rupturas')
  rupturas(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('storeCode') storeCode?: string,
    @Query('plusSize') plusSize?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.getRupturas({
      from,
      to,
      storeCode: storeCode || null,
      plusSize: this.parseBool(plusSize),
      limit: limit ? Number(limit) : 10,
    });
  }

  @Get('parados')
  parados(
    @Req() req: any,
    @Query('storeCode') storeCode?: string,
    @Query('days') days?: string,
    @Query('minStock') minStock?: string,
    @Query('plusSize') plusSize?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.getParados({
      storeCode: storeCode || null,
      daysSemVenda: days ? Number(days) : 30,
      minStock: minStock ? Number(minStock) : 5,
      plusSize: this.parseBool(plusSize),
      limit: limit ? Number(limit) : 10,
    });
  }

  @Get('heatmap')
  heatmap(
    @Req() req: any,
    @Query('plusSize') plusSize?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.getHeatmap({
      plusSize: this.parseBool(plusSize),
      limit: limit ? Number(limit) : 20,
    });
  }

  @Get('store/:code')
  storeDetail(
    @Req() req: any,
    @Param('code') code: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('plusSize') plusSize?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.getStoreDetail({
      storeCode: code,
      from,
      to,
      plusSize: this.parseBool(plusSize),
    });
  }

  /**
   * GET /intelligence/stock-distribution
   * Lista de variações (REF+COR+TAM) com qty por loja + indicador de
   * desequilíbrio (ALTO/MEDIO/OK). Default = PLUS SIZE only + só desequilibrados.
   *
   * Query params:
   *   grupo, subgrupo: filtro categoria (codigo do Wincred)
   *   search: REF/descrição/codigo
   *   tamanhos: CSV de tamanhos (default: 46-60 + combos)
   *   lojas: CSV de codes (default: todas exceto SITE/PF)
   *   mode: 'imbalanced' (default) | 'all'
   *   minTotal: int (default 3)
   *   limit: int (default 1500)
   */
  @Get('stock-distribution')
  async stockDistribution(
    @Req() req: any,
    @Query('grupo') grupo?: string,
    @Query('subgrupo') subgrupo?: string,
    @Query('search') search?: string,
    @Query('tamanhos') tamanhos?: string,
    @Query('lojas') lojas?: string,
    @Query('mode') mode?: string,
    @Query('minTotal') minTotal?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireAdmin(req);
    return this.erp.getStockDistribution({
      grupoCodigo: grupo ? Number(grupo) : null,
      subgrupoCodigo: subgrupo ? Number(subgrupo) : null,
      search: search || null,
      tamanhos: tamanhos ? tamanhos.split(',').map((s) => s.trim()).filter(Boolean) : null,
      lojas: lojas ? lojas.split(',').map((s) => s.trim()).filter(Boolean) : null,
      mode: mode === 'all' ? 'all' : 'imbalanced',
      minTotal: minTotal ? Number(minTotal) : 3,
      limit: limit ? Number(limit) : 1500,
    });
  }

  /**
   * GET /intelligence/grupos
   * Lista grupos do Wincred (pro filtro de categoria na tela de distribuição).
   */
  @Get('grupos')
  async listGrupos(@Req() req: any) {
    this.requireAdmin(req);
    return this.erp.listarGrupos();
  }

  /**
   * GET /intelligence/subgrupos?grupo=N
   * Lista subgrupos de um grupo (cascata no filtro).
   */
  @Get('subgrupos')
  async listSubgrupos(@Req() req: any, @Query('grupo') grupo: string) {
    this.requireAdmin(req);
    if (!grupo) return [];
    return this.erp.listarSubgrupos(Number(grupo));
  }

  /**
   * GET /intelligence/sku-diagnose/:sku
   * Diagnóstico de estoque pra debugar "tem estoque mas pedido em ruptura".
   * Retorna real (Giga), committed (pick-orders ativos) e líquido por loja.
   */
  @Get('sku-diagnose/:sku')
  skuDiagnose(@Req() req: any, @Param('sku') sku: string) {
    this.requireAdmin(req);
    return this.svc.diagnoseSkuStock(sku);
  }

  /**
   * GET /intelligence/sku-trace/:sku
   * TRACE passo-a-passo do método getStock (que o routing usa). Mostra:
   *   1. variantes do SKU (paddings)
   *   2. produtos.CODIGO encontrados
   *   3. mapeamento codigoGiga → originalSku
   *   4. expansão dos codigosGiga em variantes pra buscar em estoque
   *   5. linhas brutas retornadas pela query em estoque
   *   6. agregado final
   *   + tabela raw (sem filtros) pra comparação
   *
   * Usado pra identificar exatamente em qual passo o estoque "some" quando
   * o diagnóstico mostra peça mas routing diz ruptura.
   */
  @Get('sku-trace/:sku')
  async skuTrace(@Req() req: any, @Param('sku') sku: string) {
    this.requireAdmin(req);
    return this.svc.traceSkuStock(sku);
  }

  /**
   * GET /intelligence/sales-report?from=YYYY-MM-DD&to=YYYY-MM-DD&storeCode=01
   * Relatório completo de vendas: KPIs, by-day (gráfico), top vendedoras,
   * top marcas, top produtos. Inclui cálculo de comissão (default 2%).
   */
  @Get('sales-report')
  async salesReport(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('storeCode') storeCode?: string,
    @Query('comissaoPct') comissaoPct?: string,
    @Query('plusSize') plusSize?: string,
    @Query('compareYoY') compareYoY?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.getSalesReport({
      from,
      to,
      storeCode: storeCode || undefined,
      comissaoPct: Number(comissaoPct) || 2,
      plusSize: this.parseBool(plusSize),
      compareYoY: this.parseBool(compareYoY),
    });
  }

  /**
   * GET /intelligence/strategic-dashboard?from=&to=&plusSize=
   * Visão executiva completa pra dashboard estratégico — 1 fetch, tudo pronto.
   */
  @Get('strategic-dashboard')
  async strategicDashboard(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('plusSize') plusSize?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.getStrategicDashboard({
      from, to,
      plusSize: this.parseBool(plusSize),
    });
  }
}
