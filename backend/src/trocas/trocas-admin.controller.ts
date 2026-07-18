import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { TrocasService, TROCA_STATUS } from './trocas.service';

/**
 * Painel administrativo do Portal de Trocas (Etapa 8 do fluxo).
 * Admin gerencia tudo; loja pode visualizar.
 */
@UseGuards(JwtAuthGuard)
@Controller('trocas')
export class TrocasAdminController {
  constructor(private readonly svc: TrocasService) {}

  private requireView(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store') {
      throw new ForbiddenException('Apenas admin ou loja');
    }
  }

  private requireAdmin(req: any) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
  }

  private who(req: any) {
    return {
      userId: req?.user?.sub || req?.user?.id || null,
      userName: req?.user?.name || req?.user?.email || null,
    };
  }

  /** GET /trocas — lista com filtros (status, q, from/to) */
  @Get()
  async list(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireView(req);
    return this.svc.list({
      status: status || undefined,
      q: q || undefined,
      from: from ? new Date(`${from}T00:00:00`) : undefined,
      to: to ? new Date(`${to}T23:59:59.999`) : undefined,
      limit: limit ? parseInt(limit, 10) : 100,
    });
  }

  /** GET /trocas/status-list — status válidos (pra UI) */
  @Get('status-list')
  statusList(@Req() req: any) {
    this.requireView(req);
    return { status: TROCA_STATUS };
  }

  /** GET /trocas/:id — detalhe + timeline + painel de benefícios */
  @Get(':id')
  async detail(@Req() req: any, @Param('id') id: string) {
    this.requireView(req);
    return this.svc.getDetail(id);
  }

  /** POST /trocas/:id/reversa { codigo, prazoDias? } — cola o código e dispara e-mail */
  @Post(':id/reversa')
  async reversa(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { codigo?: string; prazoDias?: number },
  ) {
    this.requireAdmin(req);
    if (!body?.codigo) throw new BadRequestException('Informe o código de postagem.');
    return this.svc.setReversaCodigo({
      id,
      codigo: body.codigo,
      prazoDias: body.prazoDias,
      ...this.who(req),
    });
  }

  /** POST /trocas/:id/status { status, nota? } */
  @Post(':id/status')
  async status(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { status?: string; nota?: string },
  ) {
    this.requireAdmin(req);
    if (!body?.status) throw new BadRequestException('Informe o status.');
    return this.svc.updateStatus({ id, status: body.status, nota: body.nota, ...this.who(req) });
  }

  /** POST /trocas/:id/conceder-reversa { justificativa } — auditada */
  @Post(':id/conceder-reversa')
  async conceder(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { justificativa?: string },
  ) {
    this.requireAdmin(req);
    return this.svc.concederReversa({
      trocaId: id,
      justificativa: String(body?.justificativa || ''),
      ...this.who(req),
    });
  }

  /** POST /trocas/:id/cancelar { motivo? } */
  @Post(':id/cancelar')
  async cancelar(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { motivo?: string },
  ) {
    this.requireAdmin(req);
    return this.svc.cancelar({ id, motivo: body?.motivo, ...this.who(req) });
  }
}
