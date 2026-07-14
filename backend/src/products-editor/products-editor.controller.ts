import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ProductsEditorService, EditChanges } from './products-editor.service';

/**
 * EDITOR DE PRODUTOS — só ADMIN (mexe no cadastro do Giga, fonte da verdade).
 */
@Controller('products-editor')
@UseGuards(JwtAuthGuard)
export class ProductsEditorController {
  constructor(private readonly svc: ProductsEditorService) {}

  private requireAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin') throw new ForbiddenException('Apenas admin');
  }

  /** GET /products-editor/search?q= — variações com campos separados. */
  @Get('search')
  async search(@Req() req: any, @Query('q') q?: string) {
    this.requireAdmin(req);
    return this.svc.searchProdutos(String(q || ''));
  }

  /**
   * GET /products-editor/ref-info?ref=&exclude=cod1,cod2
   * Checa colisão antes de renomear REF (destino já usada por outro produto?).
   */
  @Get('ref-info')
  async refInfo(@Req() req: any, @Query('ref') ref?: string, @Query('exclude') exclude?: string) {
    this.requireAdmin(req);
    const excludeCodigos = String(exclude || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return this.svc.refInfo(String(ref || ''), excludeCodigos);
  }

  /** POST /products-editor/apply — Body: { edits: [{ codigo, changes }] } */
  @Post('apply')
  async apply(
    @Req() req: any,
    @Body() body: { edits: Array<{ codigo: string; changes: EditChanges }> },
  ) {
    this.requireAdmin(req);
    return this.svc.apply({
      edits: body?.edits || [],
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /**
   * POST /products-editor/apply-marca-todos — Body: { q, marca }
   * MARCA EM MASSA: aplica em TODOS os resultados da busca no servidor,
   * sem o teto de 5.000 da tela (marcas com dezenas de milhares de variações).
   */
  @Post('apply-marca-todos')
  async applyMarcaTodos(@Req() req: any, @Body() body: { q: string; marca: string }) {
    this.requireAdmin(req);
    return this.svc.applyMarcaBySearch({
      q: String(body?.q || ''),
      marca: String(body?.marca || ''),
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /** GET /products-editor/audit — histórico recente (ANTES→DEPOIS). */
  @Get('audit')
  async audit(@Req() req: any, @Query('limit') limit?: string) {
    this.requireAdmin(req);
    return this.svc.auditRecent(limit ? parseInt(limit, 10) : 200);
  }
}
