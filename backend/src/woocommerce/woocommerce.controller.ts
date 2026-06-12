import {
  Controller, Post, Req, Res, HttpCode, HttpStatus, BadRequestException, Get, Query, Logger, UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { OrdersService } from '../orders/orders.service';
import { QueueService } from '../queue/queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { WcPollerService } from './wc-poller.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { OrderAppHooksService } from '../customers-app/order-app-hooks.service';

@Controller()
export class WooCommerceController {
  private readonly logger = new Logger(WooCommerceController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly orders: OrdersService,
    private readonly queue: QueueService,
    private readonly prisma: PrismaService,
    private readonly poller: WcPollerService,
    private readonly appHooks: OrderAppHooksService,
  ) {}

  /** Dispara polling agora mesmo (sem esperar o cron de 60s). */
  @Post('orders/poll-now')
  @UseGuards(JwtAuthGuard)
  async pollNow() {
    await this.poller.poll();
    return { ok: true, at: new Date().toISOString() };
  }

  @Post('webhooks/woocommerce')
  @HttpCode(HttpStatus.OK)
  async handle(@Req() req: Request, @Res() res: Response) {
    const signature = req.header('x-wc-webhook-signature');
    const topic = req.header('x-wc-webhook-topic') ?? 'unknown';
    const rawBody = (req as any).rawBody ?? JSON.stringify(req.body);

    if (!this.verifySignature(rawBody, signature)) {
      await this.prisma.integrationLog.create({
        data: {
          source: 'woocommerce', direction: 'in', event: 'webhook.rejected',
          payload: JSON.stringify({ topic }), error: 'Invalid HMAC signature',
        },
      });
      throw new BadRequestException('Invalid signature');
    }

    res.status(200).json({ received: true });

    try {
      await this.prisma.integrationLog.create({
        data: { source: 'woocommerce', direction: 'in', event: topic, payload: JSON.stringify(req.body) },
      });

      if (topic === 'order.created' || topic === 'order.updated') {
        const saved = await this.orders.upsertFromWooCommerce(req.body);
        if (saved.shouldRoute) {
          await this.queue.enqueueRoute(saved.orderId);
        }
        // Hook do app: cashback + push se for pedido vindo do app.lurds.com.br
        await this.appHooks.handleWcOrder(req.body);
      }
    } catch (e: any) {
      this.logger.error(`Erro processando webhook: ${e.message}`);
      await this.prisma.integrationLog.create({
        data: {
          source: 'woocommerce', direction: 'in', event: `${topic}.error`,
          payload: JSON.stringify(req.body), error: e.message,
        },
      });
    }
  }

  private verifySignature(raw: string, signature?: string): boolean {
    if (!signature) return false;
    const secret = this.config.get<string>('WC_WEBHOOK_SECRET') ?? '';
    if (!secret) return false;
    const expected = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('base64');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }
}
