import {
  Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { DreService } from './dre.service';

/**
 * /dre — painel de Resultado (DRE) por loja.
 *
 * v1 é ferramenta de DONO: admin/master apenas (decisão 26/07). Gerente de
 * loja vendo o próprio resultado fica pra uma fase seguinte.
 */
@Controller('dre')
@UseGuards(JwtAuthGuard)
export class DreController {
  constructor(private readonly svc: DreService) {}

  private requireAdmin(req: any): string {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'master') {
      throw new ForbiddenException('Apenas admin/master');
    }
    return String(req?.user?.name || req?.user?.username || req?.user?.email || role);
  }

  @Get('resultado')
  resultado(@Req() req: any, @Query('de') de: string, @Query('ate') ate: string) {
    this.requireAdmin(req);
    return this.svc.resultado({ de, ate });
  }

  @Get('drill')
  drill(
    @Req() req: any,
    @Query('de') de: string,
    @Query('ate') ate: string,
    @Query('coluna') coluna: string,
    @Query('linha') linha: string,
  ) {
    this.requireAdmin(req);
    return this.svc.drill({ de, ate, coluna, linha });
  }

  @Get('config')
  config(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.config();
  }

  @Patch('config/loja/:code')
  setGrupoLoja(@Req() req: any, @Param('code') code: string, @Body() body: { grupo: string }) {
    this.requireAdmin(req);
    return this.svc.setGrupoLoja(code, body?.grupo);
  }

  @Patch('config/especie/:id')
  setGrupoEspecie(@Req() req: any, @Param('id') id: string, @Body() body: { grupo: string }) {
    this.requireAdmin(req);
    return this.svc.setGrupoEspecie(id, body?.grupo);
  }

  @Post('config/aliquota')
  upsertAliquota(
    @Req() req: any,
    @Body() body: { cnpj: string; mes: string; aliquotaPct: number; observacao?: string },
  ) {
    const usuario = this.requireAdmin(req);
    return this.svc.upsertAliquota(body, usuario);
  }

  @Delete('config/aliquota/:id')
  deleteAliquota(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    return this.svc.deleteAliquota(id);
  }

  // ── ajustes gerenciais (não tocam no Contas a Pagar) ──

  @Get('config/ajustes')
  listAjustes(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.listAjustes();
  }

  @Post('config/ajuste')
  upsertAjuste(@Req() req: any, @Body() body: any) {
    const usuario = this.requireAdmin(req);
    return this.svc.upsertAjuste(body, usuario);
  }

  @Delete('config/ajuste/:id')
  deleteAjuste(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    return this.svc.deleteAjuste(id);
  }

  // ── taxas de cartão (viram despesa variável na DRE) ──

  @Get('config/taxas')
  listTaxas(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.listTaxas();
  }

  /** Bandeiras que apareceram nas vendas do período, com volume. */
  @Get('config/bandeiras')
  bandeiras(@Req() req: any, @Query('de') de: string, @Query('ate') ate: string) {
    this.requireAdmin(req);
    return this.svc.bandeirasDoPeriodo({ de, ate });
  }

  @Post('config/taxa')
  upsertTaxa(@Req() req: any, @Body() body: any) {
    const usuario = this.requireAdmin(req);
    return this.svc.upsertTaxa(body, usuario);
  }

  @Delete('config/taxa/:id')
  deleteTaxa(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    return this.svc.deleteTaxa(id);
  }
}
