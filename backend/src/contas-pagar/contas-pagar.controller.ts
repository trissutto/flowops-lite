import {
  Controller, ForbiddenException, Get, Post, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ContasPagarMigracaoService } from './contas-pagar-migracao.service';

/**
 * Admin da MIGRAÇÃO do Contas a Pagar (Fase 1/3 — matriz apenas).
 *   POST /admin/contas-pagar/espelho/sync — copia `pagar` do GIGA (raw)
 *   POST /admin/contas-pagar/migrar       — upsert idempotente no modelo novo
 *   GET  /admin/contas-pagar/validacao    — aceite: GIGA(espelho) × FLOW
 * As telas de operação chegam na Fase 2 (mockup aprovado 11/07).
 */
@Controller('admin/contas-pagar')
@UseGuards(JwtAuthGuard)
export class ContasPagarController {
  constructor(private readonly migracao: ContasPagarMigracaoService) {}

  private requireAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'master') {
      throw new ForbiddenException('Apenas admin/master');
    }
  }

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
}
