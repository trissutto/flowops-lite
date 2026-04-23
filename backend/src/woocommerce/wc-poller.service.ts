import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeGateway } from '../websocket/realtime.gateway';
import { PilotService } from '../pilot/pilot.service';

/**
 * Polling automático do WooCommerce.
 * Roda a cada 60 segundos, pega pedidos criados/modificados desde a última
 * verificação e importa no FlowOps. Substitui webhook quando não há URL
 * pública disponível (ngrok).
 */
@Injectable()
export class WcPollerService {
  private readonly logger = new Logger(WcPollerService.name);
  private lastCheck: Date | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly queue: QueueService,
    private readonly gateway: RealtimeGateway,
    @Inject(forwardRef(() => PilotService))
    private readonly pilot: PilotService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async poll() {
    if (this.running) {
      this.logger.debug('Polling anterior ainda rodando, pulando ciclo.');
      return;
    }
    this.running = true;

    try {
      const url = this.config.get<string>('WC_URL');
      const key = this.config.get<string>('WC_CONSUMER_KEY');
      const secret = this.config.get<string>('WC_CONSUMER_SECRET');
      if (!url || !key || !secret) {
        this.logger.warn('WC credentials não configuradas, pulando polling.');
        return;
      }

      // primeira vez: última hora. depois, últimos X minutos ANTES da última checagem
      // (com 2min de overlap pra garantir que nada se perde)
      const after = this.lastCheck
        ? new Date(this.lastCheck.getTime() - 2 * 60_000)
        : new Date(Date.now() - 60 * 60_000);

      const res = await axios.get(`${url}/wp-json/wc/v3/orders`, {
        auth: { username: key, password: secret },
        params: {
          modified_after: after.toISOString(),
          per_page: 50,
          orderby: 'modified',
          order: 'desc',
        },
        timeout: 15_000,
      });

      const list: any[] = res.data ?? [];
      if (list.length === 0) {
        this.lastCheck = new Date();
        return;
      }

      let newCount = 0, updatedCount = 0;
      for (const wc of list) {
        try {
          const saved = await this.orders.upsertFromWooCommerce(wc);
          if (saved.shouldRoute) newCount++;
          else updatedCount++;

          // EMITE order:new apenas quando o pedido está em PROCESSING (pago).
          // Cobre DOIS cenários:
          //   a) pedido NOVO no banco já em processing (pagamento aprovado na entrada)
          //   b) pedido existente que TRANSICIONOU pra processing (pagamento acabou de aprovar)
          // shouldRoute cobre os dois.
          if (saved.shouldRoute) {
            const full = await this.prisma.order.findUnique({
              where: { id: saved.orderId },
              select: { id: true, wcOrderNumber: true, customerName: true, totalAmount: true, status: true, createdAt: true },
            });
            if (full) {
              this.gateway.emitOrderNew(full);
              this.logger.log(
                `[WS] order:new emitido — #${full.wcOrderNumber} (${full.customerName}) status=${full.status} wasCreated=${saved.wasCreated}`,
              );

              // PILOTO AUTOMÁTICO server-side (fire-and-forget).
              // Não bloqueia o loop do poller — erros ficam no integration_logs.
              const wcOrderId = Number(wc.id);
              const orderCreatedAt = wc.date_created_gmt || wc.date_created || undefined;
              this.pilot
                .handleNewOrder(wcOrderId, orderCreatedAt)
                .catch((err) => this.logger.error(`[Pilot] handleNewOrder #${wcOrderId} falhou: ${err?.message || err}`));
            }
          }
        } catch (e: any) {
          this.logger.error(`Falha importando WC #${wc.id}: ${e.message}`);
        }
      }

      this.lastCheck = new Date();
      if (newCount + updatedCount > 0) {
        this.logger.log(`Polling: ${newCount} novo(s) em processing, ${updatedCount} atualizado(s).`);
      }
    } catch (e: any) {
      this.logger.error(`Polling falhou: ${e.message}`);
    } finally {
      this.running = false;
    }
  }
}
