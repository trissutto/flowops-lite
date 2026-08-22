import { Controller, Get } from '@nestjs/common';
import { EventLoopService } from './event-loop.service';
import { MigrationFlagsService } from './migration-flags.service';

/**
 * Healthcheck simples — usado pelo Railway pra saber se o container
 * tá vivo e responsivo antes de mandar trafego pra nova versão.
 * Rota: GET /api/health  (prefixo /api vem do setGlobalPrefix em main.ts)
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly flags: MigrationFlagsService,
    private readonly eventLoop: EventLoopService,
  ) {}

  /**
   * GET /api/health/diagnostico — POR QUE O BACKEND CONGELOU.
   *
   * Aberto de propósito, pela mesma razão do `/migracao`: quando a loja liga
   * dizendo "travou", ter que autenticar antes de olhar atrasa justamente o
   * diagnóstico que precisa ser feito enquanto o sintoma está acontecendo. Não
   * devolve segredo nenhum — só contadores do próprio processo.
   *
   * Como ler:
   *  - `atrasoDoLoopMs.p99` alto  → o processo para de responder; veja
   *    `maisSuspeitas` pra saber quem estava em voo.
   *  - `gc.pctDoTempo` acima de ~5% ou `memoria.heapUsado` perto do
   *    `heapLimite` → é pressão de memória, e o conserto é cache/heap.
   *  - `recursos` com número subindo entre travamentos → vazamento de socket
   *    ou de conexão, não pico de uso.
   */
  @Get('diagnostico')
  diagnostico() {
    return {
      ok: true,
      timestamp: new Date().toISOString(),
      uptimeS: Math.round(process.uptime()),
      ...this.eventLoop.snapshot(),
    };
  }

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
