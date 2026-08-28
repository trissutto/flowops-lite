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
import { WincredMirrorService } from '../wincred-mirror/wincred-mirror.service';
import { VendasProdutoService } from './vendas-produto.service';

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
    private readonly mirror: WincredMirrorService,
    private readonly vendasProduto: VendasProdutoService,
  ) {}

  private requireAdmin(req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
  }

  private parseBool(v?: string): boolean {
    return v === 'true' || v === '1';
  }

  /**
   * VENDAS POR PRODUTO (REF + COR) — o relatório de 18/08/2026.
   *
   * Vem ANTES de `overview` só por organização; o que importa é que ele NÃO
   * usa o `getTopRefsBySales` das outras telas: aquele lê só o caixa antigo e
   * não desconta a réplica do PDV. Ver o cabeçalho do `VendasProdutoService`.
   */
  @Get('vendas-produto')
  vendasProdutoListar(@Req() req: any, @Query() q: any) {
    this.requireAdmin(req);
    return this.vendasProduto.listar({
      de: q.de || undefined,
      ate: q.ate || undefined,
      loja: q.loja || undefined,
      marca: q.marca || undefined,
      busca: q.busca || undefined,
      refs: q.refs ? String(q.refs).split(',').map((r: string) => r.trim()).filter(Boolean) : undefined,
      ordenar: q.ordenar || undefined,
      page: q.page ? Number(q.page) : 1,
      perPage: q.perPage ? Number(q.perPage) : 50,
    });
  }

  /**
   * A GRADE de uma peça — vendidas e estoque, tamanho a tamanho.
   *
   * Vem ANTES de `vendas-produto/marcas` na ordem? Não importa: as duas são
   * rotas fixas, sem `:param` que possa capturar a outra.
   */
  @Get('vendas-produto/grade')
  vendasProdutoGrade(@Req() req: any, @Query() q: any) {
    this.requireAdmin(req);
    return this.vendasProduto.grade(q.ref || '', q.cor || '', {
      de: q.de || undefined,
      ate: q.ate || undefined,
      loja: q.loja || undefined,
    });
  }

  /** As marcas que existem no cadastro — alimenta o seletor da tela. */
  @Get('vendas-produto/marcas')
  vendasProdutoMarcas(@Req() req: any) {
    this.requireAdmin(req);
    return this.vendasProduto.marcas();
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

  /**
   * GET /intelligence/stock-by-year?plusSize=
   * Matriz LOJA × ANO de cadastro (DATAALT): peças em estoque por ano, todas as
   * lojas. Alimenta o relatório PDF sintético "estoque por ano".
   */
  @Get('stock-by-year')
  stockByYear(@Req() req: any, @Query('plusSize') plusSize?: string) {
    this.requireAdmin(req);
    return this.svc.getStockByYearMatrix({ plusSize: this.parseBool(plusSize) });
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
   *   minTotal: int (default 2 — análise só faz sentido com 2+ peças por SKU)
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
    @Query('source') source?: string, // 'mirror' = Postgres, default = Giga
  ) {
    this.requireAdmin(req);
    const filters = {
      grupoCodigo: grupo ? Number(grupo) : null,
      subgrupoCodigo: subgrupo ? Number(subgrupo) : null,
      search: search || null,
      tamanhos: tamanhos ? tamanhos.split(',').map((s) => s.trim()).filter(Boolean) : null,
      lojas: lojas ? lojas.split(',').map((s) => s.trim()).filter(Boolean) : null,
      mode: (mode === 'all' ? 'all' : 'imbalanced') as 'all' | 'imbalanced',
      minTotal: minTotal ? Number(minTotal) : 2,
      limit: limit ? Number(limit) : 1500,
    };
    // BRANCH (29/08 — Giga MORTO): o padrão virou o ESPELHO. O default antigo
    // ("sem param = Giga, a menos de USE_LOCAL_CATALOG=1") deixou a tela vazia
    // na noite de 28/08: o front nunca manda ?source, a env nunca foi setada, e
    // o ramo Giga devolve vazio SEM erro com o pool trancado na nascente.
    // ?source=giga continua existindo só como museu/diagnóstico.
    if (source !== 'giga') {
      return this.mirror.getStockDistribution(filters);
    }
    return this.erp.getStockDistribution(filters);
  }

  /**
   * GET /intelligence/stock-distribution-by-ref
   * Sprint 1 — Visão RAIZ: 1 linha por REF+COR (não quebra por tamanho).
   * Inclui DATAALT, grupo/subgrupo nomes, fragmentação, lojas com estoque.
   *
   * Query params:
   *   grupo, subgrupo, search, tamanhos, mode, minTotal, limit (igual stock-distribution)
   *   diasMax: int — só REFs cadastradas/alteradas nos últimos X dias
   *   diasMin: int — só REFs com mais de X dias sem alteração (peças "velhas")
   */
  @Get('stock-distribution-by-ref')
  async stockDistributionByRef(
    @Req() req: any,
    @Query('grupo') grupo?: string,
    @Query('subgrupo') subgrupo?: string,
    @Query('search') search?: string,
    @Query('tamanhos') tamanhos?: string,
    @Query('mode') mode?: string,
    @Query('minTotal') minTotal?: string,
    @Query('limit') limit?: string,
    @Query('diasMax') diasMax?: string,
    @Query('diasMin') diasMin?: string,
  ) {
    this.requireAdmin(req);
    // ESPELHO (29/08): a versão Giga devolvia vazio sem erro com o pool morto.
    return this.mirror.getStockDistributionByRef({
      grupoCodigo: grupo ? Number(grupo) : null,
      subgrupoCodigo: subgrupo ? Number(subgrupo) : null,
      search: search || null,
      tamanhos: tamanhos ? tamanhos.split(',').map((s) => s.trim()).filter(Boolean) : null,
      mode: mode === 'all' ? 'all' : 'imbalanced',
      minTotal: minTotal ? Number(minTotal) : 2,
      limit: limit ? Number(limit) : 3000,
      diasMaximos: diasMax ? Number(diasMax) : null,
      diasMinimos: diasMin ? Number(diasMin) : null,
    });
  }

  /**
   * GET /intelligence/ref-sales?ref=X&dias=180
   * Sprint 4 — vendas históricas por REF agrupadas por loja.
   * Default 180 dias. Usado pra escolher loja consolidadora (top vendedora
   * tem peso extra no ranking de destino).
   */
  @Get('ref-sales')
  async refSales(
    @Req() req: any,
    @Query('ref') ref: string,
    @Query('dias') dias?: string,
  ) {
    this.requireAdmin(req);
    if (!ref?.trim()) return { vendas: [], totalQty: 0, totalValor: 0, dias: 0 };
    return this.erp.getSalesByRef(ref.trim(), dias ? Number(dias) : 180);
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
