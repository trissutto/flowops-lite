import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param,
  Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CrediariosService } from './crediarios.service';
import { CobrancaAutoService } from './cobranca-auto.service';
import { PrismaService } from '../prisma/prisma.service';

interface AuthUser {
  userId: string;
  email: string;
  role: string;
  storeId: string | null;
}

/**
 * /crediarios — Cobrança de parcelas vencidas (matriz/operator only).
 *
 *   GET  /crediarios/schema
 *   GET  /crediarios/diagnose
 *   GET  /crediarios/vencidos?loja=01&dataInicio=2026-01-01&dataFim=2026-04-20
 *   GET  /crediarios/vencidos-clientes?loja=01&dataInicio=...
 *   GET  /crediarios/cobranca/templates       — preview dos 6 templates
 *   POST /crediarios/cobranca/preview         — body { loja, dataInicio?, dataFim?, minDiasAtraso? }
 *   POST /crediarios/cobranca/enviar          — body { loja, ..., delayMs?, dryRun? }
 */
@Controller('crediarios')
@UseGuards(JwtAuthGuard)
export class CrediariosController {
  constructor(
    private readonly svc: CrediariosService,
    private readonly auto: CobrancaAutoService,
    private readonly prisma: PrismaService,
  ) {}

  private ensureMatriz(req: any) {
    const u = req.user as AuthUser;
    if (u.role !== 'admin' && u.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz acessa cobrança');
    }
  }

  @Get('schema')
  async schema(@Req() req: any) {
    this.ensureMatriz(req);
    const map = await this.svc.detectColumns(true);
    return { columnMap: map };
  }

  @Get('diagnose')
  async diagnose(@Req() req: any) {
    this.ensureMatriz(req);
    return this.svc.diagnoseRawColumns();
  }

  /**
   * GET /crediarios/diagnose-clientes
   * Diagnóstico do universo total de clientes no Giga + cobertura de telefones.
   * Retorna: total, com FONECEL preenchido, com FONERES preenchido, sem nenhum.
   */
  @Get('diagnose-clientes')
  async diagnoseClientes(@Req() req: any) {
    this.ensureMatriz(req);
    return this.svc.diagnoseClientesPhones();
  }

