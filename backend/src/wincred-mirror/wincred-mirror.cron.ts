import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WincredMirrorService } from './wincred-mirror.service';

/**
 * WincredMirrorCron — agenda sync incremental a cada 10min.
 *
 * Estrategia:
 *  - A cada 10 min: roda syncIncremental (so produtos modificados por DATAALT)
 *  - 1x por dia (3h da manha): roda syncAll (full sync de seguranca pra catch-all)
 *
 * Guard de overlap: se ja tem sync rodando, pula a janela atual.
 *
 * Liga/desliga via env WINCRED_MIRROR_CRON_ENABLED=1 (default off em dev).
 */
@Injectable()
export class WincredMirrorCron {
  private readonly logger = new Logger(WincredMirrorCron.name);
  private isRunningIncremental = false;
  private isRunningFull = false;

  constructor(private readonly mirror: WincredMirrorService) {}

  /** Giga desligado (28/08): não há de onde puxar — os crons viram no-op
   *  silencioso em vez de errar de hora em hora no log. */
  private get gigaVivo(): boolean {
    return require('../common/replica-giga').pullGigaLigado();
  }

  private get enabled(): boolean {
    return String(process.env.WINCRED_MIRROR_CRON_ENABLED || '').trim() === '1';
  }

  /** Sync incremental a cada 10 minutos */
  @Cron('*/10 * * * *', { name: 'wincred-mirror-incremental' })
  async runIncremental() {
    if (!this.enabled) return;
    if (!this.gigaVivo) return;
    if (this.isRunningIncremental || this.isRunningFull) {
      this.logger.log('[cron] incremental skipped — outro sync em andamento');
      return;
    }
    this.isRunningIncremental = true;
    try {
      const r = await this.mirror.syncIncremental();
      this.logger.log(
        `[cron] incremental OK — ${r.produtosAtualizados} produtos, ${r.estoqueAtualizado} estoque (${r.durationMs}ms)`,
      );
    } catch (e) {
      this.logger.error(`[cron] incremental FAIL: ${(e as Error).message}`);
    } finally {
      this.isRunningIncremental = false;
    }
  }

  // O cron de estoque de hora em hora (minuto 23) saiu em 09/2026: ele
  // importava o saldo de um ERP externo, e desde 14/07 o FLOW é a fonte do
  // estoque — quem mantém `wincred_estoque` em dia são os movimentos do
  // próprio sistema (bipe, venda, remessa, realinhamento). Ver `syncEstoque`
  // no service.

  /** Full sync diario as 3h da manha — garante alinhamento mesmo com DATAALT bugada */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'wincred-mirror-full' })
  async runFull() {
    if (!this.enabled) return;
    if (!this.gigaVivo) return;
    if (this.isRunningFull) return;
    this.isRunningFull = true;
    try {
      this.logger.log('[cron] full sync diario iniciado');
      const r = await this.mirror.syncAll();
      this.logger.log(
        `[cron] full sync OK — ${r.total.length} tabelas, ${r.durationMs}ms`,
      );
    } catch (e) {
      this.logger.error(`[cron] full sync FAIL: ${(e as Error).message}`);
    } finally {
      this.isRunningFull = false;
    }
  }
}
