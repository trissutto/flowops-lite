import { Injectable, Logger } from '@nestjs/common';
import { RoutingService } from '../routing/routing.service';

/**
 * Fila de jobs em memória — versão Lite.
 * Retry simples, sem persistência. Adequado para até ~500 pedidos/dia.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(private readonly routing: RoutingService) {}

  async enqueueRoute(orderId: string) {
    setImmediate(async () => {
      let attempt = 0;
      while (attempt < 3) {
        try {
          await this.routing.routeOrder(orderId);
          return;
        } catch (e: any) {
          attempt++;
          this.logger.warn(`Route attempt ${attempt} failed for ${orderId}: ${e.message}`);
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 2000 * attempt));
          }
        }
      }
      this.logger.error(`Route falhou definitivamente para ${orderId} após 3 tentativas`);
    });
    return { jobId: `mem-${Date.now()}` };
  }

  async enqueueSyncStatus(wcOrderId: number, status: string) {
    this.logger.log(`[stub] sync status WC #${wcOrderId} → ${status}`);
    return { jobId: `mem-${Date.now()}` };
  }

  async enqueueSyncTracking(wcOrderId: number, tracking: { code: string; carrier: string }) {
    this.logger.log(`[stub] sync tracking WC #${wcOrderId} → ${tracking.code}`);
    return { jobId: `mem-${Date.now()}` };
  }
}
