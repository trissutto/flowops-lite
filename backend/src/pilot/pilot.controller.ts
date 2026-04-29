import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { PilotService } from './pilot.service';

/**
 * Controller do Piloto Automático server-side.
 *
 * Rotas:
 *   GET    /pilot/status         → { on, killSwitch, whatsappConnected, ... }
 *   PATCH  /pilot/toggle         → body { on: boolean } — liga/desliga (persistido em DB)
 *   GET    /pilot/logs?limit=50  → últimos disparos (sucesso/skip/erro)
 *
 * Tudo autenticado (JWT) — só matriz liga/desliga.
 */
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
@Controller('pilot')
export class PilotController {
  constructor(private readonly svc: PilotService) {}

  @Get('status')
  status() {
    return this.svc.getStatus();
  }

  @Patch('toggle')
  async toggle(@Body() body: { on: boolean }, @Req() req: any) {
    const user = req?.user?.email || req?.user?.id || 'unknown';
    await this.svc.setOn(!!body.on, user);
    return this.svc.getStatus();
  }

  @Get('logs')
  logs(@Query('limit') limit?: string) {
    return this.svc.recentLogs(limit ? Number(limit) : 50);
  }

  /**
   * GET /pilot/diagnose/:wcOrderId
   * Dry-run: simula o piloto pra um pedido WC e retorna em qual gate parou
   * (ou se dispararia). Não modifica nada. Útil pra investigar "por que não
   * disparou em #12345".
   */
  @Get('diagnose/:wcOrderId')
  diagnose(@Param('wcOrderId') wcOrderId: string) {
    return this.svc.diagnoseOrder(Number(wcOrderId));
  }

  /**
   * POST /pilot/fire/:wcOrderId
   * FORÇA o piloto a tentar disparar um pedido específico (mesmo fluxo do
   * handleNewOrder). Respeita todos os gates — se a flag tá off ou tem
   * pick-order existente, vai bloquear igual.
   *
   * Use pra testar manualmente: liga o piloto, dispara em pedido pendente.
   * Resposta: { ok, ranNow, blockedReason? }
   */
  @Post('fire/:wcOrderId')
  async fire(@Param('wcOrderId') wcOrderId: string) {
    const id = Number(wcOrderId);
    // Roda diagnose primeiro pra responder rápido se vai bloquear
    const diag = await this.svc.diagnoseOrder(id);
    if (!diag.wouldFire) {
      return { ok: false, ranNow: false, blockedReason: diag.blocked, details: diag.details };
    }
    // Dispara em background (mesmo padrão do poller — fire-and-forget)
    this.svc.handleNewOrder(id).catch(() => {});
    return { ok: true, ranNow: true, target: diag.details };
  }
}
