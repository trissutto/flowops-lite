import { Controller, ForbiddenException, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CrediarioNativoService } from './crediario-nativo.service';

/**
 * /admin/crediario-nativo — importação COMPLETA do `movimento` do Giga
 * (crediário nativo, fase 1). Matriz-only. Primeira carga: POST /sync
 * (background — acompanhar em GET /status).
 */
@Controller('admin/crediario-nativo')
@UseGuards(JwtAuthGuard)
export class CrediarioNativoController {
  constructor(private readonly svc: CrediarioNativoService) {}

  private requireAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator)');
    }
  }

  @Post('sync')
  sync(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.startBackground();
  }

  @Get('status')
  status(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.status();
  }
}
