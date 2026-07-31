import {
  Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ContasPagarMigracaoService } from './contas-pagar-migracao.service';
import { ContasPagarService } from './contas-pagar.service';
import { ContasPagarAssociacaoService } from './contas-pagar-associacao.service';

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
    private readonly assoc: ContasPagarAssociacaoService,
  ) {}

  private requireAdmin(req: any): string {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'master') {
      throw new ForbiddenException('Apenas admin/master');
    }
    return String(req?.user?.name || req?.user?.username || req?.user?.email || role);
  }

  // ── migração (EM BACKGROUND — o proxy corta requisição longa em ~5min) ────
  @Post('espelho/sync')
  syncEspelho(@Req() req: any) {
    this.requireAdmin(req);
    return this.migracao.startEspelhoBackground();
  }

  @Post('migrar')
  migrar(@Req() req: any) {
    this.requireAdmin(req);
    return this.migracao.startMigracaoBackground();
  }

  @Get('progresso')
  progresso(@Req() req: any) {
    this.requireAdmin(req);
    return this.migracao.getProgresso();
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

  /** Baixa TODAS as contas ABERTAS do filtro atual (motivo obrigatório + auditoria). */
  @Post('baixa-em-lote')
  baixaEmLote(@Req() req: any, @Body() body: any) {
    const usuario = this.requireAdmin(req);
    return this.svc.baixaEmLote(
      {
        search: body?.filtros?.search,
        de: body?.filtros?.de,
        ate: body?.filtros?.ate,
        lojaCode: body?.filtros?.lojaCode,
        especieId: body?.filtros?.especieId,
        emMaos: !!body?.filtros?.emMaos,
        incluirRestritas: true,
      },
      body,
      usuario,
    );
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

  /** Exclusão em lote (seleção na tela). Body: { ids: string[] } — máx 500. */
  @Post('excluir-lote')
  excluirLote(@Req() req: any, @Body() body: { ids?: string[] }) {
    const usuario = this.requireAdmin(req);
    return this.svc.excluirLote(body?.ids || [], usuario);
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

  // ── associação Fornecedor → Funcionária ───────────────────────────────────
  @Post('associacao/importar-giga')
  importarGiga(@Req() req: any) {
    const usuario = this.requireAdmin(req);
    return this.assoc.importarFuncionariasGiga(usuario);
  }

  @Get('associacao/candidatos')
  candidatos(@Req() req: any) {
    this.requireAdmin(req);
    return this.assoc.candidatos();
  }

  /** Painel INVERTIDO: funcionárias (RH, alfabética) como referência. */
  @Get('associacao/painel')
  painelPorFuncionaria(@Req() req: any) {
    this.requireAdmin(req);
    return this.assoc.painelPorFuncionaria();
  }

  /** Fornecedores pendentes por qualquer parte do nome (picker do painel). */
  @Get('associacao/pendentes')
  pendentes(@Req() req: any, @Query('q') q?: string) {
    this.requireAdmin(req);
    return this.assoc.pendentes(q);
  }

  @Get('associacao/funcionarias')
  buscarFuncionarias(@Req() req: any, @Query('q') q?: string) {
    this.requireAdmin(req);
    return this.assoc.buscarFuncionarias(q);
  }

  @Get('associacao/decididos')
  decididos(@Req() req: any) {
    this.requireAdmin(req);
    return this.assoc.decididos();
  }

  @Post('associacao/associar')
  associar(@Req() req: any, @Body() body: any) {
    const usuario = this.requireAdmin(req);
    return this.assoc.associar(body, usuario);
  }

  @Post('associacao/confirmar-exatos')
  confirmarExatos(@Req() req: any) {
    const usuario = this.requireAdmin(req);
    return this.assoc.confirmarExatos(usuario);
  }

  @Post('associacao/nao-eh-pessoa')
  naoEhPessoa(@Req() req: any, @Body() body: any) {
    const usuario = this.requireAdmin(req);
    return this.assoc.naoEhPessoa(Number(body?.fornecedorGigaCodigo), usuario);
  }

  @Post('associacao/desfazer')
  desfazerAssociacao(@Req() req: any, @Body() body: any) {
    const usuario = this.requireAdmin(req);
    return this.assoc.desfazer(Number(body?.fornecedorGigaCodigo), usuario);
  }
}
