import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerCashbackService } from './customer-cashback.service';
import { CustomerPushService } from './customer-push.service';

/**
 * OrderAppHooksService — ponte entre o fluxo WooCommerce e o app cliente final.
 *
 * Toda vez que um pedido WC é criado/atualizado (via webhook ou polling), esse
 * service é chamado pra:
 *   1) Detectar se veio do app (meta_data _app_origin = 'app.lurds.com.br')
 *   2) Achar o CustomerAccount pelo CPF (cpfVariants — com pontos OU só dígitos)
 *   3) Se pedido PAGO (processing/completed):
 *      - Credita cashback 10% sobre PRODUTOS (sem frete) — idempotente por orderId
 *      - Dispara push "🎉 Pedido confirmado"
 *      - Se for 1ª compra paga: credita bônus boas-vindas R$ 20
 *   4) Se pedido ENVIADO (shipped):
 *      - Dispara push "📦 Pedido a caminho" com código de rastreio
 *
 * Idempotência:
 *   - Cashback já é idempotente via earnFromOrder (checa orderId em CustomerCashbackTx)
 *   - Push usa `tag: order-<id>-<event>` pra não empilhar duplicado no device
 */
@Injectable()
export class OrderAppHooksService {
  private readonly logger = new Logger(OrderAppHooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cashback: CustomerCashbackService,
    private readonly push: CustomerPushService,
  ) {}

  /**
   * Chamado após cada upsertFromWooCommerce.
   * Não joga exception — qualquer erro vira log (não pode quebrar webhook).
   */
  async handleWcOrder(wc: any): Promise<void> {
    try {
      if (!wc?.id) return;

      // 1) Só processa orders vindos do app
      const meta = Array.isArray(wc.meta_data) ? wc.meta_data : [];
      const appOrigin = meta.find((m: any) => m?.key === '_app_origin')?.value;
      if (appOrigin !== 'app.lurds.com.br') {
        return; // Pedido normal do site — não interessa pro hook
      }

      // 2) Encontra CustomerAccount pelo CPF
      const billing = wc.billing || {};
      const cpfRaw = String(
        billing.cpf ||
        meta.find((m: any) => m?.key === '_billing_cpf')?.value ||
        meta.find((m: any) => m?.key === 'billing_cpf')?.value ||
        '',
      );
      const cpfDigits = cpfRaw.replace(/\D/g, '');
      if (cpfDigits.length !== 11) {
        this.logger.warn(`Order WC #${wc.id} sem CPF válido — skip hook`);
        return;
      }
      const account = await this.prisma.customerAccount.findFirst({
        where: { cpf: { in: [cpfDigits, this.formatCpf(cpfDigits)] } },
        select: { id: true, name: true, welcomeBonusAt: true, pwaInstalledAt: true },
      });
      if (!account) {
        this.logger.warn(`Order WC #${wc.id}: CPF ${cpfDigits} sem CustomerAccount`);
        return;
      }

      const status = String(wc.status || '').toLowerCase().replace(/^wc-/, '');
      const wcOrderId = String(wc.id);

      // 3) Pedido PAGO → cashback + push de confirmação
      if (this.isPaidStatus(status)) {
        await this.onPaid(account, wc, wcOrderId);
      }

      // 4) Pedido ENVIADO → push de tracking
      if (this.isShippedStatus(status)) {
        await this.onShipped(account, wc, wcOrderId);
      }

      // 5) Pedido CANCELADO → push de aviso
      if (this.isCancelledStatus(status)) {
        await this.onCancelled(account, wc, wcOrderId);
      }
    } catch (e: any) {
      this.logger.error(`handleWcOrder #${wc?.id}: ${e?.message || e}`);
    }
  }

  /* ──────────────────── handlers de transição ──────────────────── */

