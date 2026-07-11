import {
  Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ContasPagarMigracaoService } from './contas-pagar-migracao.service';
import { ContasPagarService } from './contas-pagar.service';

/**
 * Contas a Pagar 100% Flow — v1 é ferramenta da MATRIZ (admin/master).
 *
 * MIGRAÇÃO (Fase 1/3):
 *   POST /admin/contas-pagar/espelho/sync — copia `pagar` do GIGA (raw)
 *   POST /admin/contas-pagar/migrar       — upsert idempotente no modelo novo
 *   GET  /admin/contas-pagar/validacao    — aceite: GIGA(espelho) × FLOW
 *
 * OPERAÇÃO (Fase 2 — telas do mockup aprovado 11/07):
 *   GET  stats · list · especies · lojas · opções · logs · funcionárias
 *   POST criar (com parcelas) · PATCH pagar/reabrir/em-maos/editar · DELETE soft
 */
@Controller('admin/contas-pagar')
@UseGuards(JwtAuthGuard)
export class ContasPagarController {
  constructor(
    private readonly migracao: ContasPagarMigracaoService,
    private readonly svc: ContasPagarService,
  ) {}

  private requireAdmin(req: any): string {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'master') {
      throw new ForbiddenException('Apenas admin/master');
    }
    return String(req?.user?.name || req?.user?.username || req?.user?.email || role);
  }

  // ── migração ──────────────────────────────────────────────────────────────
  @Post('espelho/sync')
  syncEspelho(@Req() req: any) {
    this.requireAdmin(req);
    return this.migracao.syncEspelho();
  }

  @Post('migrar')
  migrar(@Req() req: any) {
    this.requireAdmin(req);
    return this.migracao.migrar();
  }

  @Get('validacao')
  validar(@Req() req: any) {
    this.requireAdmin(req);
    return this.migracao.validar();
  }

  // ── operação ──────────────────────────────────────────────────────────────
  @Get('stats')
  stats(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.stats();
  }

  @Get('list')
  list(@Req() req: any, @Query() q: any) {
    this.requireAdmin(req);
    return this.svc.list({
      search: q.search,
      de: q.de,
      ate: q.ate,
      lojaCode: q.lojaCode,
      especieId: q.especieId,
      status: q.status,
      emMaos: q.emMaos === '1',
      incluirRestritas: true, // v1: módulo inteiro já é admin/master
      page: Number(q.page || 1),
      perPage: Number(q.perPage || 50),
    });
  }

  @Get('especies')
  especies(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.especies();
  }

  @Get('lojas')
  lojas(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.lojas();
  }

  @Get('opcoes/fornecedores')
  fornecedores(@Req() req: any, @Query('q') q?: string) {
    this.requireAdmin(req);
    return this.svc.fornecedoresOptions(q);
  }

  @Get('opcoes/funcionarias')
  funcionarias(@Req() req: any, @Query('q') q?: string) {
    this.requireAdmin(req);
    return this.svc.funcionariasOptions(q);
  }

  @Get('funcionarias/resumo')
  funcionariasResumo(@Req() req: any, @Query('mes') mes?: string) {
    this.requireAdmin(req);
    return this.svc.funcionariasResumo(mes);
  }

  @Post()
  criar(@Req() req: any, @Body() body: any) {
    const usuario = this.requireAdmin(req);
    return this.svc.criar(body, usuario);
  }

  @Patch(':id/pagar')
  pagar(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const usuario = this.requireAdmin(req);
    return this.svc.pagar(id, body, usuario);
  }

  @Patch(':id/reabrir')
  reabrir(@Req() req: any, @Param('id') id: string) {
    const usuario = this.requireAdmin(req);
    return this.svc.reabrir(id, usuario);
  }

  @Patch(':id/em-maos')
  emMaos(@Req() req: any, @Param('id') id: string) {
    const usuario = this.requireAdmin(req);
    return this.svc.toggleEmMaos(id, usuario);
  }

  @Patch(':id')
  atualizar(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const usuario = this.requireAdmin(req);
    return this.svc.atualizar(id, body, usuario);
  }

  @Delete(':id')
  excluir(@Req() req: any, @Param('id') id: string) {
    const usuario = this.requireAdmin(req);
    return this.svc.excluir(id, usuario);
  }

  @Get(':id/logs')
  logs(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    return this.svc.logs(id);
  }
}
