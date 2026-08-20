import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { AvaliacoesService } from './avaliacoes.service';
import { AvaliacoesConfig, AvaliacoesConfigService } from './avaliacoes-config.service';

/**
 * Programa de avaliação na mão da matriz — /admin/avaliacoes.
 *
 * Duas coisas: a RÉGUA (quantos pontos vale cada coisa) e a MODERAÇÃO
 * (esconder o que não deve aparecer no site). Só matriz.
 */
@Controller('admin/avaliacoes')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class AvaliacoesAdminController {
  constructor(
    private readonly svc: AvaliacoesService,
    private readonly cfg: AvaliacoesConfigService,
  ) {}

  /** GET /config — a régua de pontos que está valendo. */
  @Get('config')
  async getConfig() {
    return this.cfg.get();
  }

  /** POST /config — muda a régua. Vale pra PRÓXIMA avaliação. */
  @Post('config')
  async setConfig(@Body() body: Partial<AvaliacoesConfig>) {
    return this.cfg.set(body || {});
  }

  /** GET /resumo — o tamanho do programa em números. */
  @Get('resumo')
  async resumo() {
    return this.svc.resumoAdmin();
  }

  /** GET — lista as avaliações (filtro por status e por REF). */
  @Get()
  async listar(
    @Query('status') status?: string,
    @Query('ref') ref?: string,
    @Query('limite') limite?: string,
  ) {
    return this.svc.listarAdmin({ status, ref, limite: Number(limite) || 100 });
  }

  /** POST /:id/status — publica ou esconde uma avaliação. */
  @Post(':id/status')
  async moderar(@Param('id') id: string, @Body() body: { status?: string }) {
    return this.svc.moderar(id, String(body?.status || 'publicada'));
  }
}
