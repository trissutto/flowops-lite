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
  private isRunningEstoque = false;

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

  /**
   * Estoque FULL de hora em hora (minuto 23, pra não colidir com o
   * incremental de 10min). O incremental só re-sincroniza estoque de
   * produtos com DATAALT alterada — venda no Giga muda o estoque SEM tocar
   * DATAALT, então sem este full o espelho de estoque defasava o dia todo.
   * Custo: 60-180s em background, batches de 200 com pausas.
   */
  @Cron('23 * * * *', { name: 'wincred-mirror-estoque' })
  async runEstoqueHourly() {
    if (!this.enabled) return;
    if (this.isRunningEstoque || this.isRunningFull) {
      this.logger.log('[cron] estoque hourly skipped — outro sync em andamento');
      return;
    }
    this.isRunningEstoque = true;
    try {
      const r = await this.mirror.syncEstoque();
      this.logger.log(`[cron] estoque hourly OK — ${r.processed} linhas (${r.durationMs}ms)`);
    } catch (e) {
      this.logger.error(`[cron] estoque hourly FAIL: ${(e as Error).message}`);
    } finally {
      this.isRunningEstoque = false;
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
