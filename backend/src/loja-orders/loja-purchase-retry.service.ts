import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LojaOrdersService } from './loja-orders.service';

/**
 * REENVIO DO `purchase` QUE O SITE NÃO CONFIRMOU (14/09/2026).
 *
 * O `purchase` do e-commerce nasce no servidor: pagamento confirmado →
 * `notificarEcommerce` → `POST /api/webhooks/payment` do site → Meta CAPI +
 * GA4 Measurement Protocol. Até aqui esse aviso era fire-and-forget SEM
 * retry: timeout de 8s, Vercel fria, deploy no meio — e a venda simplesmente
 * não existia em plataforma nenhuma, sem alarme.
 *
 * Este cron fecha o buraco pelo lado do banco:
 *   • `Order.purchaseNotificadoEm` NULL com `paidAt` preenchido = pendência;
 *   • espera 2 min depois do pagamento (o primeiro envio, síncrono no webhook,
 *     costuma bastar) e desiste depois de 3 dias ou 5 tentativas;
 *   • reenvia EXATAMENTE o mesmo payload (mesmo `transaction_id`), então o
 *     GA4 deduplica por `transaction_id`, a Meta por `event_id` e o Ads por
 *     `transactionId` se o primeiro aviso tiver chegado e a resposta é que se
 *     perdeu.
 *
 * Teto de 20 pedidos por ciclo: é reparo, não fila.
 */
@Injectable()
export class LojaPurchaseRetryService {
  private readonly logger = new Logger(LojaPurchaseRetryService.name);
  private rodando = false;
  private readonly MAX_TENTATIVAS = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lojaOrders: LojaOrdersService,
  ) {}

  @Cron('*/10 * * * *')
  async reenviarPendentes(): Promise<void> {
    if (this.rodando) return;
    if (!process.env.ECOMMERCE_URL || !process.env.PAYMENT_WEBHOOK_SECRET) return;
    this.rodando = true;
    try {
      const agora = Date.now();
      const pendentes: Array<{ id: string; wcOrderNumber: string | null }> = await (this.prisma as any).order.findMany({
        where: {
          source: 'ecommerce',
          paidAt: {
            not: null,
            lte: new Date(agora - 2 * 60 * 1000),
            gte: new Date(agora - 3 * 24 * 60 * 60 * 1000),
          },
          status: { notIn: ['cancelled', 'failed'] },
          purchaseNotificadoEm: null,
          purchaseNotificadoTentativas: { lt: this.MAX_TENTATIVAS },
        },
        select: { id: true, wcOrderNumber: true },
        orderBy: { paidAt: 'asc' },
        take: 20,
      });
      if (!pendentes.length) return;

      let ok = 0;
      for (const p of pendentes) {
        if (await this.lojaOrders.reenviarPurchase(p.id)) ok++;
      }
      this.logger.log(`[loja] purchase reenviado: ${ok}/${pendentes.length} pedido(s) confirmados pelo site`);
    } catch (e: any) {
      this.logger.warn(`[loja] retry de purchase falhou: ${e?.message || e}`);
    } finally {
      this.rodando = false;
    }
  }
}
