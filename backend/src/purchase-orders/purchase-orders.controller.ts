import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PurchaseOrdersService } from './purchase-orders.service';
import { ErpService } from '../erp/erp.service';

/**
 * /purchase-orders — pedidos de compra
 * Roles: admin, supervisor, operator (qualquer pessoa do retaguarda)
 */
@UseGuards(JwtAuthGuard)
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(
    private readonly svc: PurchaseOrdersService,
    private readonly erp: ErpService,
  ) {}

  private requireWrite(req: any) {
    const allowed = ['admin', 'supervisor', 'operator'];
    if (!allowed.includes(req?.user?.role)) {
      throw new ForbiddenException('Sem permissão');
    }
  }
  private userId(req: any) {
    return req?.user?.id || req?.user?.sub || null;
  }

  // ── Lookups auxiliares ──
  @Get('lookups/fornecedores')
  async fornecedores(@Query('limit') limit?: string) {
    return this.erp.listarFornecedores(limit ? Number(limit) : 5000);
  }

  @Get('lookups/grupos')
  async grupos() {
    return this.erp.listarGrupos();
  }

  // Diagnostico — chame /api/purchase-orders/lookups/diagnose pra ver
  // exatamente o que o Wincred esta retornando nos lookups.
  @Get('lookups/diagnose')
  async diagnose() {
    return this.svc.diagnoseLookups();
  }

  @Get('lookups/subgrupos')
  async subgrupos(@Query('grupo') grupo: string) {
    if (!grupo) return [];
    return this.erp.listarSubgrupos(Number(grupo));
  }

  // ── Categorias (mapeamento descrição → grupo) ──
  @Get('categorias')
  async listCategorias() {
    return this.svc.listarCategorias();
  }

  @Post('categorias')
  async upsertCategoria(@Req() req: any, @Body() body: any) {
    this.requireWrite(req);
    return this.svc.upsertCategoria({ ...body, userId: this.userId(req) });
  }

  @Delete('categorias/:descricaoBase')
  async deleteCategoria(@Req() req: any, @Param('descricaoBase') descricaoBase: string) {
    this.requireWrite(req);
    return this.svc.deleteCategoria(decodeURIComponent(descricaoBase));
  }

  // ── CRUD pedidos ──
  @Get()
  async list(
    @Query('status') status?: string,
    @Query('fornecedor') fornecedor?: string,
    @Query('search') search?: string,
  ) {
    return this.svc.list({ status, fornecedor, search });
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.svc.getById(id);
  }

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    this.requireWrite(req);
    return this.svc.create(body, this.userId(req));
  }

  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireWrite(req);
    return this.svc.update(id, body);
  }

  @Delete(':id')
  async delete(@Req() req: any, @Param('id') id: string, @Query('force') force?: string) {
    this.requireWrite(req);
    return this.svc.delete(id, force === 'true' || force === '1');
  }

  // ── Items ──
  @Post(':id/items')
  async addItem(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireWrite(req);
    return this.svc.addItem(id, body);
  }

  @Patch('items/:itemId')
  async updateItem(@Req() req: any, @Param('itemId') itemId: string, @Body() body: any) {
    this.requireWrite(req);
    return this.svc.updateItem(itemId, body);
  }

  @Delete('items/:itemId')
  async deleteItem(@Req() req: any, @Param('itemId') itemId: string) {
    this.requireWrite(req);
    return this.svc.deleteItem(itemId);
  }

  // ── Recebimento + Auto-cadastro ──
  @Post(':id/receive')
  async receive(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireWrite(req);
    return this.svc.receive(
      id,
      { itemsRecebidos: body?.itemsRecebidos || [] },
      this.userId(req),
    );
  }

  // ── Etiquetas ──
  @Get(':id/labels')
  async labels(@Param('id') id: string) {
    return this.svc.listLabels(id);
  }

  /**
   * Etiquetas avulsas — busca produtos no Wincred por EAN, REF ou SKU.
   * POST body: { codigos: string[] }
   */
  @Post('etiquetas-avulsas')
  async etiquetasAvulsas(@Body() body: { codigos: string[] }) {
    return this.svc.buscarEtiquetasAvulsas(body?.codigos || []);
  }

  // ── Reposicao de produtos (estoque + etiquetas) ──
  /**
   * Busca produtos no Wincred por REF ou DESCRICAO (LIKE).
   * GET /purchase-orders/reposicao/buscar?q=BLUSA
   */
  @Get('reposicao/buscar')
  async reposicaoBuscar(@Query('q') q: string) {
    return this.svc.reposicaoBuscar(q || '');
  }

  /**
   * Diagnostico: mostra estrutura da tabela produtos + amostras de busca.
   * GET /purchase-orders/reposicao/diagnose?q=VLM
   */
  @Get('reposicao/diagnose')
  async reposicaoDiagnose(@Query('q') q: string) {
    return this.svc.reposicaoDiagnose(q || '');
  }

  /**
   * Confirma reposicao: adiciona estoque no Wincred + retorna labels pra impressao.
   * POST body: { items: [{ codigo, qty, lojaCode? }] }
   */
  @Post('reposicao/confirmar')
  async reposicaoConfirmar(
    @Req() req: any,
    @Body() body: { items: Array<{ codigo: string; qty: number; lojaCode?: string }> },
  ) {
    this.requireWrite(req);
    return this.svc.reposicaoConfirmar(body?.items || []);
  }
}
