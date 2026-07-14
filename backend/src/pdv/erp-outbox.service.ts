import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { PdvService } from './pdv.service';

/**
 * ErpOutboxService — processa a fila `erp_outbox` de escrita no Giga/Wincred.
 *
 * A venda finaliza SÓ no Postgres e enfileira um job kind='venda' aqui.
 * Este processor (cron 30s) executa os dois passos no Wincred:
 *   1. gravarVendaPdv  → INSERT na `caixa`   (marca caixaDoneAt)
 *   2. decreaseStock   → UPDATE em `estoque` (marca stockDoneAt)
 *
 * Idempotência: cada sub-passo só roda se ainda não tem *DoneAt — retry após
 * falha parcial NUNCA duplica o INSERT na caixa. A baixa de estoque ainda tem
 * o guard extra do sale.stockDecreasedAt (compartilhado com o
 * reconcileStockBacklog, que segue como rede de segurança).
 *
 * Retry: backoff crescente (30s → 1m → 2m → 5m → 10m → 30m → 1h, cap 1h).
 * Giga fora do ar por horas = jobs esperando; quando volta, drena a fila.
 * Após MAX_ATTEMPTS o job vira 'failed' (visível em GET /pdv/erp-outbox) e
 * pode ser re-enfileirado via POST /pdv/erp-outbox/retry.
 *
 * Kill-switch: PDV_ERP_OUTBOX=0 (o finalize volta a executar inline e este
 * cron ainda drena o que sobrou na fila).
 */
@Injectable()
export class ErpOutboxService {
  private readonly logger = new Logger(ErpOutboxService.name);
  private running = false;

