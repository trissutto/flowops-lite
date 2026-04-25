import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CrediariosService } from './crediarios.service';

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
  constructor(private readonly svc: CrediariosService) {}

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
    return { templates: this.svc.previewTemplates() };
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
}
