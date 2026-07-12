import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ManychatService } from './manychat.service';

/**
 * COBRANÇA AUTOMÁTICA POR WHATSAPP (decisão do dono, 11/07 — "v2"):
 * carrinho da live PARADO (sem atualização há N horas, default 2) e não pago
 * → mensagem INDIVIDUAL de WhatsApp com o link exato do carrinho, via
 * ManyChat API (template de UTILIDADE aprovado pela Meta — sem janela de 24h,
 * ~R$0,04/msg). Complementa a cobrança por DM do Instagram que já existe.
 *
 * Segurança/anti-spam:
 *  - 1 envio por carrinho (cobrancaWhatsEnviadaAt) — NUNCA repete;
 *  - máx 3 tentativas em falha (cobrancaWhatsTentativas) — não vira loop;
 *  - máx 30 envios por ciclo (30min) — warm-up do número;
 *  - timeout auto-agendado NÃO: cron com guard de overlap (lição de 01/07 —
 *    nunca setInterval async que empilha).
 *
 * Ligar (Railway → Variables):
 *  - LIVE_COBRANCA_WHATS=1               (kill-switch, default OFF)
 *  - MANYCHAT_API_TOKEN=<token>          (ManyChat → Configurações → API)
 *  - MANYCHAT_COBRANCA_FLOW_NS=<ns>      (flow com o template; ⋮ → Set Flow NS)
 *  - LIVE_COBRANCA_WHATS_HORAS=2         (opcional — horas parado)
 *
 * O flow no ManyChat manda o template lendo os custom fields que gravamos:
 * cobranca_nome, cobranca_valor, cobranca_link.
 */
