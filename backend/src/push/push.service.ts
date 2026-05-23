import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as webpush from 'web-push';

/**
 * PushService — envia Web Push Notifications.
 *
 * Web Push API funciona assim:
 *  1. Browser do user (vendedora) cria uma "subscription" no boot do PWA
 *  2. Subscription é mandada pro backend e gravada (tabela push_subscriptions)
 *  3. Backend usa chaves VAPID + a subscription pra enviar push
 *  4. O servidor de push (Google FCM, Mozilla, Apple) entrega no celular
 *  5. Service Worker do PWA recebe, mostra notificação (mesmo app fechado)
 *
 * VAPID = "Voluntary Application Server Identification" — autentica o servidor.
 *
 * Variáveis ambiente (Railway):
 *  - VAPID_PUBLIC_KEY   — chave pública (também enviada pro frontend)
 *  - VAPID_PRIVATE_KEY  — chave privada (SECRETA, só backend)
 *  - VAPID_SUBJECT      — mailto:contato@empresa.com (exigido pelo padrão)
 *
 * Gerar chaves novas:  npx web-push generate-vapid-keys
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private configured = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    const pub = this.config.get<string>('VAPID_PUBLIC_KEY');
    const priv = this.config.get<string>('VAPID_PRIVATE_KEY');
    const subj = this.config.get<string>('VAPID_SUBJECT') || 'mailto:admin@lurds.com.br';

    if (!pub || !priv) {
      this.logger.warn(
        '[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY não configuradas — push desativado',
      );
      return;
    }
    try {
      webpush.setVapidDetails(subj, pub, priv);
      this.configured = true;
      this.logger.log(`[push] VAPID configurado (subject=${subj})`);
    } catch (e: any) {
      this.logger.error(`[push] falha ao configurar VAPID: ${e?.message || e}`);
    }
  }

  /** Pra frontend pedir e poder se inscrever */
  getPublicKey(): string | null {
    return this.config.get<string>('VAPID_PUBLIC_KEY') || null;
  }

  /**
   * Salva uma subscription no banco. Idempotente (endpoint é UNIQUE).
   * Se o user trocar device, vai vir endpoint diferente — cria nova linha.
   * Se for o mesmo device (recarregou app), endpoint igual → update.
   */
  async saveSubscription(
    userId: string,
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    userAgent?: string,
  ) {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      throw new Error('Subscription inválida');
    }
    const existing = await (this.prisma as any).pushSubscription.findUnique({
      where: { endpoint: sub.endpoint },
    });
    if (existing) {
      // Reativa + atualiza last_used (mesmo device do mesmo user)
      return (this.prisma as any).pushSubscription.update({
        where: { endpoint: sub.endpoint },
        data: {
          userId,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
          userAgent: userAgent || existing.userAgent,
          active: true,
          lastUsed: new Date(),
        },
      });
    }
    return (this.prisma as any).pushSubscription.create({
      data: {
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent: userAgent || null,
        active: true,
      },
    });
  }

  /** Remove subscription (browser desinstalou PWA / user logout) */
  async removeSubscription(endpoint: string) {
    try {
      await (this.prisma as any).pushSubscription.deleteMany({
        where: { endpoint },
      });
    } catch (e: any) {
      this.logger.warn(`removeSubscription falhou: ${e?.message || e}`);
    }
  }

  /**
   * Envia push pra UM user (todas subscriptions ativas dele — celular+PC+tablet).
   */
  async sendToUser(userId: string, payload: PushPayload) {
    if (!this.configured) {
      this.logger.warn('[push] sendToUser sem VAPID — skip');
      return { sent: 0, failed: 0 };
    }
    const subs = await (this.prisma as any).pushSubscription.findMany({
      where: { userId, active: true },
    });
    return this.sendToSubscriptions(subs, payload);
  }

  /**
   * Envia push pra TODOS users de uma loja (storeId).
   * Caso de uso: pedido novo do site chegou na loja X → todas vendedoras da
   * loja X recebem push no celular delas.
   */
  async sendToStore(storeId: string, payload: PushPayload) {
    if (!this.configured) {
      this.logger.warn('[push] sendToStore sem VAPID — skip');
      return { sent: 0, failed: 0 };
    }
    const subs = await (this.prisma as any).pushSubscription.findMany({
      where: { active: true, user: { storeId } },
    });
    return this.sendToSubscriptions(subs, payload);
  }

  /** Envia push pra TODOS admins (role admin/operator) */
  async sendToAdmins(payload: PushPayload) {
    if (!this.configured) return { sent: 0, failed: 0 };
    const subs = await (this.prisma as any).pushSubscription.findMany({
      where: { active: true, user: { role: { in: ['admin', 'operator'] } } },
    });
    return this.sendToSubscriptions(subs, payload);
  }

  /** Envia push pra TODOS subscribers ativos (uso raro — broadcast) */
  async sendToAll(payload: PushPayload) {
    if (!this.configured) return { sent: 0, failed: 0 };
    const subs = await (this.prisma as any).pushSubscription.findMany({
      where: { active: true },
    });
    return this.sendToSubscriptions(subs, payload);
  }

  /**
   * Envia push pra lista de subscriptions.
   * Trata erros 404/410 (subscription expirou/desinscreveu) marcando inactive.
   */
  private async sendToSubscriptions(subs: any[], payload: PushPayload) {
    let sent = 0;
    let failed = 0;
    const expired: string[] = [];
    const data = JSON.stringify(payload);

    await Promise.all(
      subs.map(async (s: any) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: s.endpoint,
              keys: { p256dh: s.p256dh, auth: s.auth },
            },
            data,
            { TTL: 60 * 60 * 24 }, // 24h pra entregar
          );
          sent++;
          // Atualiza last_used assincronamente (não bloqueia)
          (this.prisma as any).pushSubscription
            .update({ where: { id: s.id }, data: { lastUsed: new Date() } })
            .catch(() => {});
        } catch (e: any) {
          failed++;
          const status = e?.statusCode || e?.status;
          if (status === 404 || status === 410) {
            // Subscription morta — marca inactive (não tenta de novo)
            expired.push(s.endpoint);
          } else {
            this.logger.warn(
              `[push] send falhou (status=${status}): ${e?.message || e}`,
            );
          }
        }
      }),
    );

    if (expired.length > 0) {
      await (this.prisma as any).pushSubscription.updateMany({
        where: { endpoint: { in: expired } },
        data: { active: false },
      });
      this.logger.log(`[push] marcou ${expired.length} subscriptions como inactive`);
    }

    return { sent, failed, expired: expired.length };
  }
}

/**
 * Payload do push (chega no service worker do frontend).
 * O SW vai usar isso pra construir a Notification visível.
 */
export interface PushPayload {
  title: string;
  body: string;
  /** ícone (URL relativa ou absoluta) */
  icon?: string;
  /** tag pra agrupar/substituir notificações do mesmo tipo */
  tag?: string;
  /** dados extras que o SW usa (ex: url pra abrir) */
  data?: {
    url?: string;
    [k: string]: any;
  };
  /** true = exige clique do user pra fechar (some sozinho se false) */
  requireInteraction?: boolean;
}
