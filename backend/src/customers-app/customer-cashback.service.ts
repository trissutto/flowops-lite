import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerPushService } from './customer-push.service';

/**
 * Cashback do app cliente.
 *
 * REGRAS (jun/2026):
 *   - 10% de cashback sobre compras (configurável em env CASHBACK_RATE_PCT)
 *   - Validade 30 dias (CASHBACK_TTL_DAYS)
 *   - Bônus de instalação R$ 20 quando: 1ª compra confirmada DEPOIS de install PWA
 *   - Alerta push em D-7 da expiração
 *   - Expira automaticamente no job diário
 */
@Injectable()
export class CustomerCashbackService {
  private readonly logger = new Logger(CustomerCashbackService.name);

  readonly RATE_PCT: number;
  readonly TTL_DAYS: number;
  readonly WELCOME_CENTS: number;
  readonly EXPIRE_WARNING_DAYS: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
    private readonly push: CustomerPushService,
  ) {
    this.RATE_PCT = Number(this.cfg.get('CASHBACK_RATE_PCT') ?? 10);
    this.TTL_DAYS = Number(this.cfg.get('CASHBACK_TTL_DAYS') ?? 30);
    this.WELCOME_CENTS = Number(this.cfg.get('APP_WELCOME_BONUS_CENTS') ?? 2000);
    this.EXPIRE_WARNING_DAYS = Number(this.cfg.get('CASHBACK_WARNING_DAYS') ?? 7);
  }

  /* ──────────────────────── EARN ──────────────────────── */

  /**
   * Credita 10% de uma compra como cashback.
   * Chamado quando Order vira 'shipped'/'delivered'/'completed'.
   */
  async earnFromOrder(accountId: string, orderId: string, orderTotalCents: number) {
    if (orderTotalCents <= 0) return null;

    const amountCents = Math.round(orderTotalCents * (this.RATE_PCT / 100));
    if (amountCents <= 0) return null;

    // Idempotência: se já creditou pra essa Order, ignora
    const already = await this.prisma.customerCashbackTx.findFirst({
      where: { accountId, orderId, type: 'earn' },
    });
    if (already) {
      return { skipped: true, txId: already.id };
    }

    return this.creditAndUpdate(accountId, {
      type: 'earn',
      amountCents,
      orderId,
      description: `Cashback ${this.RATE_PCT}% da compra #${orderId.slice(0, 8)}`,
    });
  }

  /**
   * Credita bônus de boas-vindas R$ 20.
   * Só cai 1 vez por account (welcomeBonusAt fica setado).
   */
  async earnWelcomeBonus(accountId: string) {
    const account = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      select: { welcomeBonusAt: true, pwaInstalledAt: true },
    });
    if (!account) throw new BadRequestException('Conta não encontrada');

    if (account.welcomeBonusAt) {
      return { skipped: true, reason: 'already received' };
    }
    if (!account.pwaInstalledAt) {
      return { skipped: true, reason: 'pwa not installed' };
    }

    const result = await this.creditAndUpdate(accountId, {
      type: 'welcome',
      amountCents: this.WELCOME_CENTS,
      description: '🎁 Bônus de boas-vindas R$ 20',
    });

    await this.prisma.customerAccount.update({
      where: { id: accountId },
      data: { welcomeBonusAt: new Date() },
    });

    // Push de comemoração
    this.push
      .sendToAccount(accountId, {
        title: '🎁 R$ 20 caiu no seu cashback!',
        body: 'Bem-vinda à Lurd\'s! Use no seu próximo pedido.',
        url: '/cashback',
        tag: 'welcome-bonus',
      })
      .catch(() => null);

    return result;
  }

  /* ──────────────────────── REDEEM ──────────────────────── */

  async redeem(accountId: string, amountCents: number, refDescription?: string) {
    if (amountCents <= 0) throw new BadRequestException('Valor inválido');

    const account = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      select: { cashbackBalanceCents: true },
    });
    if (!account) throw new BadRequestException('Conta não encontrada');

    if (account.cashbackBalanceCents < amountCents) {
      throw new BadRequestException(
        `Saldo insuficiente. Disponível: R$ ${(account.cashbackBalanceCents / 100).toFixed(2)}`,
      );
    }

    return this.creditAndUpdate(accountId, {
      type: 'redeem',
      amountCents: -amountCents, // negativo
      description: refDescription || 'Cashback utilizado em compra',
    });
  }

  /* ──────────────────────── STATEMENT ──────────────────────── */

  async getStatement(accountId: string, opts?: { limit?: number }) {
    const limit = Math.min(opts?.limit || 50, 100);

    const account = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      select: {
        cashbackBalanceCents: true,
        cashbackEarnedCents: true,
        cashbackSpentCents: true,
      },
    });
    if (!account) throw new BadRequestException('Conta não encontrada');

    const txs = await this.prisma.customerCashbackTx.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // Próxima expiração (crédito mais próximo de expirar)
    const nextExpiring = await this.prisma.customerCashbackTx.findFirst({
      where: {
        accountId,
        type: { in: ['earn', 'welcome'] },
        expiredAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { expiresAt: 'asc' },
      select: { amountCents: true, expiresAt: true },
    });

    return {
      balance: account.cashbackBalanceCents / 100,
      earned: Number(account.cashbackEarnedCents) / 100,
      spent: Number(account.cashbackSpentCents) / 100,
      rate: this.RATE_PCT,
      ttlDays: this.TTL_DAYS,
      nextExpiration: nextExpiring && nextExpiring.expiresAt
        ? {
            amount: nextExpiring.amountCents / 100,
            expiresAt: nextExpiring.expiresAt,
            daysLeft: Math.ceil(
              (nextExpiring.expiresAt.getTime() - Date.now()) / 86400000,
            ),
          }
        : null,
      transactions: txs.map((t) => ({
        id: t.id,
        type: t.type,
        amount: t.amountCents / 100,
        balanceAfter: t.balanceAfterCents / 100,
        description: t.description,
        date: t.createdAt,
        expiresAt: t.expiresAt,
      })),
    };
  }

  /* ──────────────────────── HELPER TRANSACIONAL ──────────────────────── */

  private async creditAndUpdate(
    accountId: string,
    data: {
      type: string;
      amountCents: number;
      description?: string;
      orderId?: string;
      pdvSaleId?: string;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.customerAccount.findUnique({
        where: { id: accountId },
        select: {
          cashbackBalanceCents: true,
          cashbackEarnedCents: true,
          cashbackSpentCents: true,
        },
      });
      if (!account) throw new BadRequestException('Conta não encontrada');

      const newBalance = account.cashbackBalanceCents + data.amountCents;
      if (newBalance < 0) {
        throw new BadRequestException('Saldo ficaria negativo');
      }

      const expiresAt =
        data.type === 'earn' || data.type === 'welcome'
          ? new Date(Date.now() + this.TTL_DAYS * 86400 * 1000)
          : null;

      const txRow = await tx.customerCashbackTx.create({
        data: {
          accountId,
          type: data.type,
          amountCents: data.amountCents,
          balanceAfterCents: newBalance,
          description: data.description,
          orderId: data.orderId,
          pdvSaleId: data.pdvSaleId,
          expiresAt,
        },
      });

      const earnedDelta = data.amountCents > 0 ? BigInt(data.amountCents) : 0n;
      const spentDelta = data.amountCents < 0 ? BigInt(-data.amountCents) : 0n;

      await tx.customerAccount.update({
        where: { id: accountId },
        data: {
          cashbackBalanceCents: newBalance,
          cashbackEarnedCents: { increment: earnedDelta },
          cashbackSpentCents: { increment: spentDelta },
        },
      });

      return { txId: txRow.id, newBalance: newBalance / 100 };
    });
  }

  /* ──────────────────────── JOBS (cron diário) ──────────────────────── */

  /**
   * Job diário às 9h — varre cashbacks que expiram em ≤7 dias e ainda não
   * notificou, manda push pra cada cliente afetado.
   */
  @Cron('0 0 9 * * *')
  async warnExpiringSoon() {
    const warnUntil = new Date(Date.now() + this.EXPIRE_WARNING_DAYS * 86400 * 1000);

    const txs = await this.prisma.customerCashbackTx.findMany({
      where: {
        type: { in: ['earn', 'welcome'] },
        expiredAt: null,
        notifiedExpireWarning: false,
        expiresAt: { lte: warnUntil, gt: new Date() },
      },
      include: {
        account: { select: { id: true, name: true, cashbackBalanceCents: true } },
      },
    });

    if (txs.length === 0) return { warned: 0 };

    // Agrega por account (evita 5 pushes pro mesmo cliente)
    const byAccount = new Map<
      string,
      { id: string; name: string | null; total: number; balance: number }
    >();
    for (const t of txs) {
      const acc = t.account;
      const cur = byAccount.get(acc.id) || {
        id: acc.id,
        name: acc.name,
        total: 0,
        balance: acc.cashbackBalanceCents,
      };
      cur.total += t.amountCents;
      byAccount.set(acc.id, cur);
    }

    let warned = 0;
    for (const acc of byAccount.values()) {
      await this.push
        .sendToAccount(acc.id, {
          title: '💸 Seu cashback está expirando',
          body: `R$ ${(acc.total / 100).toFixed(2).replace('.', ',')} expira em até ${this.EXPIRE_WARNING_DAYS} dias. Aproveita!`,
          url: '/cashback',
          tag: 'cashback-warning',
        })
        .catch(() => null);
      warned++;
    }

    // Marca como notificado
    await this.prisma.customerCashbackTx.updateMany({
      where: { id: { in: txs.map((t) => t.id) } },
      data: { notifiedExpireWarning: true },
    });

    this.logger.log(`Cashback expire warnings enviados: ${warned}`);
    return { warned };
  }

  /**
   * Job diário às 3h — expira créditos vencidos. Cria tx 'expire' negativa.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async expireOldCashback() {
    const expired = await this.prisma.customerCashbackTx.findMany({
      where: {
        type: { in: ['earn', 'welcome'] },
        expiredAt: null,
        expiresAt: { lte: new Date() },
      },
      include: {
        account: { select: { id: true, cashbackBalanceCents: true } },
      },
    });

    if (expired.length === 0) return { expired: 0 };

    let totalExpired = 0;
    for (const tx of expired) {
      try {
        await this.prisma.$transaction(async (db) => {
          // Marca o crédito original como expirado
          await db.customerCashbackTx.update({
            where: { id: tx.id },
            data: { expiredAt: new Date() },
          });

          // Diminui saldo (até o limite — se já gastou parcial, expira só o resto)
          const account = await db.customerAccount.findUnique({
            where: { id: tx.accountId },
            select: { cashbackBalanceCents: true },
          });
          if (!account) return;

          const toExpire = Math.min(tx.amountCents, account.cashbackBalanceCents);
          if (toExpire <= 0) return;

          const newBalance = account.cashbackBalanceCents - toExpire;
          await db.customerCashbackTx.create({
            data: {
              accountId: tx.accountId,
              type: 'expire',
              amountCents: -toExpire,
              balanceAfterCents: newBalance,
              description: `Cashback expirado (validade ${this.TTL_DAYS} dias)`,
            },
          });
          await db.customerAccount.update({
            where: { id: tx.accountId },
            data: { cashbackBalanceCents: newBalance },
          });
        });
        totalExpired += tx.amountCents;
      } catch (err: any) {
        this.logger.warn(`Falha ao expirar tx ${tx.id}: ${err?.message}`);
      }
    }

    this.logger.log(
      `Cashback expirado: ${expired.length} tx, total R$ ${(totalExpired / 100).toFixed(2)}`,
    );
    return { expired: expired.length, totalCents: totalExpired };
  }
}