@Injectable()
export class LivePdvCobrancaWhatsCron {
  private readonly logger = new Logger(LivePdvCobrancaWhatsCron.name);
  private running = false;
  private readonly MAX_POR_CICLO = 30;
  private readonly MAX_TENTATIVAS = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly manychat: ManychatService,
  ) {}

  private get enabled(): boolean {
    return (
      String(process.env.LIVE_COBRANCA_WHATS || '').trim() === '1' &&
      this.manychat.enabled &&
      !!(process.env.MANYCHAT_COBRANCA_FLOW_NS || '').trim()
    );
  }

  private get horasParado(): number {
    const h = Number(process.env.LIVE_COBRANCA_WHATS_HORAS || 2);
    return isNaN(h) || h < 1 ? 2 : h;
  }

  /** Telefone BR → dígitos E.164 (55 + DDD + número). null = inválido. */
  private normalizePhone(raw?: string | null): string | null {
    let d = String(raw || '').replace(/\D/g, '');
    if (!d) return null;
    if (d.startsWith('0')) d = d.replace(/^0+/, '');
    if (d.length === 10 || d.length === 11) d = '55' + d; // DDD + número
    if (d.length === 12 || d.length === 13) {
      if (!d.startsWith('55')) return null; // internacional desconhecido — não arrisca
      return d;
    }
    return null;
  }

  private linkDoCarrinho(cart: { id: string; payCode?: string | null }): string {
    // FRONTEND_URL pode ser lista separada por vírgula — o link usa SÓ o
    // primeiro domínio (mesma regra da DM do Instagram; bug real de 07/07).
    const base = (process.env.FRONTEND_URL || 'https://flowops-lite.vercel.app')
      .split(',')[0]
      .trim()
      .replace(/\/$/, '');
    return cart.payCode ? `${base}/p/${cart.payCode}` : `${base}/pagar/${cart.id}`;
  }

  /** Carrinhos elegíveis pra cobrança (usado pelo cron e pelo preview do admin). */
  async elegiveis(take = this.MAX_POR_CICLO): Promise<any[]> {
    const corte = new Date(Date.now() - this.horasParado * 3600_000);
    return (this.prisma as any).livePdvCart.findMany({
      where: {
        status: { in: ['open', 'awaiting_payment'] },
        totalCents: { gt: 0 },
        customerPhone: { not: '' },
        cobrancaWhatsEnviadaAt: null,
        cobrancaWhatsTentativas: { lt: this.MAX_TENTATIVAS },
        updatedAt: { lt: corte },
      },
      orderBy: { updatedAt: 'asc' },
      take,
      select: {
        id: true, payCode: true, customerName: true, customerPhone: true,
        totalCents: true, status: true, updatedAt: true, cobrancaWhatsTentativas: true,
      },
    });
  }

  @Cron('*/30 * * * *', { name: 'live-cobranca-whats' })
  async handle() {
    if (!this.enabled) return;
    if (this.running) {
      this.logger.log('[cobranca-whats] ciclo pulado — anterior em andamento');
      return;
    }
    this.running = true;
    try {
      await this.executarCiclo();
    } catch (e: any) {
      this.logger.error(`[cobranca-whats] ciclo falhou: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }

  /** Um ciclo de cobrança. Também chamável pelo endpoint admin (rodar agora). */
  async executarCiclo(): Promise<{ enviados: number; falhas: number; elegiveis: number }> {
    const flowNs = (process.env.MANYCHAT_COBRANCA_FLOW_NS || '').trim();
    const carts = await this.elegiveis();
    let enviados = 0;
    let falhas = 0;

    for (const cart of carts) {
      const phone = this.normalizePhone(cart.customerPhone);
      if (!phone) {
        // telefone irrecuperável — marca tentativas no máximo pra não voltar
        await this.marcarTentativa(cart.id, this.MAX_TENTATIVAS, 'telefone inválido');
        falhas++;
        continue;
      }
      try {
        // 1) assinante WhatsApp pelo telefone (acha ou cria)
        let subId = await this.manychat.findSubscriberByPhone(phone);
        if (!subId) {
          const created = await this.manychat.createWhatsAppSubscriber(phone, cart.customerName);
          subId = created.id;
          if (!subId) throw new Error(`createSubscriber: ${created.error || 'sem id'}`);
        }
        // 2) custom fields que o template lê
        const primeiroNome = String(cart.customerName || '').trim().split(/\s+/)[0] || 'cliente';
        const valor = ((cart.totalCents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        const link = this.linkDoCarrinho(cart);
        await this.manychat.setCustomFieldByName(subId, 'cobranca_nome', primeiroNome);
        await this.manychat.setCustomFieldByName(subId, 'cobranca_valor', valor);
        await this.manychat.setCustomFieldByName(subId, 'cobranca_link', link);
        // 3) dispara o flow com o template
        const r = await this.manychat.sendFlow(subId, flowNs);
        if (!r.ok) throw new Error(r.error || 'sendFlow falhou');

        await (this.prisma as any).livePdvCart.update({
          where: { id: cart.id },
          data: { cobrancaWhatsEnviadaAt: new Date() },
        });
        await this.logIntegracao('live.cobranca-whats.sent', {
          cartId: cart.id, phone: `...${phone.slice(-4)}`, valorCents: cart.totalCents, link,
        }, 200);
        enviados++;
      } catch (e: any) {
        falhas++;
        await this.marcarTentativa(cart.id, (cart.cobrancaWhatsTentativas || 0) + 1, e?.message);
        await this.logIntegracao('live.cobranca-whats.fail', {
          cartId: cart.id, erro: String(e?.message || e).slice(0, 200),
        }, 500);
      }
    }
    if (carts.length) {
      this.logger.log(`[cobranca-whats] ciclo: ${enviados} enviada(s), ${falhas} falha(s) de ${carts.length} elegível(is)`);
    }
    return { enviados, falhas, elegiveis: carts.length };
  }

  /**
   * COBRANÇA MANUAL (12/07, pedido do dono): o botão "WhatsApp" da fila
   * "Cobrar todas" dispara DIRETO pela API do ManyChat (mesmo template da
   * cobrança automática) em vez de abrir o app do WhatsApp na mão.
   * Ignora o "parado 2h" e o "já enviada" (o operador decide quando cobrar),
   * mas exige carrinho cobrável (aberto/aguardando, total>0, telefone).
   */
  async cobrarManual(cartId: string): Promise<{ ok: boolean }> {
    const flowNs = (process.env.MANYCHAT_COBRANCA_FLOW_NS || '').trim();
    if (!this.manychat.enabled || !flowNs) {
      throw new BadRequestException(
        'Cobrança via ManyChat não configurada — confira MANYCHAT_API_TOKEN e MANYCHAT_COBRANCA_FLOW_NS no Railway.',
      );
    }
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException('Carrinho não encontrado');
    if (!['open', 'awaiting_payment'].includes(cart.status)) {
      throw new BadRequestException('Carrinho não está mais em cobrança (já pago/cancelado).');
    }
    if (!(cart.totalCents > 0)) throw new BadRequestException('Carrinho sem valor.');
    const phone = this.normalizePhone(cart.customerPhone);
    if (!phone) throw new BadRequestException('Telefone da cliente inválido pra WhatsApp.');

    let subId = await this.manychat.findSubscriberByPhone(phone);
    if (!subId) {
      const created = await this.manychat.createWhatsAppSubscriber(phone, cart.customerName);
      subId = created.id;
      if (!subId) {
        throw new BadRequestException(`ManyChat não criou o contato: ${created.error || 'sem id'}`);
      }
    }
    const primeiroNome = String(cart.customerName || '').trim().split(/\s+/)[0] || 'cliente';
    const valor = ((cart.totalCents || 0) / 100).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
    const link = this.linkDoCarrinho(cart);
    await this.manychat.setCustomFieldByName(subId, 'cobranca_nome', primeiroNome);
    await this.manychat.setCustomFieldByName(subId, 'cobranca_valor', valor);
    await this.manychat.setCustomFieldByName(subId, 'cobranca_link', link);
    const r = await this.manychat.sendFlow(subId, flowNs);
    if (!r.ok) {
      await this.logIntegracao('live.cobranca-whats.manual.fail', { cartId, erro: r.error }, 500);
      throw new BadRequestException(`ManyChat recusou o envio: ${r.error || 'erro desconhecido'}`);
    }
    await (this.prisma as any).livePdvCart.update({
      where: { id: cartId },
      data: { cobrancaWhatsEnviadaAt: new Date() },
    });
    await this.logIntegracao(
      'live.cobranca-whats.manual.sent',
      { cartId, phone: `...${phone.slice(-4)}`, valorCents: cart.totalCents, link },
      200,
    );
    return { ok: true };
  }

  private async marcarTentativa(cartId: string, tentativas: number, motivo?: string) {
    await (this.prisma as any).livePdvCart
      .update({ where: { id: cartId }, data: { cobrancaWhatsTentativas: tentativas } })
      .catch(() => {});
    if (motivo) this.logger.warn(`[cobranca-whats] cart=${cartId} tentativa ${tentativas}: ${motivo}`);
  }

  private async logIntegracao(event: string, payload: any, status: number) {
    await (this.prisma as any).integrationLog
      .create({
        data: { source: 'manychat', direction: 'out', event, payload: JSON.stringify(payload), status },
      })
      .catch(() => {});
  }
}
