import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * CONCILIAÇÃO FINANCEIRA — FASE 2: importadores (aprovado 17/07).
 *
 * V1 varre as tabelas LOCAIS que os webhooks já mantêm frescas
 * (pagbank_payments, pagarme_payments, stone_transactions) e normaliza tudo
 * em financial_transactions — com raw_json + hash de integridade. As APIs de
 * extrato/recebíveis (financial_recebimentos) entram no próximo PR.
 *
 * Cron diário 02:00 (varredura incremental) + POST /conciliacao/importar
 * manual. Idempotente: upsert por (gateway, transactionId).
 */
@Injectable()
export class ConciliacaoService {
  private readonly logger = new Logger(ConciliacaoService.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  @Cron('0 2 * * *', { name: 'conciliacao-importar-diario' })
  async cronDiario() {
    try {
      const r = await this.importarTudo();
      this.logger.log(`[conciliacao] importação diária: ${JSON.stringify(r)}`);
    } catch (e) {
      this.logger.error(`[conciliacao] importação diária falhou: ${(e as Error).message}`);
    }
  }

  private hash(raw: any): string {
    return createHash('sha256').update(JSON.stringify(raw ?? null)).digest('hex');
  }

  private toCents(v: any): number | null {
    const n = Number(v);
    return isFinite(n) ? Math.round(n * 100) : null;
  }

  private async upsertTx(t: {
    gateway: string;
    transactionId: string;
    chargeId?: string | null;
    pedidoRef?: string | null;
    storeCode?: string | null;
    nsu?: string | null;
    authorizationCode?: string | null;
    statusGateway?: string | null;
    valorBrutoCents?: number | null;
    parcelas?: number | null;
    bandeira?: string | null;
    tipoPagamento?: string | null;
    cartaoFinal?: string | null;
    dataVenda?: Date | null;
    dataRecebimento?: Date | null;
    raw: any;
  }): Promise<void> {
    const data: any = {
      gateway: t.gateway,
      transactionId: t.transactionId,
      chargeId: t.chargeId || null,
      pedidoRef: t.pedidoRef || null,
      storeCode: t.storeCode || null,
      nsu: t.nsu || null,
      authorizationCode: t.authorizationCode || null,
      statusGateway: t.statusGateway || null,
      valorBrutoCents: t.valorBrutoCents ?? null,
      parcelas: t.parcelas ?? null,
      bandeira: t.bandeira || null,
      tipoPagamento: t.tipoPagamento || null,
      cartaoFinal: t.cartaoFinal || null,
      dataVenda: t.dataVenda || null,
      dataRecebimento: t.dataRecebimento || null,
      rawJson: t.raw ?? null,
      rawHash: this.hash(t.raw),
    };
    const existente: any = await (this.prisma as any).financialTransaction.findFirst({
      where: { gateway: t.gateway, transactionId: t.transactionId },
      select: { id: true, rawHash: true },
    });
    if (existente) {
      if (existente.rawHash !== data.rawHash) {
        await (this.prisma as any).financialTransaction.update({ where: { id: existente.id }, data });
      }
    } else {
      await (this.prisma as any).financialTransaction.create({ data });
    }
  }

  /** Varre as 3 fontes locais. `desdeDias` limita a janela (default 400 = backfill inicial). */
  async importarTudo(desdeDias = 400): Promise<{ pagbank: number; pagarme: number; stone: number }> {
    if (this.running) return { pagbank: 0, pagarme: 0, stone: 0 };
    this.running = true;
    const desde = new Date(Date.now() - desdeDias * 86400000);
    const out = { pagbank: 0, pagarme: 0, stone: 0 };
    try {
      // ── PagBank (PIX/cartão da live + PDV) ──
      const pb: any[] = await (this.prisma as any).pagbankPayment.findMany({
        where: { updatedAt: { gte: desde } },
      });
      for (const p of pb) {
        try {
          await this.upsertTx({
            gateway: 'PAGBANK',
            transactionId: String(p.pagbankOrderId),
            chargeId: p.pagbankChargeId || null,
            pedidoRef: p.saleId || null,
            storeCode: p.storeCode || null,
            statusGateway: p.status || null,
            valorBrutoCents: this.toCents(p.valor),
            tipoPagamento: p.method || null,
            dataVenda: p.createdAt || null,
            dataRecebimento: p.paidAt || null,
            raw: p.rawWebhook ? this.tryJson(p.rawWebhook) : { ...p, rawWebhook: undefined },
          });
          out.pagbank++;
        } catch (e) {
          this.logger.warn(`[conciliacao] pagbank ${p.id}: ${(e as Error).message}`);
        }
      }
      // ── Pagar.me (links de pagamento) ──
      const pm: any[] = await (this.prisma as any).pagarmePayment.findMany({
        where: { updatedAt: { gte: desde } },
      });
      for (const p of pm) {
        try {
          await this.upsertTx({
            gateway: 'PAGARME',
            transactionId: String(p.pagarmeOrderId),
            chargeId: p.pagarmeChargeId || null,
            pedidoRef: p.saleId || null,
            storeCode: p.storeCode || null,
            statusGateway: p.status || null,
            valorBrutoCents: this.toCents(p.valor),
            tipoPagamento: p.method || null,
            dataVenda: p.createdAt || null,
            dataRecebimento: p.paidAt || null,
            raw: p.rawWebhook ? this.tryJson(p.rawWebhook) : { ...p, rawWebhook: undefined },
          });
          out.pagarme++;
        } catch (e) {
          this.logger.warn(`[conciliacao] pagarme ${p.id}: ${(e as Error).message}`);
        }
      }
      // ── Stone (maquininhas físicas das lojas) ──
      const st: any[] = await (this.prisma as any).stoneTransaction.findMany({
        where: { receivedAt: { gte: desde } },
      });
      for (const s of st) {
        try {
          await this.upsertTx({
            gateway: 'STONE',
            transactionId: String(s.stoneTxId),
            pedidoRef: s.matchedSaleId || null,
            storeCode: s.storeCode || null,
            nsu: s.stoneNsu || null,
            authorizationCode: s.authorizationCode || null,
            statusGateway: s.status || null,
            valorBrutoCents: this.toCents(s.amount),
            parcelas: s.installments ?? null,
            bandeira: s.bandeira || null,
            tipoPagamento: s.paymentMethod || null,
            cartaoFinal: s.last4 || null,
            dataVenda: s.capturedAt || null,
            raw: this.tryJson(s.rawPayload),
          });
          out.stone++;
        } catch (e) {
          this.logger.warn(`[conciliacao] stone ${s.id}: ${(e as Error).message}`);
        }
      }
      this.logger.log(`[conciliacao] importados: PagBank=${out.pagbank} Pagarme=${out.pagarme} Stone=${out.stone}`);
      return out;
    } finally {
      this.running = false;
    }
  }

  private tryJson(s: any): any {
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch { return { raw: s }; }
  }

  async status() {
    const porGateway: any[] = await (this.prisma as any).financialTransaction.groupBy({
      by: ['gateway'],
      _count: { _all: true },
      _sum: { valorBrutoCents: true },
    });
    const conciliacoes: any[] = await (this.prisma as any).financialConciliacao.groupBy({
      by: ['status'],
      _count: { _all: true },
    }).catch(() => []);
    return {
      transacoes: porGateway.map((g) => ({ gateway: g.gateway, qtd: g._count._all, brutoCents: g._sum.valorBrutoCents || 0 })),
      conciliacoes: conciliacoes.map((c) => ({ status: c.status, qtd: c._count._all })),
      importando: this.running,
    };
  }
}