  /** Backoff em segundos por nº de tentativas já feitas. */
  private static readonly BACKOFF_S = [30, 60, 120, 300, 600, 1800];
  private static readonly BACKOFF_CAP_S = 3600;
  private static readonly MAX_ATTEMPTS = 100; // ~3 dias no cap de 1h
  private static readonly BATCH = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdv: PdvService,
    private readonly erp: ErpService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'erp-outbox-processor' })
  async tick(): Promise<void> {
    if (this.running) return; // guard de overlap
    this.running = true;
    try {
      await this.processBatch();
    } catch (e: any) {
      this.logger.error(`[outbox] tick falhou: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }

  async processBatch(): Promise<{ processed: number; done: number; retried: number }> {
    const now = new Date();
    const due: any[] = await (this.prisma as any).erpOutbox.findMany({
      where: { status: 'pending', nextRetryAt: { lte: now } },
      orderBy: { createdAt: 'asc' },
      take: ErpOutboxService.BATCH,
    });
    let done = 0;
    let retried = 0;
    for (const job of due) {
      // Claim atômico — só processa se ainda está pending (protege contra
      // tick concorrente / múltiplas réplicas).
      const claimed = await (this.prisma as any).erpOutbox.updateMany({
        where: { id: job.id, status: 'pending' },
        data: { status: 'processing' },
      });
      if (claimed.count !== 1) continue;

      const ok = await this.processJob(job).catch((e: any) => {
        this.logger.error(`[outbox] job ${job.id} explodiu: ${e?.message || e}`);
        return false;
      });
      if (ok) done++;
      else retried++;
    }
    if (due.length > 0) {
      this.logger.log(`[outbox] batch: ${due.length} job(s) — ${done} done, ${retried} re-agendado(s)`);
    }
    return { processed: due.length, done, retried };
  }

  /** true = job concluído; false = re-agendado (ou failed). */
  private async processJob(job: any): Promise<boolean> {
    if (job.kind === 'produto_cadastro') return this.processProdutoCadastro(job);
    if (job.kind === 'produto_exclusao') return this.processProdutoExclusao(job);
    if (job.kind === 'estoque_delta') return this.processEstoqueDelta(job);
    if (job.kind !== 'venda') {
      await this.markFailed(job, `kind desconhecido: ${job.kind}`);
      return false;
    }

    // Estado fresco da venda — payload guarda só o finalMethod.
    const sale: any = await (this.prisma as any).pdvSale.findUnique({
      where: { id: job.saleId },
      include: { items: true, payments: true },
    });

    // Venda sumiu, foi cancelada ou é treino → nada a sincronizar.
    if (!sale || sale.status !== 'finalized' || sale.isTraining) {
      await (this.prisma as any).erpOutbox.update({
        where: { id: job.id },
        data: {
          status: 'done',
          doneAt: new Date(),
          lastError: !sale
            ? 'venda não encontrada'
            : sale.isTraining
              ? 'venda de treinamento — skip'
              : `status=${sale.status} — skip`,
        },
      });
      return true;
    }

    const finalMethod = String(job.payload?.finalMethod || sale.paymentMethod || '');
    const payments = (sale.payments || []) as any[];

    let caixaDoneAt: Date | null = job.caixaDoneAt ? new Date(job.caixaDoneAt) : null;
    let stockDoneAt: Date | null = job.stockDoneAt ? new Date(job.stockDoneAt) : null;
    let stepError: string | null = null;

    // ── Passo 1: caixa (NUNCA re-executa depois de done — duplicaria a venda) ──
    if (!caixaDoneAt) {
      const r = await this.pdv.erpStepGravarCaixa(sale, payments, finalMethod);
      if (r.ok) caixaDoneAt = new Date();
      else stepError = `caixa: ${r.error || 'falha'}`;
    }

    // ── Passo 2: estoque (guard extra via sale.stockDecreasedAt) ──
    if (!stockDoneAt && !stepError) {
      const r = await this.pdv.erpStepBaixarEstoque(sale);
      if (r.ok) stockDoneAt = new Date();
      else stepError = `estoque: ${r.error || 'falha'}`;
    }

    if (caixaDoneAt && stockDoneAt) {
      await (this.prisma as any).erpOutbox.update({
        where: { id: job.id },
        data: {
          status: 'done',
          caixaDoneAt,
          stockDoneAt,
          doneAt: new Date(),
          lastError: null,
        },
      });
      this.logger.log(`[outbox] venda ${job.saleId} sincronizada no Wincred (tentativa ${job.attempts + 1})`);
      return true;
    }

    // Falhou em algum passo → re-agenda com backoff (preservando progresso).
    const attempts = (job.attempts || 0) + 1;
    if (attempts >= ErpOutboxService.MAX_ATTEMPTS) {
      await (this.prisma as any).erpOutbox.update({
        where: { id: job.id },
        data: { status: 'failed', attempts, caixaDoneAt, stockDoneAt, lastError: stepError },
      });
      this.logger.error(
        `[outbox] venda ${job.saleId} FAILED após ${attempts} tentativas: ${stepError} — requer ação manual (POST /pdv/erp-outbox/retry)`,
      );
      return false;
    }
    const delayS =
      ErpOutboxService.BACKOFF_S[Math.min(attempts - 1, ErpOutboxService.BACKOFF_S.length - 1)] ??
      ErpOutboxService.BACKOFF_CAP_S;
    await (this.prisma as any).erpOutbox.update({
      where: { id: job.id },
      data: {
        status: 'pending',
        attempts,
        caixaDoneAt,
        stockDoneAt,
        lastError: stepError,
        nextRetryAt: new Date(Date.now() + Math.min(delayS, ErpOutboxService.BACKOFF_CAP_S) * 1000),
      },
    });
    this.logger.warn(
      `[outbox] venda ${job.saleId} re-agendada (+${delayS}s, tentativa ${attempts}): ${stepError}`,
    );
    return false;
  }

  /**
   * Réplica do CADASTRO DE PRODUTO pro Giga (o cadastro já gravou no Flow —
   * `product` + `wincred_produtos` — e só a cópia legada fica na fila quando
   * o Giga está fora). INSERT IGNORE no Wincred = retry idempotente.
   */
  private async processProdutoCadastro(job: any): Promise<boolean> {
    const produtos = Array.isArray(job.payload?.produtos) ? job.payload.produtos : null;
    if (!produtos?.length) {
      await this.markFailed(job, 'payload sem produtos');
      return false;
    }
    try {
      const r = await this.erp.inserirProdutosBatch(produtos);
      await (this.prisma as any).erpOutbox.update({
        where: { id: job.id },
        data: { status: 'done', doneAt: new Date(), lastError: null },
      });
      this.logger.log(
        `[outbox] cadastro ${job.saleId}: ${r.inseridos}/${produtos.length} replicado(s) no Wincred (tentativa ${job.attempts + 1})`,
      );
      return true;
    } catch (e: any) {
      const attempts = (job.attempts || 0) + 1;
      if (attempts >= ErpOutboxService.MAX_ATTEMPTS) {
        await (this.prisma as any).erpOutbox.update({
          where: { id: job.id },
          data: { status: 'failed', attempts, lastError: String(e?.message || e).slice(0, 300) },
        });
        return false;
      }
      const delayS =
        ErpOutboxService.BACKOFF_S[Math.min(attempts - 1, ErpOutboxService.BACKOFF_S.length - 1)] ??
        ErpOutboxService.BACKOFF_CAP_S;
      await (this.prisma as any).erpOutbox.update({
        where: { id: job.id },
        data: {
          status: 'pending',
          attempts,
          lastError: String(e?.message || e).slice(0, 300),
          nextRetryAt: new Date(Date.now() + Math.min(delayS, ErpOutboxService.BACKOFF_CAP_S) * 1000),
        },
      });
      this.logger.warn(`[outbox] cadastro ${job.saleId} re-agendado (+${delayS}s): ${e?.message}`);
      return false;
    }
  }

  /** Réplica da EXCLUSÃO de produto pro Giga (o Flow já apagou). Idempotente. */
  private async processProdutoExclusao(job: any): Promise<boolean> {
    const codigos = Array.isArray(job.payload?.codigos) ? job.payload.codigos : null;
    if (!codigos?.length) {
      await this.markFailed(job, 'payload sem codigos');
      return false;
    }
    try {
      const r = await this.erp.deleteProdutos(codigos);
      await (this.prisma as any).erpOutbox.update({
        where: { id: job.id },
        data: { status: 'done', doneAt: new Date(), lastError: null },
      });
      this.logger.log(`[outbox] exclusão ${job.saleId}: ${r.excluidos} apagado(s) no Wincred`);
      return true;
    } catch (e: any) {
      const attempts = (job.attempts || 0) + 1;
      const delayS =
        ErpOutboxService.BACKOFF_S[Math.min(attempts - 1, ErpOutboxService.BACKOFF_S.length - 1)] ??
        ErpOutboxService.BACKOFF_CAP_S;
      await (this.prisma as any).erpOutbox.update({
        where: { id: job.id },
        data: attempts >= ErpOutboxService.MAX_ATTEMPTS
          ? { status: 'failed', attempts, lastError: String(e?.message || e).slice(0, 300) }
          : {
              status: 'pending', attempts,
              lastError: String(e?.message || e).slice(0, 300),
              nextRetryAt: new Date(Date.now() + Math.min(delayS, ErpOutboxService.BACKOFF_CAP_S) * 1000),
            },
      });
      return false;
    }
  }

  /**
   * Réplica de DELTA DE ESTOQUE pro Giga (constituição 14/07: Flow é a fonte
   * — o delta já foi aplicado nos espelhos na hora da operação; aqui só a
   * cópia legada, com retry).
   */
  private async processEstoqueDelta(job: any): Promise<boolean> {
    const op = job.payload?.op === 'inc' ? 'inc' : job.payload?.op === 'dec' ? 'dec' : null;
    const items = Array.isArray(job.payload?.items) ? job.payload.items : null;
    if (!op || !items?.length) {
      await this.markFailed(job, 'payload sem op/items');
      return false;
    }
    try {
      const r = await this.erp.applyStockDeltaGigaOnly(op, items, job.payload?.opts || undefined);
      if (!r.success) throw new Error(r.error || 'falha na réplica de estoque');
      await (this.prisma as any).erpOutbox.update({
        where: { id: job.id },
        data: { status: 'done', doneAt: new Date(), lastError: null },
      });
      this.logger.log(`[outbox] estoque ${job.saleId} (${op}) replicado no Wincred`);
      return true;
    } catch (e: any) {
      const attempts = (job.attempts || 0) + 1;
      const delayS =
        ErpOutboxService.BACKOFF_S[Math.min(attempts - 1, ErpOutboxService.BACKOFF_S.length - 1)] ??
        ErpOutboxService.BACKOFF_CAP_S;
      await (this.prisma as any).erpOutbox.update({
        where: { id: job.id },
        data: attempts >= ErpOutboxService.MAX_ATTEMPTS
          ? { status: 'failed', attempts, lastError: String(e?.message || e).slice(0, 300) }
          : {
              status: 'pending', attempts,
              lastError: String(e?.message || e).slice(0, 300),
              nextRetryAt: new Date(Date.now() + Math.min(delayS, ErpOutboxService.BACKOFF_CAP_S) * 1000),
            },
      });
      return false;
    }
  }

  private async markFailed(job: any, error: string): Promise<void> {
    await (this.prisma as any).erpOutbox.update({
      where: { id: job.id },
      data: { status: 'failed', lastError: error },
    });
  }

  // ── Visibilidade / operação (endpoints no PdvController) ──

  async status(): Promise<{
    counts: Record<string, number>;
    oldestPendingAt: Date | null;
    failures: Array<{ saleId: string; attempts: number; lastError: string | null; createdAt: Date }>;
  }> {
    const grouped: any[] = await (this.prisma as any).erpOutbox.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    for (const g of grouped) counts[g.status] = g._count._all;

    const oldest: any = await (this.prisma as any).erpOutbox.findFirst({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const failures: any[] = await (this.prisma as any).erpOutbox.findMany({
      where: { status: 'failed' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { saleId: true, attempts: true, lastError: true, createdAt: true },
    });
    return { counts, oldestPendingAt: oldest?.createdAt || null, failures };
  }

  /** Re-enfileira jobs 'failed' (e opcionalmente zera tentativas). */
  async retryFailed(): Promise<{ requeued: number }> {
    const r = await (this.prisma as any).erpOutbox.updateMany({
      where: { status: 'failed' },
      data: { status: 'pending', attempts: 0, nextRetryAt: new Date() },
    });
    this.logger.log(`[outbox] ${r.count} job(s) failed re-enfileirado(s)`);
    return { requeued: r.count };
  }
}
