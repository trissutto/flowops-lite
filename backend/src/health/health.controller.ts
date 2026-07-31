import { Controller, Get } from '@nestjs/common';
import { MigrationFlagsService } from './migration-flags.service';

/**
 * Healthcheck simples — usado pelo Railway pra saber se o container
 * tá vivo e responsivo antes de mandar trafego pra nova versão.
 * Rota: GET /api/health  (prefixo /api vem do setGlobalPrefix em main.ts)
 */
@Controller('health')
export class HealthController {
  constructor(private readonly flags: MigrationFlagsService) {}

  /**
   * GET /api/health/migracao — o que está LIGADO na migração Giga→Flow agora.
   * Aberto de propósito (só nomes de flag e ligado/desligado, sem segredo):
   * quando algo "some" da tela, esta é a primeira coisa a olhar, e ter que
   * logar antes atrasa o diagnóstico no meio de um incidente.
   */
  @Get('migracao')
  migracao() {
    const flags = this.flags.snapshot();
    return {
      ok: true,
      timestamp: new Date().toISOString(),
      resumo: {
        ligadas: flags.filter((f) => f.ligada).length,
        total: flags.length,
        ligadasPorOmissao: flags.filter((f) => f.ligadaPorOmissao).map((f) => f.nome),
        leiturasMigradasAtivas: flags.filter((f) => f.ligada && f.sensivel).map((f) => f.nome),
      },
      flags,
    };
  }

  @Get()
  health() {
    return {
      ok: true,
      service: 'flowops-backend',
      version: 'extrato-flow-remessas-produtos-2026-06-26',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }
}
