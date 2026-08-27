import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { replicaGigaLigada, MOTIVO_REPLICA_DESLIGADA } from '../common/replica-giga';
import { CrediariosService } from '../crediarios/crediarios.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { PdvService } from './pdv.service';
import { MarcadosService } from './marcados.service';

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
    private readonly marcados: MarcadosService,
    @Inject(forwardRef(() => CrediariosService))
    private readonly crediarios: CrediariosService,
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
    // 🔴 RÉPLICA PRO GIGA DESLIGADA (27/08, ordem do dono: "já saímos dele faz
    // um mês"). Todo kind daqui é CÓPIA de algo que já vale no Flow, com uma
    // exceção: o job de `venda` também carrega a baixa de estoque, que é do
    // Flow — esse é tratado mais abaixo, não aqui. O resto é descartado com o
    // motivo gravado (status done, NÃO é DELETE: a linha fica pra auditoria).
    // Ver common/replica-giga.ts.
    if (!replicaGigaLigada() && job.kind !== 'venda') {
      await this.prisma.erpOutbox.update({
        where: { id: job.id },
        data: { status: 'done', doneAt: new Date(), lastError: MOTIVO_REPLICA_DESLIGADA },
      });
      this.logger.log(`[outbox] ${job.kind} ${job.id}: descartado — réplica pro Giga desligada`);
      return true;
    }
    if (job.kind === 'produto_cadastro') return this.processProdutoCadastro(job);
    if (job.kind === 'produto_exclusao') return this.processProdutoExclusao(job);
    if (job.kind === 'estoque_delta') return this.processEstoqueDelta(job);
    if (job.kind === 'cliente_upsert') return this.processClienteUpsert(job);
    if (job.kind === 'crediario_baixa') return this.processCrediarioBaixa(job);
    if (job.kind === 'crediario_estorno') return this.processCrediarioEstorno(job);
    // 🔴 DESLIGADO (07/08, regra do dono: "nunca marque ou puxe nada do
    // Giga"). Marcado não escreve mais no Giga de jeito nenhum — nem na hora,
    // nem em fila. Job velho que ainda exista da fila (`marcado_criar`/
    // `marcado_remover`) é descartado aqui, sem tentar `insertCaixaMarcado`/
    // `deleteCaixaMarcadoRow`: a peça já vale no Flow, e é isso que fica.
    if (job.kind === 'marcado_criar' || job.kind === 'marcado_remover') {
      await this.prisma.erpOutbox.update({
        where: { id: job.id },
        data: { status: 'done', doneAt: new Date(), lastError: 'skipped: marcados não escrevem mais no Giga (07/08)' },
      });
      this.logger.log(`[outbox] ${job.kind} ${job.id}: descartado sem tocar o Giga (regra 07/08)`);
      return true;
    }
    if (job.kind === 'categoria_criar') return this.processCategoriaCriar(job);
    if (job.kind === 'bandeira_fechamento') return this.processBandeiraFechamento(job);
    if (job.kind === 'crediario_criacao') return this.processCrediarioCriacao(job);
    if (job.kind === 'fornecedor_upsert') return this.processFornecedorUpsert(job);
    if (job.kind === 'fornecedor_delete') return this.processFornecedorDelete(job);
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
    const erros: string[] = [];

    // ⚠ Réplica desligada NÃO significa "pular o job de venda": dentro dele há
    // um passo que é do FLOW e não do Giga — a baixa de estoque
    // (`erpStepBaixarEstoque` → `decreaseStock`, flow-primeiro). Descartar o
    // job inteiro deixaria a loja vendendo sem baixar peça. Então a baixa roda;
    // a gravação na caixa do Giga e o fechamento de marcados lá, não.
    if (!replicaGigaLigada()) {
      if (!stockDoneAt) {
        const r = await this.pdv.erpStepBaixarEstoque(sale);
        if (!r.ok) {
          return this.reagendarOuFalhar(job, `estoque: ${r.error || 'falha'}`, caixaDoneAt, stockDoneAt);
        }
        stockDoneAt = new Date();
      }
      await (this.prisma as any).erpOutbox.update({
        where: { id: job.id },
        data: {
          status: 'done',
          stockDoneAt,
          doneAt: new Date(),
          lastError: MOTIVO_REPLICA_DESLIGADA,
        },
      });
      return true;
    }

    // ── Passo 1: caixa (NUNCA re-executa depois de done — duplicaria a venda) ──
    if (!caixaDoneAt) {
      const r = await this.pdv.erpStepGravarCaixa(sale, payments, finalMethod);
      if (r.ok) caixaDoneAt = new Date();
      else erros.push(`caixa: ${r.error || 'falha'}`);
    }

    // ── Passo 2: estoque (guard extra via sale.stockDecreasedAt) ──
    // INDEPENDENTE DO PASSO 1 (31/07). Antes era `if (!stockDoneAt && !stepError)`:
    // se a gravação na caixa do GIGA falhasse, a baixa de estoque nem rodava.
    // Como `erpStepBaixarEstoque` chama `decreaseStock`, que é FLOW-PRIMEIRO,
    // isso segurava a baixa no PRÓPRIO FLOW por causa de uma falha na réplica —
    // a loja vendia e o estoque não baixava em lugar nenhum enquanto o Giga
    // estivesse fora. A verdade do Flow não pode ficar refém do espelho.
    // Os dois passos são operações independentes: cada um tem seu próprio
    // marcador de idempotência e o job só encerra quando ambos passam.
    if (!stockDoneAt) {
      const r = await this.pdv.erpStepBaixarEstoque(sale);
      if (r.ok) stockDoneAt = new Date();
      else erros.push(`estoque: ${r.error || 'falha'}`);
    }

    // ── Passo 3: fecha marcados PUXADOS (DELETE da linha MARCADO='SIM') ──
    // Idempotente por natureza (só apaga se ainda for SIM) — sem coluna de
    // progresso; retry re-executa sem risco. Sem isso a peça puxada pro PDV
    // ficava "em marca" pra sempre (bug 21/07 Indaiatuba).
    // Segue atrás dos erros de propósito: é DELETE no Giga, então não adianta
    // tentar quando ele já se mostrou indisponível nos passos acima.
    if (!erros.length) {
      const r = await this.pdv.erpStepFecharMarcados(sale);
      if (!r.ok) erros.push(`marcados: ${r.error || 'falha'}`);
    }

    const stepError = erros.length ? erros.join(' · ') : null;

    if (caixaDoneAt && stockDoneAt && !stepError) {
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
    return this.reagendarOuFalhar(job, stepError as string, caixaDoneAt, stockDoneAt);
  }

  /**
   * Re-agenda o job de venda com backoff, preservando o progresso dos passos
   * (`caixaDoneAt`/`stockDoneAt` são a idempotência: retry nunca duplica a
   * venda na caixa nem a baixa de estoque). No teto de tentativas vira
   * `failed` e espera ação manual.
   */
  private async reagendarOuFalhar(
    job: any,
    stepError: string,
    caixaDoneAt: Date | null,
    stockDoneAt: Date | null,
  ): Promise<boolean> {
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

  /** Réplica de CLIENTE editado/criado no Flow pro Giga (kind cliente_upsert).
   *  O Flow é a fonte (giga_clientes flowIsSource) — aqui só espelha na tabela
   *  `clientes` legada. Idempotente: UPDATE por (CODIGO, LOJA) ou INSERT. */
  private async processClienteUpsert(job: any): Promise<boolean> {
    const p = job.payload || {};
    if (!p.codigo || !p.set) {
      await this.markFailed(job, 'cliente_upsert sem payload válido');
      return false;
    }
    try {
      const r = await this.erp.upsertClienteGiga({ loja: p.loja, codigo: p.codigo, set: p.set });
      if (!r.success) throw new Error(r.error || 'falha na réplica de cliente');
      await (this.prisma as any).erpOutbox.update({
        where: { id: job.id },
        data: { status: 'done', doneAt: new Date(), lastError: null },
      });
      this.logger.log(`[outbox] cliente ${p.loja}/${p.codigo} replicado no Giga`);
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

  /** Re-agenda um job com backoff (ou marca failed no teto). Helper comum. */
  private async requeueOrFail(job: any, err: any): Promise<boolean> {
    const attempts = (job.attempts || 0) + 1;
    const msg = String(err?.message || err).slice(0, 300);
    if (attempts >= ErpOutboxService.MAX_ATTEMPTS) {
      await (this.prisma as any).erpOutbox.update({
        where: { id: job.id },
        data: { status: 'failed', attempts, lastError: msg },
      });
      return false;
    }
    const delayS =
      ErpOutboxService.BACKOFF_S[Math.min(attempts - 1, ErpOutboxService.BACKOFF_S.length - 1)] ??
      ErpOutboxService.BACKOFF_CAP_S;
    await (this.prisma as any).erpOutbox.update({
      where: { id: job.id },
      data: {
        status: 'pending', attempts, lastError: msg,
        nextRetryAt: new Date(Date.now() + Math.min(delayS, ErpOutboxService.BACKOFF_CAP_S) * 1000),
      },
    });
    return false;
  }

  /**
   * Réplica da BAIXA de crediário pro Giga (o recibo já é fonte no Postgres e o
   * espelho de abertas já foi atualizado por write-through). UPDATE PAGO='S' em
   * `movimento` por REGISTRO+CONTROLE — idempotente (rodar 2x é inofensivo).
   * As colunas resolvidas vêm no payload, então NÃO precisa detectar schema.
   */
  private async processCrediarioBaixa(job: any): Promise<boolean> {
    const items = Array.isArray(job.payload?.items) ? job.payload.items : null;
    const columns = job.payload?.columns;
    if (!items?.length || !columns) {
      await this.markFailed(job, 'crediario_baixa sem items/columns');
      return false;
    }
    try {
      let lastErr = '';
      for (const it of items) {
        const r = await (this.erp as any).markCrediarioParcelaPaid({
          registro: it.registro,
          controle: it.controle,
          valorPago: it.valorPago,
          dataPagamento: it.dataPagamento ? new Date(it.dataPagamento) : new Date(),
          juros: Number(it.juros) || 0,
          multa: Number(it.multa) || 0,
          columns,
        });
        if (it.baixaItemId) {
          await (this.prisma as any).crediarioBaixaItem
            .update({ where: { id: it.baixaItemId }, data: { gigaUpdateOk: !!r.success, gigaError: r.error || null } })
            .catch(() => {});
        }
        if (!r.success) lastErr = r.error || 'falha na baixa';
      }
      if (lastErr) throw new Error(lastErr);
      await (this.prisma as any).erpOutbox.update({
        where: { id: job.id },
        data: { status: 'done', doneAt: new Date(), lastError: null },
      });
      this.logger.log(`[outbox] crediario_baixa ${job.saleId}: ${items.length} parcela(s) no Giga`);
      return true;
    } catch (e: any) {
      this.logger.warn(`[outbox] crediario_baixa ${job.saleId} re-agendado: ${e?.message}`);
      return this.requeueOrFail(job, e);
    }
  }

  /**
   * Réplica de GRUPO / SUBGRUPO de produto no Giga.
   *
   * A categoria já existe no Flow (faixa 9000+, numerada pela sequência do
   * Postgres) — este job só espelha. `INSERT IGNORE` com o código já definido
   * torna o retry inofensivo: repetir não duplica nem sobrescreve.
   */
  private async processCategoriaCriar(job: any): Promise<boolean> {
    const tipo = String(job.payload?.tipo || '');
    const codigo = Number(job.payload?.codigo) || 0;
    const nome = String(job.payload?.nome || '');
    const grupo = job.payload?.grupo != null ? Number(job.payload.grupo) : null;

    if (!codigo || !nome || (tipo !== 'grupo' && tipo !== 'subgrupo')) {
      await this.markFailed(job, 'categoria_criar com payload inválido');
      return false;
    }
    if (tipo === 'subgrupo' && !grupo) {
      await this.markFailed(job, 'categoria_criar: subgrupo sem grupo pai');
      return false;
    }

    try {
      await (this.erp as any).replicarCategoriaInline(tipo, { codigo, nome, grupo });
      await this.prisma.erpOutbox.update({
        where: { id: job.id },
        data: { status: 'done', doneAt: new Date(), lastError: null },
      });
      this.logger.log(`[outbox] categoria_criar ${tipo} ${codigo} (${nome}) replicado no Giga`);
      return true;
    } catch (e: any) {
      this.logger.warn(`[outbox] categoria_criar ${tipo} ${codigo} re-agendado: ${e?.message}`);
      return this.requeueOrFail(job, e);
    }
  }

  /**
   * Réplica da TROCA DE BANDEIRA de cartão na tabela `fechamento` do Giga.
   *
   * Idempotente pela própria consulta: o UPDATE localiza a linha pela FORMA
   * ANTIGA. Depois de aplicado, a FORMA já é a nova e o retry não acha nada
   * pra mexer — não há como aplicar duas vezes.
   */
  private async processBandeiraFechamento(job: any): Promise<boolean> {
    const p = job.payload || {};
    if (!p.saleId || !p.storeCode || !p.newBandeira) {
      await this.markFailed(job, 'bandeira_fechamento sem payload completo');
      return false;
    }
    try {
      const r = await (this.erp as any).atualizarBandeiraFechamento({
        saleId: p.saleId,
        storeCode: p.storeCode,
        oldBandeira: p.oldBandeira || '',
        newBandeira: p.newBandeira,
        valor: Number(p.valor) || 0,
      });

      // "Linha não encontrada" aqui quase sempre significa JÁ APLICADO (a FORMA
      // antiga não existe mais) — insistir só gastaria o Giga até as 100
      // tentativas. Encerra registrando o motivo em vez de fingir sucesso.
      if (!r.ok && /não (localizada|encontrada)/i.test(String(r.error || ''))) {
        await this.prisma.erpOutbox.update({
          where: { id: job.id },
          data: { status: 'done', doneAt: new Date(), lastError: `encerrado sem aplicar: ${r.error}` },
        });
        this.logger.warn(`[outbox] bandeira_fechamento ${p.saleId}: ${r.error} — provavelmente já aplicado`);
        return true;
      }
      if (!r.ok) throw new Error(r.error || 'falha no UPDATE');

      await this.prisma.erpOutbox.update({
        where: { id: job.id },
        data: { status: 'done', doneAt: new Date(), lastError: null },
      });
      this.logger.log(`[outbox] bandeira_fechamento ${p.saleId}: ${p.oldBandeira}→${p.newBandeira} no Giga`);
      return true;
    } catch (e: any) {
      this.logger.warn(`[outbox] bandeira_fechamento ${p.saleId} re-agendado: ${e?.message}`);
      return this.requeueOrFail(job, e);
    }
  }

  /**
   * Réplica das parcelas de crediário CRIADAS NO FLOW pra `movimento` do Giga.
   *
   * As parcelas já existem no Postgres com REGISTRO da faixa 900.000.000+ e a
   * cliente já deve — este job só espelha.
   *
   * IDEMPOTÊNCIA: o REGISTRO vem definido pelo Flow e é chave na `movimento`,
   * então `INSERT IGNORE` torna a repetição inofensiva. Cada linha carimba
   * `gigaOk` ao entrar, e o retry recomeça só do que faltou.
   */
  private async processCrediarioCriacao(job: any): Promise<boolean> {
    const saleId = String(job.payload?.saleId || '');
    if (!saleId) {
      await this.markFailed(job, 'crediario_criacao sem saleId');
      return false;
    }

    try {
      const pendentes: any[] = await (this.prisma as any).crediarioParcela.findMany({
        where: { saleId, gigaOk: false, cancelado: false },
        orderBy: { parcela: 'asc' },
      });

      if (!pendentes.length) {
        await this.prisma.erpOutbox.update({
          where: { id: job.id },
          data: { status: 'done', doneAt: new Date(), lastError: null },
        });
        this.logger.log(`[outbox] crediario_criacao ${saleId}: nada pendente (já replicado ou cancelado)`);
        return true;
      }

      const cols = await this.crediarios.detectColumns();
      const r = await (this.erp as any).replicarParcelasNoGiga(
        pendentes.map((p) => ({
          registro: p.registro,
          controle: p.controle,
          codCliente: p.codCliente,
          nomeCliente: p.nomeCliente,
          loja: p.loja,
          dataCompra: p.dataCompra,
          valorCompra: Number(p.valorCompra) || 0,
          parcela: p.parcela,
          totalParcelas: p.totalParcelas,
          vencimento: p.vencimento,
          valorParcela: Number(p.valorParcela) || 0,
          obs: p.obs,
        })),
        cols,
      );

      // Carimba o que ENTROU, mesmo em falha parcial: sem isso o retry
      // reinseriria as mesmas linhas e dependeria só do INSERT IGNORE.
      if (r.aplicados?.length) {
        await (this.prisma as any).crediarioParcela.updateMany({
          where: { registro: { in: r.aplicados } },
          data: { gigaOk: true, gigaAt: new Date(), gigaError: null },
        });
      }

      if (!r.ok) throw new Error(r.error || 'falha ao replicar parcelas');

      await this.prisma.erpOutbox.update({
        where: { id: job.id },
        data: { status: 'done', doneAt: new Date(), lastError: null },
      });
      this.logger.log(`[outbox] crediario_criacao ${saleId}: ${r.aplicados.length} parcela(s) na movimento do Giga`);
      return true;
    } catch (e: any) {
      this.logger.warn(`[outbox] crediario_criacao ${saleId} re-agendado: ${e?.message}`);
      return this.requeueOrFail(job, e);
    }
  }

  /**
   * Réplica do FORNECEDOR cadastrado/editado no Flow.
   *
   * Relê a linha do Postgres em vez de usar o payload: se houve edição enquanto
   * o job esperava na fila, o Giga recebe a versão FINAL, não a do momento em
   * que falhou. `INSERT ... ON DUPLICATE KEY UPDATE` torna o retry inofensivo.
   */
  private async processFornecedorUpsert(job: any): Promise<boolean> {
    const codigo = Number(job.payload?.codigo) || 0;
    if (!codigo) {
      await this.markFailed(job, 'fornecedor_upsert sem codigo');
      return false;
    }
    try {
      const f = await (this.prisma as any).wincredFornecedor.findUnique({ where: { codigo } });
      if (!f) {
        await this.prisma.erpOutbox.update({
          where: { id: job.id },
          data: { status: 'done', doneAt: new Date(), lastError: 'fornecedor não existe mais — réplica descartada' },
        });
        return true;
      }

      await (this.erp as any).replicarFornecedorInline(f);
      await (this.prisma as any).wincredFornecedor.update({ where: { codigo }, data: { gigaOk: true } });

      await this.prisma.erpOutbox.update({
        where: { id: job.id },
        data: { status: 'done', doneAt: new Date(), lastError: null },
      });
      this.logger.log(`[outbox] fornecedor_upsert ${codigo} replicado no Giga`);
      return true;
    } catch (e: any) {
      this.logger.warn(`[outbox] fornecedor_upsert ${codigo} re-agendado: ${e?.message}`);
      return this.requeueOrFail(job, e);
    }
  }

  /**
   * Réplica da EXCLUSÃO de fornecedor no Giga. Sem ela o sync full-replace
   * re-importa o fornecedor apagado no Flow. DELETE por chave é idempotente —
   * retry numa linha que já sumiu não afeta nada.
   */
  private async processFornecedorDelete(job: any): Promise<boolean> {
    const codigo = Number(job.payload?.codigo) || 0;
    if (!codigo) {
      await this.markFailed(job, 'fornecedor_delete sem codigo');
      return false;
    }
    try {
      const r = await (this.erp as any).deleteFornecedorRow(codigo);
      if (!r?.success) throw new Error(r?.error || 'delete falhou');
      await this.prisma.erpOutbox.update({
        where: { id: job.id },
        data: { status: 'done', doneAt: new Date(), lastError: null },
      });
      this.logger.log(`[outbox] fornecedor_delete ${codigo} aplicado no Giga`);
      return true;
    } catch (e: any) {
      this.logger.warn(`[outbox] fornecedor_delete ${codigo} re-agendado: ${e?.message}`);
      return this.requeueOrFail(job, e);
    }
  }

  /** Réplica do ESTORNO de crediário pro Giga. UPDATE PAGO='N' — idempotente. */
  private async processCrediarioEstorno(job: any): Promise<boolean> {
    const items = Array.isArray(job.payload?.items) ? job.payload.items : null;
    const columns = job.payload?.columns;
    if (!items?.length || !columns) {
      await this.markFailed(job, 'crediario_estorno sem items/columns');
      return false;
    }
    try {
      let lastErr = '';
      for (const it of items) {
        const r = await (this.erp as any).markCrediarioParcelaUnpaid({
          registro: it.registro,
          controle: it.controle,
          columns,
        });
        if (!r.success) lastErr = r.error || 'falha no estorno';
      }
      if (lastErr) throw new Error(lastErr);
      await (this.prisma as any).erpOutbox.update({
        where: { id: job.id },
        data: { status: 'done', doneAt: new Date(), lastError: null },
      });
      this.logger.log(`[outbox] crediario_estorno ${job.saleId}: ${items.length} parcela(s) revertidas no Giga`);
      return true;
    } catch (e: any) {
      this.logger.warn(`[outbox] crediario_estorno ${job.saleId} re-agendado: ${e?.message}`);
      return this.requeueOrFail(job, e);
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
