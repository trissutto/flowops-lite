import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerCashbackService } from './customer-cashback.service';
import * as crypto from 'crypto';

/**
 * AppInviteService — gera + valida tokens de QR Code emitidos pelo PDV
 * pra captar clientes pro app.
 *
 * Fluxo:
 *   1. PDV pós-venda → cria token + URL: https://app.lurds.com.br/?invite=TOK
 *   2. QR é exibido pra cliente apontar com celular
 *   3. App captura `invite=TOK`, guarda em localStorage
 *   4. No /cadastro, manda invite no body → backend valida + credita R$ 20
 *
 * Tracking:
 *   - storeCode + sellerName ficam gravados no token → relatório de
 *     conversão por vendedora
 *   - Token expira em 7 dias se não usado
 */
@Injectable()
export class AppInviteService {
  private readonly logger = new Logger(AppInviteService.name);
  private readonly TTL_DAYS = 7;
  private readonly DEFAULT_BONUS_CENTS: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
    private readonly cashback: CustomerCashbackService,
  ) {
    this.DEFAULT_BONUS_CENTS = Number(this.cfg.get('APP_WELCOME_BONUS_CENTS') ?? 2000);
  }

  /**
   * Cria token de convite (chamado pelo PDV).
   * Retorna { token, qrUrl } pra UI mostrar.
   */
  async createInvite(opts: {
    storeCode: string;
    sellerName?: string;
    pdvSaleId?: string;
    customerCpf?: string;
    bonusCents?: number;
  }) {
    const token = generateShortToken();
    const expiresAt = new Date(Date.now() + this.TTL_DAYS * 86400 * 1000);

    await this.prisma.appInviteToken.create({
      data: {
        token,
        storeCode: opts.storeCode,
        sellerName: opts.sellerName,
        pdvSaleId: opts.pdvSaleId,
        customerCpf: opts.customerCpf,
        bonusCents: opts.bonusCents ?? this.DEFAULT_BONUS_CENTS,
        expiresAt,
      },
    });

    const baseUrl =
      this.cfg.get<string>('APP_PUBLIC_URL') || 'https://app.lurds.com.br';

    return {
      token,
      qrUrl: `${baseUrl}/?invite=${token}`,
      bonus: (opts.bonusCents ?? this.DEFAULT_BONUS_CENTS) / 100,
      expiresAt,
    };
  }

  /**
   * Lookup do token (sem usar). UI do app pode mostrar:
   * "🎁 Você ganhou R$ 20 da loja Itanhaém"
   */
  async lookupToken(token: string) {
    if (!token) return { valid: false };

    const inv = await this.prisma.appInviteToken.findUnique({
      where: { token },
    });

    if (!inv) return { valid: false, reason: 'token inválido' };
    if (inv.usedByAccountId) return { valid: false, reason: 'token já usado' };
    if (inv.expiresAt < new Date()) return { valid: false, reason: 'token expirado' };

    return {
      valid: true,
      bonus: inv.bonusCents / 100,
      storeCode: inv.storeCode,
      sellerName: inv.sellerName,
    };
  }

  /**
   * Resgata token quando cliente se cadastra. Credita bônus imediato.
   * Marca PWA como instalado pra ativar welcome bonus tradicional também.
   */
  async redeemToken(token: string, accountId: string) {
    if (!token) return { redeemed: false, reason: 'sem token' };

    const inv = await this.prisma.appInviteToken.findUnique({
      where: { token },
    });

    if (!inv) return { redeemed: false, reason: 'token inválido' };
    if (inv.usedByAccountId) {
      return { redeemed: false, reason: 'já usado' };
    }
    if (inv.expiresAt < new Date()) {
      return { redeemed: false, reason: 'expirado' };
    }

    // Marca usado ANTES de creditar (evita race)
    const updated = await this.prisma.appInviteToken.updateMany({
      where: { token, usedByAccountId: null },
      data: { usedByAccountId: accountId, usedAt: new Date() },
    });
    if (updated.count === 0) {
      return { redeemed: false, reason: 'race condition' };
    }

    // Marca PWA instalado (caso ainda não tenha) + libera welcome bonus
    await this.prisma.customerAccount.update({
      where: { id: accountId },
      data: { pwaInstalledAt: new Date() },
    });

    // Credita o bônus do invite (no MESMO momento, sem esperar 1ª compra)
    const balance = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      select: { cashbackBalanceCents: true },
    });
    const newBalance = (balance?.cashbackBalanceCents ?? 0) + inv.bonusCents;

    await this.prisma.$transaction([
      this.prisma.customerCashbackTx.create({
        data: {
          accountId,
          type: 'welcome',
          amountCents: inv.bonusCents,
          balanceAfterCents: newBalance,
          description: `🎁 Bônus de boas-vindas (indicação loja ${inv.storeCode}${inv.sellerName ? ' / ' + inv.sellerName : ''})`,
          expiresAt: new Date(Date.now() + 30 * 86400 * 1000),
        },
      }),
      this.prisma.customerAccount.update({
        where: { id: accountId },
        data: {
          cashbackBalanceCents: newBalance,
          cashbackEarnedCents: { increment: BigInt(inv.bonusCents) },
          welcomeBonusAt: new Date(),
        },
      }),
    ]);

    this.logger.log(
      `Invite ${token} resgatado → R$ ${(inv.bonusCents / 100).toFixed(2)} pra account ${accountId} (origem: ${inv.storeCode}/${inv.sellerName})`,
    );

    return {
      redeemed: true,
      bonus: inv.bonusCents / 100,
      storeCode: inv.storeCode,
      sellerName: inv.sellerName,
    };
  }

  /**
   * Relatório admin: quantos QRs por loja/vendedora foram convertidos.
   */
  async getStats(opts: { fromDate?: Date; toDate?: Date; storeCode?: string }) {
    const where: any = {};
    if (opts.fromDate) where.createdAt = { gte: opts.fromDate };
    if (opts.toDate) where.createdAt = { ...where.createdAt, lt: opts.toDate };
    if (opts.storeCode) where.storeCode = opts.storeCode;

    const all = await this.prisma.appInviteToken.findMany({ where });
    const total = all.length;
    const used = all.filter((t) => t.usedByAccountId).length;
    const expired = all.filter((t) => !t.usedByAccountId && t.expiresAt < new Date()).length;
    const totalBonusGiven = all
      .filter((t) => t.usedByAccountId)
      .reduce((s, t) => s + t.bonusCents, 0);

    // Por vendedora
    const bySeller = new Map<string, { issued: number; converted: number }>();
    for (const t of all) {
      const key = t.sellerName || '(sem vendedora)';
      const cur = bySeller.get(key) || { issued: 0, converted: 0 };
      cur.issued++;
      if (t.usedByAccountId) cur.converted++;
      bySeller.set(key, cur);
    }

    return {
      total,
      used,
      expired,
      conversionRate: total > 0 ? (used / total) * 100 : 0,
      totalBonusGivenBrl: totalBonusGiven / 100,
      bySeller: Array.from(bySeller.entries()).map(([name, s]) => ({
        sellerName: name,
        issued: s.issued,
        converted: s.converted,
        rate: s.issued > 0 ? (s.converted / s.issued) * 100 : 0,
      })),
    };
  }
}

/** Gera token curto pra QR (10 chars, fácil de digitar manual se necessário) */
function generateShortToken(): string {
  return crypto.randomBytes(6).toString('base64url'); // ~8 chars
}
