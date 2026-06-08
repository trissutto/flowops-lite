import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import * as webpush from 'web-push';

/**
 * CustomerPushService — Web Push pro app cliente final (app.lurds.com.br).
 *
 * Reusa as mesmas chaves VAPID do PushService (operador), mas grava em
 * tabela separada `CustomerAppPushSubscription` pra targetar só clientes.
 *
 * Casos de uso:
 *   - Promo segmentada: "Inverno 30% off em vestidos"
 *   - Aviso live: "🔴 Lurds em LIVE agora!"
 *   - Cashback vencendo: "💸 Seus R$ 47,50 expiram em 7 dias"
 *   - Pedido atualizado: "📦 Seu pedido #4521 foi postado"
 */
@Injectable()
export class CustomerPushService implements OnModuleInit {
  private readonly logger = new Logger(CustomerPushService.name);
  private configured = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  onModuleInit() {
    const pub = this.config.get<string>('VAPID_PUBLIC_KEY');
    const priv = this.config.get<string>('VAPID_PRIVATE_KEY');
    const subj = this.config.get<string>('VAPID_SUBJECT') || 'mailto:contato@lurds.com.br';

    if (!pub || !priv) {
      this.logger.warn('[customer-push] VAPID não configurado — push de cliente desativado');
      return;
    }
    try {
      webpush.setVapidDetails(subj, pub, priv);
      this.configured = true;
      this.logger.log('[customer-push] VAPID OK');
    } catch (e: any) {
      this.logger.error(`[customer-push] falha VAPID: ${e?.message || e}`);
    }
  }

  /** Chave pública pro app cliente subscrever */
  getPublicKey(): string | null {
    return this.config.get<string>('VAPID_PUBLIC_KEY') || null;
  }

  /**
   * Salva subscription do cliente. Idempotente.
   * Quando cliente troca de device, vem endpoint diferente — cria linha.
   */
  async saveSubscription(
    accountId: string,
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    userAgent?: string,
  ) {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      throw new Error('Subscription inválida');
    }

    const existing = await this.prisma.customerAppPushSubscription.findUnique({
      where: { endpoint: sub.endpoint },
    });

    if (existing) {
      return this.prisma.customerAppPushSubscription.update({
        where: { endpoint: sub.endpoint },
        data: {
          accountId,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
          userAgent,
          active: true,
          lastUsed: new Date(),
        },
      });
    }

