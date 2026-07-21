import { Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ClientesGigaService } from './clientes-giga.service';

/**
 * /admin/clientes-giga — importação completa da tabela `clientes` do Giga.
 * Matriz-only. Primeira carga: POST /sync (pode levar alguns minutos).
 * GET /sample mostra TODAS as colunas originais — insumo pra tela de consulta.
 */
@Controller('admin/clientes-giga')
@UseGuards(JwtAuthGuard)
export class ClientesGigaController {
  constructor(private readonly svc: ClientesGigaService) {}

  private requireAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator)');
    }
  }

  /** Dispara em background — responde na hora; acompanhar em GET /status. */
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

  /** Re-roda só a vinculação com o Customer mestre (ex.: após dedup no CRM). */
  @Post('vincular')
  vincular(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.vincular();
  }

  @Get('sample')
  sample(@Req() req: any, @Query('limit') limit?: string) {
    this.requireAdmin(req);
    return this.svc.sample(Number(limit) || 3);
  }
}
