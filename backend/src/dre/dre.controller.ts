import {
  BadRequestException, Body, Controller, Delete, ForbiddenException,
  Get, Param, Patch, Post, Query, Req, UseGuards,
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
    @Query('especie') especie?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.drill({ de, ate, coluna, linha, especie });
  }

  @Get('config')
  config(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.config();
  }

  /**
   * GET /api/dre/diagnostico/cupom?de=&ate=
   * Mede cada candidata a chave de cupom contra o nº de vendas do PDV.
   * Existe porque o ticket médio saiu irreal e eu já errei uma vez trocando
   * a chave por suposição — agora só troco com o número na mão.
   */
  @Get('diagnostico/cupom')
  diagnosticoCupom(@Req() req: any, @Query('de') de: string, @Query('ate') ate: string) {
    this.requireAdmin(req);
    return this.svc.diagnosticoCupom({ de, ate });
  }

  @Patch('config/loja/:code')
  setGrupoLoja(@Req() req: any, @Param('code') code: string, @Body() body: { grupo: string }) {
    this.requireAdmin(req);
    return this.svc.setGrupoLoja(code, body?.grupo);
  }

  /** Markup do CMV desta loja. null/vazio volta pro padrão da rede. */
  @Patch('config/loja/:code/markup')
  setMarkupLoja(@Req() req: any, @Param('code') code: string, @Body() body: { markup: number | null }) {
    this.requireAdmin(req);
    return this.svc.setMarkupLoja(code, body?.markup ?? null);
  }

  @Patch('config/especie/:id')
  setGrupoEspecie(@Req() req: any, @Param('id') id: string, @Body() body: { grupo: string }) {
    this.requireAdmin(req);
    return this.svc.setGrupoEspecie(id, body?.grupo);
  }

  /** Cria espécie de conta — não existia no sistema até 26/07. */
  @Post('config/especie')
  criarEspecie(@Req() req: any, @Body() body: { nome: string; dreGrupo?: string; restrita?: boolean }) {
    const usuario = this.requireAdmin(req);
    return this.svc.criarEspecie(body, usuario);
  }

  /** Inativa (não apaga — o histórico continua apontando pra ela). */
  @Delete('config/especie/:id')
  inativarEspecie(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    return this.svc.setEspecieAtiva(id, false);
  }

  @Patch('config/especie/:id/reativar')
  reativarEspecie(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    return this.svc.setEspecieAtiva(id, true);
  }

  // ── reclassificação em massa (mexe no Contas a Pagar real) ──

  /** Prévia: o que seria movido. SEMPRE consultada antes de aplicar. */
  @Get('config/reclassificar/previa')
  previaReclassificacao(
    @Req() req: any,
    @Query('especieOrigemId') especieOrigemId?: string,
    @Query('busca') busca?: string,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.previaReclassificacao({ especieOrigemId, busca, de, ate });
  }

  @Post('config/reclassificar')
  async reclassificar(
    @Req() req: any,
    @Body() body: {
      especieOrigemId?: string; busca?: string; de?: string; ate?: string;
      especieDestinoId: string;
    },
  ) {
    const usuario = this.requireAdmin(req);
    try {
      return await this.svc.reclassificarEmMassa(body, usuario);
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      // 500 sem mensagem não ajuda ninguém no meio de uma operação em massa —
      // devolve o motivo real (foi assim que o VarChar(20) estourado apareceu).
      throw new BadRequestException(
        `Não deu pra reclassificar: ${e?.message || e}`,
      );
    }
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

  // ── encargo sobre folha por CNPJ (Simples × Presumido) ──

  @Get('config/encargos-folha')
  listEncargosFolha(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.listEncargosFolha();
  }

  @Post('config/encargo-folha')
  upsertEncargoFolha(
    @Req() req: any,
    @Body() body: { cnpj: string; regime?: string; encargoPct: number; observacao?: string },
  ) {
    const usuario = this.requireAdmin(req);
    return this.svc.upsertEncargoFolha(body, usuario);
  }

  @Delete('config/encargo-folha/:id')
  deleteEncargoFolha(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    return this.svc.deleteEncargoFolha(id);
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

  // ── realizado do mês (sobrepõe o coeficiente) ──

  @Get('config/realizados')
  listRealizados(@Req() req: any, @Query('mes') mes: string) {
    this.requireAdmin(req);
    return this.svc.listRealizados(mes);
  }

  @Post('config/realizado')
  lancarRealizado(
    @Req() req: any,
    @Body() body: { ajusteId: string; mes: string; valor: number; observacao?: string },
  ) {
    const usuario = this.requireAdmin(req);
    return this.svc.lancarRealizado(body, usuario);
  }

  @Delete('config/realizado/:ajusteId/:mes')
  apagarRealizado(@Req() req: any, @Param('ajusteId') ajusteId: string, @Param('mes') mes: string) {
    this.requireAdmin(req);
    return this.svc.apagarRealizado(ajusteId, mes);
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