  @Get('vencidos')
  async vencidos(
    @Req() req: any,
    @Query('loja') loja?: string,
    @Query('daysBack') daysBack?: string,
    @Query('dataInicio') dataInicio?: string,
    @Query('dataFim') dataFim?: string,
    @Query('limit') limit?: string,
  ) {
    this.ensureMatriz(req);
    if (!loja) throw new BadRequestException('Parâmetro "loja" é obrigatório (ex: 01)');
    return this.svc.listOverdue({
      storeCode: loja,
      daysBack: daysBack ? Number(daysBack) : undefined,
      dataInicio,
      dataFim,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('vencidos-clientes')
  async vencidosClientes(
    @Req() req: any,
    @Query('loja') loja?: string,
    @Query('daysBack') daysBack?: string,
    @Query('dataInicio') dataInicio?: string,
    @Query('dataFim') dataFim?: string,
  ) {
    this.ensureMatriz(req);
    if (!loja) throw new BadRequestException('Parâmetro "loja" é obrigatório (ex: 01)');
    return this.svc.listOverdueByCustomer({
      storeCode: loja,
      daysBack: daysBack ? Number(daysBack) : undefined,
      dataInicio,
      dataFim,
    });
  }

  // ============== CAMPANHA ==============

  @Get('cobranca/templates')
  async templates(@Req() req: any) {
    this.ensureMatriz(req);
    return { templates: await this.svc.previewTemplates() };
  }

  // ============== TEMPLATES EDITÁVEIS ==============

  @Get('templates-config')
  async getTemplatesConfig(@Req() req: any) {
    this.ensureMatriz(req);
    const cfg = await this.svc.getEditableTemplates(true);
    return cfg;
  }

  @Post('templates-config')
  async saveTemplatesConfig(
    @Req() req: any,
    @Body() body: { templates: string[]; lojaNome?: string },
  ) {
    this.ensureMatriz(req);
    if (!Array.isArray(body?.templates)) {
      throw new BadRequestException('Campo "templates" precisa ser array de strings');
    }
    return this.svc.setEditableTemplates(body.templates, body.lojaNome);
  }

  @Post('templates-config/reset')
  async resetTemplatesConfig(@Req() req: any) {
    this.ensureMatriz(req);
    return this.svc.resetEditableTemplates();
  }

  // ============== VALIDAÇÃO WhatsApp ==============

  @Post('validar-whatsapp')
  async validarWhatsapp(
    @Req() req: any,
    @Body() body: { numbers: string[] },
  ) {
    this.ensureMatriz(req);
    if (!Array.isArray(body?.numbers)) {
      throw new BadRequestException('Campo "numbers" precisa ser array');
    }
    return this.svc.validateNumbers(body.numbers);
  }

  @Post('cobranca/send-one')
  async sendOne(
    @Req() req: any,
    @Body() body: { number: string; text: string },
  ) {
    this.ensureMatriz(req);
    if (!body?.number || !body?.text) {
      throw new BadRequestException('Campos "number" e "text" são obrigatórios');
    }
    return this.svc.sendOne({ rawNumber: body.number, text: body.text });
  }

  @Post('cobranca/preview')
  async previewCampanha(
    @Req() req: any,
    @Body() body: {
      loja: string;
      daysBack?: number;
      dataInicio?: string;
      dataFim?: string;
      minDiasAtraso?: number;
      dayOffset?: number;
    },
  ) {
    this.ensureMatriz(req);
    if (!body?.loja) throw new BadRequestException('Campo "loja" é obrigatório (ex: 01)');
    return this.svc.buildCampanhaQueue({
      storeCode: body.loja,
      daysBack: body.daysBack,
      dataInicio: body.dataInicio,
      dataFim: body.dataFim,
      minDiasAtraso: body.minDiasAtraso,
      dayOffset: body.dayOffset,
    });
  }

  @Post('cobranca/enviar')
  async enviarCampanha(
    @Req() req: any,
    @Body() body: {
      loja: string;
      daysBack?: number;
      dataInicio?: string;
      dataFim?: string;
      minDiasAtraso?: number;
      dayOffset?: number;
      delayMs?: number;
      dryRun?: boolean;
    },
  ) {
    this.ensureMatriz(req);
    if (!body?.loja) throw new BadRequestException('Campo "loja" é obrigatório (ex: 01)');
    return this.svc.dispararCampanha({
      storeCode: body.loja,
      daysBack: body.daysBack,
      dataInicio: body.dataInicio,
      dataFim: body.dataFim,
      minDiasAtraso: body.minDiasAtraso,
      dayOffset: body.dayOffset,
      delayMs: body.delayMs,
      dryRun: body.dryRun,
    });
  }

  // ============== CAMPANHAS AUTOMÁTICAS (CRUD) ==============

  @Get('campanhas')
  async listCampanhas(@Req() req: any) {
    this.ensureMatriz(req);
    const campanhas = await (this.prisma as any).cobrancaCampanha.findMany({
      orderBy: { createdAt: 'desc' },
    });
    // Stats por campanha (últimas 30 tentativas + total)
    const ids = campanhas.map((c: any) => c.id);
    const stats: Record<string, { ok: number; falha: number; ultima: Date | null }> = {};
    if (ids.length) {
      const grouped = await (this.prisma as any).cobrancaTentativa.groupBy({
        by: ['campanhaId', 'status'],
        where: { campanhaId: { in: ids } },
        _count: { id: true },
      });
      for (const g of grouped) {
        if (!stats[g.campanhaId]) stats[g.campanhaId] = { ok: 0, falha: 0, ultima: null };
        if (g.status === 'ok') stats[g.campanhaId].ok = g._count.id;
        else if (g.status === 'falha') stats[g.campanhaId].falha = g._count.id;
      }
    }
    return { campanhas, stats };
  }

  @Get('campanhas/:id')
  async getCampanha(@Req() req: any, @Param('id') id: string) {
    this.ensureMatriz(req);
    const camp = await (this.prisma as any).cobrancaCampanha.findUnique({ where: { id } });
    if (!camp) throw new BadRequestException('Campanha não encontrada');
    const tentativas = await (this.prisma as any).cobrancaTentativa.findMany({
      where: { campanhaId: id },
      orderBy: { enviadaEm: 'desc' },
      take: 100,
    });
    return { campanha: camp, tentativas };
  }

  @Post('campanhas')
  async createCampanha(
    @Req() req: any,
    @Body() body: {
      nome: string;
      lojaCode: string;
      horaInicio: string;
      horaFim: string;
      frequencia: string;
      minDiasAtraso?: number;
      maxDiasAtraso?: number | null;
      delayMs?: number;
      ativa?: boolean;
    },
  ) {
    this.ensureMatriz(req);
    if (!body?.nome || !body?.lojaCode || !body?.horaInicio || !body?.horaFim || !body?.frequencia) {
      throw new BadRequestException('Campos obrigatórios: nome, lojaCode, horaInicio, horaFim, frequencia');
    }
    if (!/^\d{2}:\d{2}$/.test(body.horaInicio) || !/^\d{2}:\d{2}$/.test(body.horaFim)) {
      throw new BadRequestException('horaInicio e horaFim devem estar no formato HH:MM');
    }
    const validFreq = ['1x_dia', '2x_dia', 'cada_2_dias', 'cada_3_dias', 'semanal'];
    if (!validFreq.includes(body.frequencia)) {
      throw new BadRequestException(`frequencia inválida. Use: ${validFreq.join(', ')}`);
    }
    const u = req.user;
    const camp = await (this.prisma as any).cobrancaCampanha.create({
      data: {
        nome: body.nome.trim(),
        lojaCode: body.lojaCode.padStart(2, '0'),
        horaInicio: body.horaInicio,
        horaFim: body.horaFim,
        frequencia: body.frequencia,
        minDiasAtraso: body.minDiasAtraso ?? 3,
        maxDiasAtraso: body.maxDiasAtraso ?? null,
        delayMs: body.delayMs ?? 120_000,
        ativa: body.ativa ?? true,
        createdByUserId: u?.userId || null,
      },
    });
    return camp;
  }

  @Patch('campanhas/:id')
  async updateCampanha(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: Partial<{
      nome: string;
      horaInicio: string;
      horaFim: string;
      frequencia: string;
      minDiasAtraso: number;
      maxDiasAtraso: number | null;
      delayMs: number;
      ativa: boolean;
    }>,
  ) {
    this.ensureMatriz(req);
    const data: any = {};
    if (body.nome !== undefined) data.nome = body.nome.trim();
    if (body.horaInicio !== undefined) {
      if (!/^\d{2}:\d{2}$/.test(body.horaInicio)) throw new BadRequestException('horaInicio formato HH:MM');
      data.horaInicio = body.horaInicio;
    }
    if (body.horaFim !== undefined) {
      if (!/^\d{2}:\d{2}$/.test(body.horaFim)) throw new BadRequestException('horaFim formato HH:MM');
      data.horaFim = body.horaFim;
    }
    if (body.frequencia !== undefined) {
      const validFreq = ['1x_dia', '2x_dia', 'cada_2_dias', 'cada_3_dias', 'semanal'];
      if (!validFreq.includes(body.frequencia)) throw new BadRequestException('frequencia inválida');
      data.frequencia = body.frequencia;
      // Reset proximoEnvio quando frequência muda — força recalcular
      data.proximoEnvio = null;
    }
    if (body.minDiasAtraso !== undefined) data.minDiasAtraso = body.minDiasAtraso;
    if (body.maxDiasAtraso !== undefined) data.maxDiasAtraso = body.maxDiasAtraso;
    if (body.delayMs !== undefined) data.delayMs = body.delayMs;
    if (body.ativa !== undefined) data.ativa = body.ativa;
    const camp = await (this.prisma as any).cobrancaCampanha.update({ where: { id }, data });
    return camp;
  }

  @Delete('campanhas/:id')
  async deleteCampanha(@Req() req: any, @Param('id') id: string) {
    this.ensureMatriz(req);
    await (this.prisma as any).cobrancaCampanha.delete({ where: { id } });
    return { ok: true };
  }

  @Post('campanhas/:id/run-now')
  async runNow(@Req() req: any, @Param('id') id: string) {
    this.ensureMatriz(req);
    return this.auto.runManual(id);
  }

  /** Retorna se a campanha está rodando AGORA em background (pra UI mostrar
   *  badge "EXECUTANDO" entre o "Rodar agora" e o término real do loop). */
  @Get('campanhas/:id/status')
  async campanhaStatus(@Req() req: any, @Param('id') id: string) {
    this.ensureMatriz(req);
    return { running: this.auto.isRunning(id) };
  }

  /** Retorna IDs de TODAS as campanhas rodando — pro dashboard listar todas. */
  @Get('campanhas-running')
  async campanhasRunning(@Req() req: any) {
    this.ensureMatriz(req);
    return { ids: this.auto.getRunningCampanhas() };
  }
}
