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

  private get enabled(): boolean {
    return String(process.env.WINCRED_MIRROR_CRON_ENABLED || '').trim() === '1';
  }

  /** Sync incremental a cada 10 minutos */
  @Cron('*/10 * * * *', { name: 'wincred-mirror-incremental' })
  async runIncremental() {
    if (!this.enabled) return;
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

  /** Full sync diario as 3h da manha — garante alinhamento mesmo com DATAALT bugada */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'wincred-mirror-full' })
  async runFull() {
    if (!this.enabled) return;
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
