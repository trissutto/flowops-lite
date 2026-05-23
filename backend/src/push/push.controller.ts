import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PushService } from './push.service';

/**
 * /push — endpoints pra registrar/desregistrar subscriptions e testar push.
 *
 * Fluxo:
 *  1. Frontend chama GET /push/vapid-public-key (sem auth — só leitura)
 *  2. Browser cria subscription com essa chave
 *  3. Frontend chama POST /push/subscribe (com JWT) pra gravar no banco
 *  4. Backend dispara pushes via PushService.sendToUser/Store/Admins
 *  5. Quando user faz logout / desinstala: DELETE /push/unsubscribe
 */
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  /**
   * Público — frontend precisa dessa chave pra criar subscription.
   * Pode ficar em CDN/cache (chave não é segredo).
   */
  @Get('vapid-public-key')
  getPublicKey() {
    const key = this.push.getPublicKey();
    return { publicKey: key };
  }

  /**
   * Registra subscription do device atual do user.
   * Body: { subscription: { endpoint, keys: { p256dh, auth } } }
   */
  @UseGuards(JwtAuthGuard)
  @Post('subscribe')
  async subscribe(
    @Req() req: any,
    @Body()
    body: {
      subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
    },
  ) {
    const userId = req?.user?.id || req?.user?.sub;
    if (!userId) return { ok: false, error: 'sem userId' };
    const ua = req?.headers?.['user-agent'] || null;
    await this.push.saveSubscription(userId, body.subscription, ua);
    return { ok: true };
  }

  /**
   * Remove subscription (chamado quando user faz logout / desinstala PWA).
   * Body: { endpoint: string }
   */
  @UseGuards(JwtAuthGuard)
  @Delete('unsubscribe')
  async unsubscribe(@Body() body: { endpoint: string }) {
    if (!body?.endpoint) return { ok: false, error: 'endpoint obrigatório' };
    await this.push.removeSubscription(body.endpoint);
    return { ok: true };
  }

  /**
   * TESTE — envia push fake pro próprio user logado.
   * Útil pra vendedora confirmar que está recebendo push corretamente.
   */
  @UseGuards(JwtAuthGuard)
  @Post('test')
  async test(@Req() req: any, @Query('msg') msg?: string) {
    const userId = req?.user?.id || req?.user?.sub;
    if (!userId) return { ok: false, error: 'sem userId' };
    const result = await this.push.sendToUser(userId, {
      title: '🔔 Teste de notificação',
      body: msg || 'Se você está vendo isso, push notification tá funcionando!',
      tag: 'lurds-test',
      data: { url: '/' },
      requireInteraction: false,
    });
    return { ok: true, ...result };
  }
}
