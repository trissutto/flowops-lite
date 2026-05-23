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
import { PrismaService } from '../prisma/prisma.service';

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
  constructor(
    private readonly push: PushService,
    private readonly prisma: PrismaService,
  ) {}

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

  /**
   * BROADCAST — admin manda push manual pra lojas.
   * Casos típicos: "PROMOÇÃO ATIVA HOJE", "REUNIÃO 18H", aviso operacional.
   *
   * Body:
   *   title         — texto da notificação (até 50 chars)
   *   body          — corpo da mensagem
   *   audience      — 'all' (todas lojas + admins) | 'stores' (só lojas) |
   *                   'admins' (só retaguarda) | 'store:CODE' (loja específica)
   *   url           — opcional, abre essa URL ao clicar
   *   requireInteraction — opcional, mantém notificação até user fechar
   */
  @UseGuards(JwtAuthGuard)
  @Post('broadcast')
  async broadcast(
    @Req() req: any,
    @Body()
    body: {
      title: string;
      body: string;
      audience?: 'all' | 'stores' | 'admins' | string; // string = 'store:CODE'
      url?: string;
      requireInteraction?: boolean;
    },
  ) {
    // Só admin / operator
    const role = req?.user?.role;
    if (!['admin', 'operator'].includes(role)) {
      return { ok: false, error: 'Apenas admin pode enviar broadcast' };
    }
    if (!body?.title?.trim() || !body?.body?.trim()) {
      return { ok: false, error: 'Título e mensagem obrigatórios' };
    }

    const payload = {
      title: body.title.trim(),
      body: body.body.trim(),
      tag: `lurds-broadcast-${Date.now()}`,
      icon: '/icon-192.png',
      requireInteraction: !!body.requireInteraction,
      data: { url: body.url || '/' },
    };

    let result;
    const audience = body.audience || 'all';

    if (audience === 'admins') {
      result = await this.push.sendToAdmins(payload);
    } else if (audience === 'stores') {
      // Todas lojas (cada User com storeId)
      const users = await this.prisma.user.findMany({
        where: { active: true, storeId: { not: null } },
        select: { id: true },
      });
      let sent = 0, failed = 0, expired = 0;
      for (const u of users) {
        const r = await this.push.sendToUser(u.id, payload);
        sent += r.sent;
        failed += r.failed;
        expired += (r as any).expired || 0;
      }
      result = { sent, failed, expired };
    } else if (audience.startsWith('store:')) {
      // Loja específica: 'store:LJ05' → busca id da loja
      const code = audience.slice('store:'.length);
      const store = await this.prisma.store.findUnique({
        where: { code },
        select: { id: true },
      });
      if (!store) return { ok: false, error: `Loja ${code} não encontrada` };
      result = await this.push.sendToStore(store.id, payload);
    } else {
      // 'all' — admins + todas lojas
      result = await this.push.sendToAll(payload);
    }

    return { ok: true, audience, ...result };
  }
}
