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

  // ── FASE 3: MOTOR DE CONCILIAÇÃO ──────────────────────────────────────
  private static readonly PAGO = new Set(['paid', 'captured', 'approved', 'succeeded', 'PAID', 'CAPTURED']);

  /** Acha a venda no sistema pelo pedidoRef: PdvSale OU carrinho da live. */
  private async valorSistemaCents(pedidoRef: string | null): Promise<{ achou: boolean; cents: number | null; origem: string | null }> {
    if (!pedidoRef) return { achou: false, cents: null, origem: null };
    const sale: any = await (this.prisma as any).pdvSale.findUnique({
      where: { id: pedidoRef }, select: { total: true, status: true },
    }).catch(() => null);
    if (sale) return { achou: true, cents: this.toCents(sale.total), origem: 'pdv' };
    const cart: any = await (this.prisma as any).livePdvCart.findUnique({
      where: { id: pedidoRef }, select: { totalCents: true },
    }).catch(() => null);
    if (cart) return { achou: true, cents: Number(cart.totalCents) || 0, origem: 'live' };
    return { achou: false, cents: null, origem: null };
  }

  /** Roda o motor sobre as transações PAGAS da janela. Idempotente. */
  async conciliar(desdeDias = 400): Promise<{ conciliadas: number; divergentes: number; semVenda: number; duplicadas: number; total: number }> {
    const desde = new Date(Date.now() - desdeDias * 86400000);
    const txs: any[] = await (this.prisma as any).financialTransaction.findMany({
      where: { createdAt: { gte: desde } },
      orderBy: { dataVenda: 'asc' },
    });
    const pagas = txs.filter((t) => ConciliacaoService.PAGO.has(String(t.statusGateway || '')));
    const porPedido = new Map<string, number>();
    for (const t of pagas) {
      if (t.pedidoRef) porPedido.set(t.pedidoRef, (porPedido.get(t.pedidoRef) || 0) + 1);
    }
    const r = { conciliadas: 0, divergentes: 0, semVenda: 0, duplicadas: 0, total: pagas.length };
    for (const t of pagas) {
      let status = 'NAO_ENCONTRADO';
      let motivo: string | null = null;
      let valorSistema: number | null = null;
      const gw = Number(t.valorBrutoCents) || null;
      const sis = await this.valorSistemaCents(t.pedidoRef);
      if (t.pedidoRef && (porPedido.get(t.pedidoRef) || 0) > 1) {
        status = 'DUPLICADO';
        motivo = `${porPedido.get(t.pedidoRef)} transações pagas pro mesmo pedido`;
        valorSistema = sis.cents;
        r.duplicadas++;
      } else if (!sis.achou) {
        status = 'NAO_ENCONTRADO';
        motivo = t.pedidoRef ? `pedido ${t.pedidoRef} não existe no sistema` : 'pagamento sem venda vinculada';
        r.semVenda++;
      } else {
        valorSistema = sis.cents;
        const dif = gw != null && valorSistema != null ? gw - valorSistema : null;
        if (dif != null && Math.abs(dif) <= 1) {
          status = 'CONCILIADO';
          r.conciliadas++;
        } else {
          status = 'DIVERGENTE';
          motivo = `valor gateway ${gw ?? '?'}c ≠ sistema ${valorSistema ?? '?'}c`;
          r.divergentes++;
        }
      }
      const diferenca = gw != null && valorSistema != null ? gw - valorSistema : null;
      await (this.prisma as any).financialConciliacao.upsert({
        where: { transactionId: t.id },
        create: {
          transactionId: t.id, pedidoRef: t.pedidoRef, gateway: t.gateway, status,
          valorSistemaCents: valorSistema, valorGatewayCents: gw,
          diferencaCents: diferenca, motivo,
        },
        update: {
          status, pedidoRef: t.pedidoRef, valorSistemaCents: valorSistema,
          valorGatewayCents: gw, diferencaCents: diferenca, motivo,
          ultimaConciliacao: new Date(),
        },
      });
      await (this.prisma as any).financialTransaction.update({
        where: { id: t.id },
        data: { statusInterno: status.toLowerCase() },
      }).catch(() => null);
    }
    this.logger.log(`[conciliacao] motor: ${JSON.stringify(r)}`);
    return r;
  }

  /** Lista pra tela: transação + conciliação, filtrável. */
  async listar(f: { status?: string; gateway?: string; page?: number; perPage?: number }) {
    const page = Math.max(1, f.page || 1);
    const perPage = Math.min(200, Math.max(10, f.perPage || 50));
    const where: any = {};
    if (f.status) where.status = f.status;
    if (f.gateway) where.gateway = f.gateway;
    const [total, rows] = await Promise.all([
      (this.prisma as any).financialConciliacao.count({ where }),
      (this.prisma as any).financialConciliacao.findMany({
        where,
        orderBy: { ultimaConciliacao: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
    ]);
    const txIds = rows.map((r: any) => r.transactionId);
    const txs: any[] = await (this.prisma as any).financialTransaction.findMany({
      where: { id: { in: txIds } },
    });
    const porId = new Map(txs.map((t) => [t.id, t]));
    return {
      total, page, perPage,
      rows: rows.map((c: any) => {
        const t: any = porId.get(c.transactionId) || {};
        return {
          ...c,
          tipoPagamento: t.tipoPagamento, bandeira: t.bandeira, nsu: t.nsu,
          storeCode: t.storeCode, dataVenda: t.dataVenda, statusGateway: t.statusGateway,
          parcelas: t.parcelas, cartaoFinal: t.cartaoFinal,
        };
      }),
    };
  }

  /** JSON bruto de uma transação (botão Ver JSON da tela). */
  async verJson(transactionId: string) {
    return (this.prisma as any).financialTransaction.findUnique({ where: { id: transactionId } });
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
