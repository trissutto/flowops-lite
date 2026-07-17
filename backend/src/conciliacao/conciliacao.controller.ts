import { Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
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
}
