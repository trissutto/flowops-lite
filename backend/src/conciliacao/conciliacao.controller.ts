import { Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ConciliacaoService } from './conciliacao.service';

/** CONCILIAÇÃO FINANCEIRA — importação + status (só admin). */
@Controller('conciliacao')
@UseGuards(JwtAuthGuard)
export class ConciliacaoController {
  constructor(private readonly svc: ConciliacaoService) {}

  private requireAdmin(req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
  }

  /** GET /conciliacao/status — contagens por gateway e status. */
  @Get('status')
  async status(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.status();
  }

  /** POST /conciliacao/importar?dias=400 — varredura manual das fontes locais. */
  @Post('importar')
  async importar(@Req() req: any, @Query('dias') dias?: string) {
    this.requireAdmin(req);
    const d = Math.min(2000, Math.max(1, parseInt(dias || '400', 10) || 400));
    return this.svc.importarTudo(d);
  }

  /** POST /conciliacao/conciliar?dias=400 — roda o MOTOR (idempotente). */
  @Post('conciliar')
  async conciliar(@Req() req: any, @Query('dias') dias?: string) {
    this.requireAdmin(req);
    const d = Math.min(2000, Math.max(1, parseInt(dias || '400', 10) || 400));
    return this.svc.conciliar(d);
  }

  /** GET /conciliacao/list?status=&gateway=&page= — dados pra tela. */
  @Get('list')
  async list(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('gateway') gateway?: string,
    @Query('loja') loja?: string,
    @Query('page') page?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.listar({ status, gateway, storeCode: loja || undefined, page: parseInt(page || '1', 10) || 1 });
  }

  /** GET /conciliacao/tx/:id/json — JSON bruto da transação (auditoria). */
  @Get('tx/:id/json')
  async json(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    return this.svc.verJson(id);
  }
}
