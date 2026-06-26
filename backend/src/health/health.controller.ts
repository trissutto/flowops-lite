import { Controller, Get } from '@nestjs/common';

/**
 * Healthcheck simples — usado pelo Railway pra saber se o container
 * tá vivo e responsivo antes de mandar trafego pra nova versão.
 * Rota: GET /api/health  (prefixo /api vem do setGlobalPrefix em main.ts)
 */
@Controller('health')
export class HealthController {
  @Get()
  health() {
    return {
      ok: true,
      service: 'flowops-backend',
      version: 'extrato-mercadoria-flow-2026-06-26',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }
}
