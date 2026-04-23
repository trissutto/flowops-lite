import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ProductsService } from './products.service';

/**
 * StockSyncCronService — dispara o BULK SYNC de estoque ERP → WooCommerce
 * TODO DIA ÀS 3h DA MANHÃ (horário local do servidor).
 *
 * Por que 3h:
 *   - Loja fechada, zero concorrência com venda presencial (não bloqueia ERP).
 *   - Sem tráfego no site (cliente final não nota lentidão).
 *   - Antes da abertura (9h) o catálogo já está 100% alinhado com o Giga.
 *
 * Por que cron interno (e não scheduled_task externo):
 *   - Roda DENTRO do backend, sem depender de URL pública / internet externa.
 *   - Só precisa do servidor ligado — que já fica ligado 24/7 pra atender
 *     socket das lojas. Se cair, não dispara (correto — sem estado incerto).
 *
 * Comportamento:
 *   - Chama products.startBulkSync() que é fire-and-forget (mesmo método
 *     do botão "Sincronizar tudo" na tela /produtos).
 *   - Se já está rodando (ex: operador disparou manual às 2:58), pula sem
 *     explodir — BadRequest esperado, tratamos como "ok, já está rolando".
 *   - Kill-switch: env STOCK_SYNC_CRON_DISABLED=1 desliga o cron (pra QA /
 *     ambientes de dev onde não se quer o sync automático).
 *
 * Expressão cron: '0 3 * * *' — min=0, hora=3, dia*, mês*, diaSemana*
 *   → todo dia às 03:00:00 local.
 */
@Injectable()
export class StockSyncCronService {
  private readonly logger = new Logger(StockSyncCronService.name);

  constructor(private readonly products: ProductsService) {}

  @Cron('0 3 * * *', {
    name: 'stock-sync-daily-3am',
    // timeZone: explicitamente NÃO setamos — usa o TZ do host (Brasil).
    // Se deployar em Railway com TZ=UTC, ajustar pra 'America/Sao_Paulo'.
  })
  async run() {
    if (process.env.STOCK_SYNC_CRON_DISABLED === '1') {
      this.logger.log('Cron sync 3h DESLIGADO via STOCK_SYNC_CRON_DISABLED=1 — pulando.');
      return;
    }

    this.logger.log('⏰ Cron 3h: disparando bulk sync de estoque ERP → WC...');
    try {
      const state = this.products.startBulkSync();
      this.logger.log(
        `Bulk sync iniciado via cron. startedAt=${state.startedAt}. ` +
          `Acompanhe em /produtos (tela de sync).`,
      );
    } catch (e: any) {
      // startBulkSync lança BadRequest se já estiver rodando — tratamos como info.
      const msg = e?.message ?? String(e);
      if (msg.includes('já está em execução')) {
        this.logger.warn(`Cron 3h: sync já estava rodando (operador disparou manual?). Pulando.`);
      } else {
        this.logger.error(`Cron 3h falhou ao disparar bulk sync: ${msg}`);
      }
    }
  }
}