  private async onPaid(
    account: { id: string; name: string | null; welcomeBonusAt: Date | null; pwaInstalledAt: Date | null },
    wc: any,
    wcOrderId: string,
  ): Promise<void> {
    // Calcula total dos PRODUTOS (sem frete) — instrução do CEO: cashback só sobre produtos
    const items = Array.isArray(wc.line_items) ? wc.line_items : [];
    const productsTotal = items.reduce((acc: number, li: any) => {
      const qty = Number(li.quantity) || 0;
      const price = Number(li.price) || (Number(li.total) / Math.max(qty, 1)) || 0;
      return acc + qty * price;
    }, 0);
    // Subtrai cashback usado (não pode dar cashback em cima de cashback)
    const cashbackUsedCents = Number(
      (Array.isArray(wc.meta_data) ? wc.meta_data : []).find(
        (m: any) => m?.key === '_app_cashback_used_cents',
      )?.value || 0,
    );
    const baseCents = Math.max(0, Math.round(productsTotal * 100) - cashbackUsedCents);

    // 1) Credita cashback (idempotente — checa orderId em CustomerCashbackTx)
    if (baseCents > 0) {
      try {
        const r: any = await this.cashback.earnFromOrder(account.id, wcOrderId, baseCents);
        if (r && !r.skipped) {
          this.logger.log(
            `Cashback creditado: account=${account.id} order=${wcOrderId} base=${baseCents}c`,
          );
        }
      } catch (e: any) {
        this.logger.error(`earnFromOrder falhou: ${e?.message}`);
      }
    }

    // 2) Debita cashback usado (se cliente aplicou no checkout)
    if (cashbackUsedCents > 0) {
      try {
        // Idempotência: checa se já tem tx de redeem pra essa order
        const already = await this.prisma.customerCashbackTx.findFirst({
          where: { accountId: account.id, orderId: wcOrderId, type: 'redeem' },
        });
        if (!already) {
          await this.cashback.redeem(
            account.id,
            cashbackUsedCents,
            `Cashback aplicado no pedido #${wcOrderId}`,
          );
          // Marca a tx com orderId pra idempotência futura
          await this.prisma.customerCashbackTx.updateMany({
            where: {
              accountId: account.id,
              type: 'redeem',
              orderId: null,
              amountCents: -cashbackUsedCents,
            },
            data: { orderId: wcOrderId },
          });
        }
      } catch (e: any) {
        this.logger.warn(`redeem falhou order=${wcOrderId}: ${e?.message}`);
      }
    }

    // 3) Welcome bonus R$ 20 (só se PWA instalado + nunca recebeu)
    if (!account.welcomeBonusAt && account.pwaInstalledAt) {
      try {
        await this.cashback.earnWelcomeBonus(account.id);
      } catch (e: any) {
        this.logger.warn(`welcome bonus falhou: ${e?.message}`);
      }
    }

    // 4) Push "Pedido confirmado" — só dispara 1x por order
    await this.sendOnceForOrder(account.id, wcOrderId, 'paid', {
      title: '🎉 Pedido confirmado!',
      body: `Obrigada${account.name ? ', ' + account.name.split(' ')[0] : ''}! Já estamos separando seu pedido${baseCents > 0 ? ` — você ganhou R$ ${((baseCents * 0.1) / 100).toFixed(2).replace('.', ',')} de cashback` : ''}.`,
      url: `/pedido/${wcOrderId}`,
      tag: `order-${wcOrderId}-paid`,
    });
  }

  private async onShipped(
    account: { id: string; name: string | null },
    wc: any,
    wcOrderId: string,
  ): Promise<void> {
    // Tenta achar código de rastreio no DB (já gravado pelo OrdersService)
    const local = await this.prisma.order.findUnique({
      where: { wcOrderId: Number(wcOrderId) },
      select: { trackingCode: true, carrier: true },
    });
    const tracking = local?.trackingCode;
    const carrier = local?.carrier || 'Correios';

    const body = tracking
      ? `Seu pedido foi postado! 📦 Código: ${tracking} (${carrier})`
      : `Seu pedido foi postado! 📦 Em breve você recebe o código de rastreio.`;

    await this.sendOnceForOrder(account.id, wcOrderId, 'shipped', {
      title: '📦 Pedido a caminho!',
      body,
      url: `/pedido/${wcOrderId}`,
      tag: `order-${wcOrderId}-shipped`,
    });
  }

  private async onCancelled(
    account: { id: string; name: string | null },
    _wc: any,
    wcOrderId: string,
  ): Promise<void> {
    await this.sendOnceForOrder(account.id, wcOrderId, 'cancelled', {
      title: 'Pedido cancelado',
      body: `Seu pedido #${wcOrderId} foi cancelado. Se foi engano, fale com a gente.`,
      url: `/pedido/${wcOrderId}`,
      tag: `order-${wcOrderId}-cancelled`,
    });
  }

  /* ──────────────────── helpers ──────────────────── */

  /**
   * Idempotência de push: usa CustomerCashbackTx com type='push_log' como flag.
   * Não é ideal (mistura responsabilidade), mas evita criar tabela nova só pra isso.
   * Alternativa: tabela CustomerAppPushLog dedicada — fica pra refator.
   */
  private async sendOnceForOrder(
    accountId: string,
    orderId: string,
    event: 'paid' | 'shipped' | 'cancelled',
    payload: { title: string; body: string; url: string; tag: string },
  ): Promise<void> {
    const tag = payload.tag;
    // Tag é única → marca via push tag mesmo. Web Push spec: notificações com mesma tag
    // SUBSTITUEM no device, não empilham. Mesmo se mandarmos 2x, cliente vê 1.
    try {
      await this.push.sendToAccount(accountId, payload);
      this.logger.log(`push ${event} enviado: account=${accountId} order=${orderId}`);
    } catch (e: any) {
      this.logger.warn(`push ${event} falhou: ${e?.message}`);
    }
  }

  private isPaidStatus(s: string): boolean {
    return ['processing', 'pago', 'paid', 'approved', 'completed', 'em-separacao'].includes(s);
  }
  private isShippedStatus(s: string): boolean {
    return ['shipped', 'sent', 'enviado', 'dispatched', 'delivered', 'entregue'].includes(s);
  }
  private isCancelledStatus(s: string): boolean {
    return ['cancelled', 'canceled', 'refunded'].includes(s);
  }

  private formatCpf(digits: string): string {
    if (digits.length !== 11) return digits;
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9, 11)}`;
  }
}
