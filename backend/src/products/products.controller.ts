import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ProductsService } from './products.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(
    @Query('page') page?: string,
    @Query('per_page') perPage?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('stock_status') stockStatus?: 'instock' | 'outofstock' | 'onbackorder',
  ) {
    return this.products.list({
      page: page ? parseInt(page, 10) : undefined,
      perPage: perPage ? parseInt(perPage, 10) : undefined,
      search,
      status,
      stockStatus,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // IMPORTANTE: rotas específicas (sync-all-*) ANTES de /:id
  // pra evitar que o Nest interprete 'sync-all-stock-from-erp' como ID.
  // ═══════════════════════════════════════════════════════════════

  /**
   * Estado atual do sync em massa (polling do frontend).
   */
  @Get('sync-all-stock-from-erp/status')
  bulkSyncStatus() {
    return this.products.getBulkSyncState();
  }

  /**
   * Dispara sync em massa (fire-and-forget).
   * Retorna 202 Accepted com o estado inicial.
   */
  @Post('sync-all-stock-from-erp')
  @HttpCode(202)
  startBulkSync() {
    return this.products.startBulkSync();
  }

  /**
   * Dispara a geração do backup de forma assíncrona.
   * Retorna imediatamente com o estado inicial. Frontend faz polling em /status.
   */
  @Post('stock-backup/start')
  @HttpCode(202)
  startBackup() {
    return this.products.startBackupAsync();
  }

  /**
   * Estado do backup em andamento (polling 1s do frontend).
   */
  @Get('stock-backup/status')
  backupStatus() {
    return this.products.getBackupState();
  }

  /**
   * Download do arquivo XLSX já gerado (salvo em backend/backups/).
   */
  @Get('stock-backup/download/:filename')
  downloadBackup(@Param('filename') filename: string, @Res() res: Response) {
    const buffer = this.products.readBackupFile(filename);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buffer);
  }

  // ═══════════════════════════════════════════════════════════════
  // AUDITORIA DE SKU — scan read-only das variações puladas
  // ═══════════════════════════════════════════════════════════════

  @Get('sku-audit/status')
  skuAuditStatus() {
    return this.products.getSkuAuditState();
  }

  @Post('sku-audit/start')
  @HttpCode(202)
  startSkuAudit() {
    return this.products.startSkuAudit();
  }

  @Get('sku-audit/result')
  skuAuditResult() {
    return this.products.getSkuAuditResult();
  }

  /**
   * DIAGNÓSTICO (temporário): lista colunas da tabela `produtos` do Gigasistemas.
   * Serve pra identificar qual coluna guarda o EAN13. Depois que sabemos o nome
   * da coluna, esse endpoint pode ser removido.
   */
  @Get('erp-schema/produtos')
  erpSchemaProdutos() {
    return this.products.describeErpProductsTable();
  }

  /**
   * DIAGNÓSTICO: busca produtos no ERP por termo (LIKE em CODIGO/REF/DESCRICAOCOMPLETA).
   * Temporário, pra investigação do padrão de SKU.
   */
  @Get('erp-search')
  erpSearch(@Query('q') q: string) {
    return this.products.searchErpProductsLike(q);
  }

  /**
   * DIAGNÓSTICO: testa a consulta de estoque total por SKUs diretamente.
   * Query param: skus=a,b,c
   */
  @Get('erp-stock-test')
  erpStockTest(@Query('skus') skus: string) {
    const list = (skus || '').split(',').map((s) => s.trim()).filter(Boolean);
    return this.products.testErpStock(list);
  }

  // ═══════════════════════════════════════════════════════════════
  // AUTO-RASCUNHO POR ESTOQUE BAIXO
  // ═══════════════════════════════════════════════════════════════

  /**
   * Preview: lista produtos publicados com stock_quantity < threshold
   * (sem tocar em nada). Default threshold=5.
   */
  @Get('draft-low-stock/preview')
  draftLowStockPreview(@Query('threshold') threshold?: string) {
    const t = threshold ? parseInt(threshold, 10) : 5;
    return this.products.draftLowStockScan(t, false);
  }

  /**
   * Aplica: marca todos os produtos publicados com stock < threshold como rascunho.
   * Default threshold=5. Retorna relatório com todos os itens afetados.
   */
  @Post('draft-low-stock/apply')
  @HttpCode(200)
  draftLowStockApply(@Query('threshold') threshold?: string) {
    const t = threshold ? parseInt(threshold, 10) : 5;
    return this.products.draftLowStockScan(t, true);
  }

  // ═══════════════════════════════════════════════════════════════
  // CORREÇÃO DE SKU COM SUFIXO -N
  // ═══════════════════════════════════════════════════════════════

  /**
   * Preview: lista variações com sufixo -N e classifica como corrigível,
   * conflito ou base-nao-existe-erp. Consome a auditoria em memória.
   */
  @Get('sku-fix/preview')
  skuFixPreview() {
    return this.products.previewSkuDashFix();
  }

  /**
   * Aplica a correção. Body:
   *   { "items": [{ productId, variationId, oldSku, newSku }, ...] }
   */
  @Post('sku-fix/apply')
  @HttpCode(200)
  skuFixApply(
    @Body()
    body: {
      items: Array<{
        productId: number;
        variationId: number;
        oldSku: string;
        newSku: string;
      }>;
    },
  ) {
    return this.products.applySkuDashFix(body?.items ?? []);
  }

  @Get('sku-audit/export.xlsx')
  async exportSkuAudit(@Res() res: Response) {
    const { filename, buffer } = await this.products.exportSkuAuditXlsx();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buffer);
  }

  /**
   * Restaura o estoque a partir de um arquivo XLSX de backup.
   * Frontend envia o conteúdo do arquivo como base64 no body JSON:
   *   { "fileBase64": "..." }
   */
  @Post('restore-stock')
  @HttpCode(200)
  async restoreStock(@Body() body: { fileBase64?: string }) {
    if (!body?.fileBase64) {
      return { error: 'fileBase64 obrigatório.' };
    }
    const buffer = Buffer.from(body.fileBase64, 'base64');
    if (!buffer.length) {
      return { error: 'Arquivo vazio.' };
    }
    return this.products.restoreStockFromBackup(buffer);
  }

  /**
   * Busca rápida de produto pra tela /minha-loja/consultar (filial).
   *
   * Campo único — detecta sozinho se é EAN (só dígitos 8-14) ou texto
   * (ref/código/descrição). Retorna agrupado por REF com:
   *  - estoque na MINHA loja (resolvida via JWT.storeId)
   *  - outras lojas que têm a ref (com WhatsApp pra pedir transferência)
   *
   * CRÍTICO: endpoint precisa vir ANTES de @Get(':id'), senão 'store-search'
   * é interpretado como ID (integer) e cai no parsing.
   */
  @Get('store-search')
  storeSearch(
    @Req() req: any,
    @Query('q') q?: string,
    @Query('mode') mode?: string,
  ) {
    const user = req.user as { userId: string; role: string; storeId: string | null };
    if (user?.role !== 'store' || !user?.storeId) {
      throw new BadRequestException('Endpoint exclusivo de usuários de loja.');
    }
    if (!q || q.trim().length < 2) {
      throw new BadRequestException('Informe o parâmetro q com no mínimo 2 caracteres.');
    }
    const normalizedMode: 'ref' | 'desc' | 'sku' =
      mode === 'desc' || mode === 'sku' ? mode : 'ref';
    return this.products.storeProductSearch(q, user.storeId, normalizedMode);
  }

  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.products.getById(id);
  }

  /**
   * Sobrescreve o estoque das variações de UM produto no WooCommerce
   * com os valores do ERP e atualiza o produto pai com a soma.
   *
   * ATENÇÃO: IRREVERSÍVEL. Frontend deve confirmar duas vezes antes de chamar.
   */
  @Post(':id/sync-stock-from-erp')
  @HttpCode(200)
  syncStockFromErp(@Param('id', ParseIntPipe) id: number) {
    return this.products.syncStockFromErp(id);
  }
}
