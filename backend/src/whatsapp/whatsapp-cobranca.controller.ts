import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { WhatsappCobrancaService } from './whatsapp-cobranca.service';

@Controller('whatsapp/cobranca')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class WhatsappCobrancaController {
  constructor(private readonly wa: WhatsappCobrancaService) {}

  @Get('status')
  status() {
    return this.wa.getStatus();
  }

  @Post('connect')
  async connect() {
    this.wa.connect().catch(() => {});
    return { ok: true };
  }

  @Post('disconnect')
  async disconnect() {
    await this.wa.logout();
    return { ok: true };
  }

  @Get('config')
  config() {
    return this.wa.readConfig();
  }

  @Post('config')
  async saveConfig(@Body() body: {
    horaInicio?: string;
    horaFim?: string;
    intervaloSeg?: number;
    pausaACada?: number;
    pausaSeg?: number;
  }) {
    await this.wa.saveConfig(body);
    return this.wa.readConfig();
  }

  @Get('schedule-check')
  scheduleCheck() {
    return this.wa.isWithinSchedule();
  }

  @Post('send-test')
  async sendTest(@Body() body: { number: string; text?: string }) {
    return this.wa.sendText(
      body.number,
      body.text || '🧪 Teste de conexão WhatsApp Cobrança · Lurd\'s Order One',
    );
  }
}
