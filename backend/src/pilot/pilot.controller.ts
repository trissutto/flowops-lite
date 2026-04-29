import { Body, Controller, Get, Patch, Query, Req, UseGuards } from '@nestjs/common';
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
}