    return this.prisma.customerAppPushSubscription.create({
      data: {
        accountId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent,
        active: true,
      },
    });
  }

  /** Desativa subscription (cliente desligou push) */
  async unsubscribe(accountId: string, endpoint: string) {
    await this.prisma.customerAppPushSubscription.updateMany({
      where: { accountId, endpoint },
      data: { active: false },
    });
  }

  /**
   * Envia push pra UMA cliente (todos devices ativos dela).
   * Se cliente tem fallback WhatsApp ativo, manda também por WhatsApp.
   */
  async sendToAccount(accountId: string, payload: PushPayload) {
    const subs = this.configured
      ? await this.prisma.customerAppPushSubscription.findMany({
          where: { accountId, active: true },
        })
      : [];

    const account = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      select: { whatsappOptIn: true, phone: true, name: true },
    });

    const [pushResult, waResult] = await Promise.all([
      subs.length > 0 ? this.sendBatch(subs, payload) : Promise.resolve({ sent: 0, failed: 0, deactivated: 0 }),
      account?.whatsappOptIn && account?.phone
        ? this.sendWhatsappFallback(account.phone, account.name, payload)
        : Promise.resolve(false),
    ]);

    return { ...pushResult, whatsappSent: waResult };
  }

  /**
   * Envia push pra TODOS os clientes (broadcast).
   * Usar com CUIDADO — boa pra avisar live começou.
   */
  async sendToAll(payload: PushPayload) {
    // 1) Push pra quem tem device ativo
    const subs = this.configured
      ? await this.prisma.customerAppPushSubscription.findMany({
          where: { active: true, account: { pushOptIn: true } },
        })
      : [];

    // 2) WhatsApp pra quem optou pelo fallback
    const waAccounts = await this.prisma.customerAccount.findMany({
      where: { whatsappOptIn: true, phone: { not: null } },
      select: { id: true, name: true, phone: true },
    });

    const pushResult = subs.length > 0
      ? await this.sendBatch(subs, payload)
      : { sent: 0, failed: 0, deactivated: 0 };

    let waSent = 0;
    for (const acc of waAccounts) {
      if (acc.phone && await this.sendWhatsappFallback(acc.phone, acc.name, payload)) {
        waSent++;
      }
    }

    return { ...pushResult, whatsappSent: waSent };
  }

  /**
   * Envia push segmentado por filtros do account.
   * Ex: clientes que compraram em loja X, vip tier gold, etc.
   */
  async sendSegmented(
    filter: {
      vipTiers?: string[];
      minLtvCents?: number;
      hasCashback?: boolean;
      cpfs?: string[];
    },
    payload: PushPayload,
  ) {
    if (!this.configured) return { sent: 0, failed: 0, skipped: 'not configured' };

    const where: any = { active: true, account: { pushOptIn: true } };
    if (filter.cpfs?.length) {
      where.account = { ...where.account, cpf: { in: filter.cpfs } };
    }
    if (filter.hasCashback) {
      where.account = { ...where.account, cashbackBalanceCents: { gt: 0 } };
    }

    const subs = await this.prisma.customerAppPushSubscription.findMany({ where });
    return this.sendBatch(subs, payload);
  }

  /**
   * Fallback WhatsApp — usado pra clientes que não conseguem push (iOS antigo,
   * não instalaram PWA, etc). Envia mensagem texto via Baileys.
   * Retorna true se enviou OK.
   */
  private async sendWhatsappFallback(
    phone: string,
    name: string | null,
    payload: PushPayload,
  ): Promise<boolean> {
    try {
      const greeting = name ? `Oi, ${name.split(' ')[0]}!` : 'Oi!';
      const baseUrl = this.config.get<string>('APP_PUBLIC_URL') || 'https://app.lurds.com.br';
      const linkSuffix = payload.url
        ? `\n\nVer no app: ${baseUrl}${payload.url.startsWith('/') ? payload.url : '/' + payload.url}`
        : '';

      const text =
        `*${payload.title}*\n\n` +
        `${greeting}\n` +
        (payload.body ? `${payload.body}\n` : '') +
        linkSuffix +
        `\n\n_Lurd's Plus Size_`;

      const result = await this.whatsapp.sendText(phone.replace(/\D/g, ''), text);
      return result.ok;
    } catch (err: any) {
      this.logger.warn(`whatsapp fallback falhou phone=${phone}: ${err?.message || err}`);
      return false;
    }
  }

  /* ─────────────────────── Helpers internos ─────────────────────── */

  private async sendBatch(
    subs: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>,
    payload: PushPayload,
  ): Promise<{ sent: number; failed: number; deactivated: number }> {
    let sent = 0;
    let failed = 0;
    let deactivated = 0;

    const body = JSON.stringify(payload);

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body,
        );
        sent++;
        // Atualiza lastUsed
        await this.prisma.customerAppPushSubscription
          .update({ where: { id: sub.id }, data: { lastUsed: new Date() } })
          .catch(() => null);
      } catch (e: any) {
        failed++;
        // 404/410 = subscription expirou (cliente desinstalou ou bloqueou)
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await this.prisma.customerAppPushSubscription
            .update({ where: { id: sub.id }, data: { active: false } })
            .catch(() => null);
          deactivated++;
        } else {
          this.logger.warn(`push falhou sub=${sub.id}: ${e?.message || e}`);
        }
      }
    }

    this.logger.log(
      `customer push batch: enviadas=${sent} falharam=${failed} desativadas=${deactivated}`,
    );
    return { sent, failed, deactivated };
  }
}

export type PushPayload = {
  title: string;
  body?: string;
  icon?: string;       // URL ícone (default: /icons/icon-192.png)
  image?: string;      // imagem rica (banner)
  url?: string;        // URL pra abrir ao clicar
  tag?: string;        // agrupa notifs (substitui ao invés de empilhar)
  badge?: string;
};
