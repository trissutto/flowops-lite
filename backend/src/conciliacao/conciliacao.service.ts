import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { donosDosPagamentos } from '../common/dono-do-pagamento';
import { classificarPagamentos } from './classificar-pagamentos';

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

  /**
   * 02:00 — importa E concilia. Até 20/09 o cron só importava: o veredito só
   * mudava quando alguém clicava "2. Conciliar", então a tela amanhecia com a
   * foto do último clique (e um conserto no motor não aparecia sozinho).
   */
  @Cron('0 2 * * *', { name: 'conciliacao-importar-diario' })
  async cronDiario() {
    try {
      const r = await this.importarTudo();
      this.logger.log(`[conciliacao] importação diária: ${JSON.stringify(r)}`);
    } catch (e) {
      this.logger.error(`[conciliacao] importação diária falhou: ${(e as Error).message}`);
      return;
    }
    try {
      await this.conciliar();
    } catch (e) {
      this.logger.error(`[conciliacao] motor diário falhou: ${(e as Error).message}`);
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

  /**
   * Roda o motor sobre as transações PAGAS da janela. Idempotente.
   *
   * O dono do pagamento sai da régua única (`common/dono-do-pagamento.ts`):
   * venda do PDV, carrinho da live, baixa de crediário OU pedido do site. Até
   * 20/09 o motor só conhecia os dois primeiros, e todo pedido do site e toda
   * parcela paga por PIX apareciam como "Pgto sem venda" (1.519 na tela).
   */
  async conciliar(desdeDias = 400): Promise<{ conciliadas: number; divergentes: number; semVenda: number; duplicadas: number; total: number }> {
    const desde = new Date(Date.now() - desdeDias * 86400000);
    const txs: any[] = await (this.prisma as any).financialTransaction.findMany({
      where: { createdAt: { gte: desde } },
      orderBy: { dataVenda: 'asc' },
    });
    const pagas = txs.filter((t) => ConciliacaoService.PAGO.has(String(t.statusGateway || '')));
    const r = { conciliadas: 0, divergentes: 0, semVenda: 0, duplicadas: 0, total: pagas.length };
    // Uma ida ao banco pro lote inteiro. Erro aqui SOBE de propósito: consulta
    // que falhou não pode virar "sem venda" carimbado em venda boa.
    const donos = await donosDosPagamentos(this.prisma, pagas.map((t) => t.pedidoRef), { comPagamentos: true });
    // O veredito é puro e tem spec: `classificar-pagamentos.ts` (venda
    // dividida casa com o pagamento que cita a order; dono cancelado não concilia).
    const vereditos = classificarPagamentos(
      pagas.map((t) => ({
        id: t.id,
        pedidoRef: t.pedidoRef,
        gatewayOrderId: t.transactionId,
        cents: Number(t.valorBrutoCents) || null,
        formaGateway: t.tipoPagamento,
      })),
      donos,
    );
    const contador: Record<string, keyof typeof r> = {
      CONCILIADO: 'conciliadas', DIVERGENTE: 'divergentes', NAO_ENCONTRADO: 'semVenda', DUPLICADO: 'duplicadas',
    };
    for (const t of pagas) {
      const v = vereditos.get(t.id)!;
      const { status, motivo, origem } = v;
      const valorSistema = v.valorSistemaCents;
      const gw = Number(t.valorBrutoCents) || null;
      r[contador[status]]++;
      const diferenca = gw != null && valorSistema != null ? gw - valorSistema : null;
      await (this.prisma as any).financialConciliacao.upsert({
        where: { transactionId: t.id },
        create: {
          transactionId: t.id, pedidoRef: t.pedidoRef, gateway: t.gateway, status,
          valorSistemaCents: valorSistema, valorGatewayCents: gw,
          diferencaCents: diferenca, motivo, origem,
        },
        update: {
          status, pedidoRef: t.pedidoRef, valorSistemaCents: valorSistema,
          valorGatewayCents: gw, diferencaCents: diferenca, motivo, origem,
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
  async listar(f: { status?: string; gateway?: string; origem?: string; storeCode?: string; page?: number; perPage?: number }) {
    const page = Math.max(1, f.page || 1);
    const perPage = Math.min(200, Math.max(10, f.perPage || 50));
    const where: any = {};
    if (f.status) where.status = f.status;
    if (f.gateway) where.gateway = f.gateway;
    if (f.origem) where.origem = f.origem;
    // Filtro por LOJA: a loja mora na transação — resolve os ids primeiro
    if (f.storeCode) {
      const txsDaLoja: any[] = await (this.prisma as any).financialTransaction.findMany({
        where: { storeCode: f.storeCode },
        select: { id: true },
      });
      where.transactionId = { in: txsDaLoja.map((t) => t.id) };
    }
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

    // NOME DO CLIENTE: do dono do pagamento quando ele existe (mesma régua do
    // motor — venda, live, crediário ou pedido do site); quando é "pgto sem
    // venda", tenta o nome do PAGADOR no raw do gateway (o sistema envia
    // customer.name ao criar a order). Ajuda a identificar de quem é cada PIX
    // que caiu sem venda vinculada.
    const donos = await donosDosPagamentos(this.prisma, rows.map((r: any) => r.pedidoRef));

    return {
      total, page, perPage,
      rows: rows.map((c: any) => {
        const t: any = porId.get(c.transactionId) || {};
        const clienteNome =
          (c.pedidoRef && donos.get(String(c.pedidoRef).trim())?.clienteNome) ||
          this.nomeDoRaw(t.rawJson) ||
          null;
        return {
          ...c,
          clienteNome,
          tipoPagamento: t.tipoPagamento, bandeira: t.bandeira, nsu: t.nsu,
          storeCode: t.storeCode, dataVenda: t.dataVenda, statusGateway: t.statusGateway,
          parcelas: t.parcelas, cartaoFinal: t.cartaoFinal,
        };
      }),
    };
  }

  /** Extrai o nome do pagador/cliente do JSON bruto do gateway (best-effort). */
  private nomeDoRaw(raw: any): string | null {
    if (!raw || typeof raw !== 'object') return null;
    const cands = [
      raw?.customer?.name,
      raw?.charges?.[0]?.customer?.name,
      raw?.data?.customer?.name,
      raw?.order?.customer?.name,
      raw?.customerName,
    ];
    for (const c of cands) {
      const s = c ? String(c).trim() : '';
      if (s) return s;
    }
    return null;
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
    // DE ONDE veio o dinheiro pago: loja, link, PIX online, crediário, site, live.
    // Sem catch: se a conta falhar a tela mostra o erro, não um "zero" inventado.
    const porOrigem: any[] = await (this.prisma as any).financialConciliacao.groupBy({
      by: ['origem'],
      _count: { _all: true },
      _sum: { valorGatewayCents: true },
    });
    return {
      transacoes: porGateway.map((g) => ({ gateway: g.gateway, qtd: g._count._all, brutoCents: g._sum.valorBrutoCents || 0 })),
      conciliacoes: conciliacoes.map((c) => ({ status: c.status, qtd: c._count._all })),
      origens: porOrigem
        .filter((o) => o.origem)
        .map((o) => ({ origem: o.origem, qtd: o._count._all, cents: o._sum.valorGatewayCents || 0 })),
      importando: this.running,
    };
  }

  /**
   * A coluna `origem` nasceu em 20/09 com ~3 mil linhas já conciliadas — e a
   * lição do dia foi que conserto que depende de alguém clicar "2. Conciliar"
   * não chega na tela. Então o boot confere: tem linha COM dono e SEM origem?
   * Roda o motor uma vez, em segundo plano. Depois disso a conta dá zero e o
   * boot não faz mais nada (o motor sempre grava a origem).
   */
  onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test') return;
    setTimeout(() => {
      void this.preencherOrigemQueFalta().catch((e) =>
        this.logger.error(`[conciliacao] preencher origem no boot falhou: ${(e as Error).message}`),
      );
    }, 90_000).unref?.();
  }

  async preencherOrigemQueFalta(): Promise<{ faltavam: number; rodou: boolean }> {
    const faltavam: number = await (this.prisma as any).financialConciliacao.count({
      where: { origem: null, status: { not: 'NAO_ENCONTRADO' } },
    });
    if (!faltavam) return { faltavam: 0, rodou: false };
    this.logger.log(`[conciliacao] ${faltavam} linha(s) com dono e sem origem — rodando o motor pra preencher`);
    await this.conciliar();
    return { faltavam, rodou: true };
  }
}
