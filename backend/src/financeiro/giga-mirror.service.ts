import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { ProductSearchService } from '../product-search/product-search.service';

/**
 * GigaMirrorService — o "ghost" do Giga.
 *
 * É a ÚNICA coisa que fala com o Giga ao vivo. De hora em hora (e no boot, se o
 * espelho estiver vazio) ele copia para o Postgres as duas tabelas que a conta
 * corrente usa, AGREGADAS no grão que a tela consome:
 *   - transferencias  → giga_transferencia (por origem/destino/documento/dia)
 *   - caixa           → giga_caixa_diario  (venda bruta por loja/dia)
 *
 * A conta corrente lê SÓ do Postgres → instantâneo, sem circuit-breaker, sem
 * blip. Se um sync tropeça, ele NÃO toca no espelho (busca o Giga ANTES de
 * escrever, e a escrita é transacional) — o dado antigo fica intacto e a tela
 * nem percebe; tenta de novo no próximo ciclo.
 */
@Injectable()
export class GigaMirrorService implements OnModuleInit {
  private readonly logger = new Logger(GigaMirrorService.name);
  private syncing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  // Janela do espelho: desde GIGA_MIRROR_FROM (default 2025-01-01) até amanhã
  // (buffer de fuso). Histórico antigo não muda; a janela cobre o que a conta
  // corrente pode consultar.
  private windowFrom(): Date {
    const s = (process.env.GIGA_MIRROR_FROM || '2025-01-01').trim();
    return new Date(`${s}T00:00:00Z`);
  }
  private windowTo(): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }

  async onModuleInit() {
    // Backfill no boot se o espelho estiver vazio (1º deploy). Fire-and-forget +
    // pequeno atraso pra não travar o startup numa ida ao Giga.
    setTimeout(() => {
      this.maybeBackfill().catch((e) =>
        this.logger.error(`backfill inicial falhou: ${e?.message || e}`),
      );
    }, 8000);
    // Backfill da CAIXA DETALHADA (14/07): histórico mensal desde
    // GIGA_MIRROR_FROM quando a tabela está vazia. Atraso maior pra não
    // competir com o boot nem com o backfill acima.
    setTimeout(() => {
      this.maybeBackfillCaixaMov().catch((e) =>
        this.logger.error(`backfill caixa_mov falhou: ${e?.message || e}`),
      );
    }, 30_000);
    // Backfill da REF-BASE (13/07): preenche ref_base nas linhas que ainda não
    // têm (coluna nova entra via prisma db push; o sync completo do catálogo só
    // roda a cada ~6h — sem isso a live ficaria horas sem família). UPDATE
    // idempotente 100% no Postgres, mesma regra do ProductSearchService.refBaseOf.
    setTimeout(() => {
      this.backfillRefBase().catch((e) =>
        this.logger.error(`backfill ref_base falhou: ${e?.message || e}`),
      );
    }, 15000);
  }

  private async backfillRefBase() {
    const n: number = await this.prisma.$executeRawUnsafe(`
      UPDATE giga_produto
         SET ref_base = CASE
               WHEN NULLIF(regexp_replace(upper(btrim(ref)), '[^0-9]+$', ''), '') IS NULL
                 THEN upper(btrim(ref))
               ELSE regexp_replace(upper(btrim(ref)), '[^0-9]+$', '')
             END
       WHERE ref IS NOT NULL AND ref_base IS NULL
    `);
    if (n > 0) this.logger.log(`[ref_base] backfill: ${n} linhas preenchidas`);
  }

  private async maybeBackfill() {
    const st = await this.getState();
    if (st.pendente) {
      this.logger.log('espelho do Giga vazio — rodando backfill inicial');
      await this.sync();
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async hourly() {
    this.logger.log('sync horário do espelho do Giga');
    await this.sync();
  }

  /** Sincroniza as duas tabelas. Cada uma é independente: falha numa não
   *  impede a outra, e nenhuma zera o espelho em caso de erro. */
  async sync(opts: { force?: boolean } = {}) {
    if (this.syncing) {
      this.logger.warn('sync do espelho já em andamento — pulando');
      return this.getState();
    }
    this.syncing = true;
    try {
      try {
        const n = await this.syncTransferencias();
        this.logger.log(`espelho giga_transferencia: ${n} linhas`);
      } catch (e: any) {
        this.logger.error(`sync transferencias falhou (espelho preservado): ${e?.message || e}`);
        await this.setState('transferencia', null, String(e?.message || e));
      }
      try {
        const n = await this.syncCaixa();
        this.logger.log(`espelho giga_caixa_diario: ${n} linhas`);
      } catch (e: any) {
        this.logger.error(`sync caixa falhou (espelho preservado): ${e?.message || e}`);
        await this.setState('caixa', null, String(e?.message || e));
      }
      try {
        const n = await this.syncItens();
        this.logger.log(`espelho giga_transferencia_item: ${n} linhas`);
      } catch (e: any) {
        this.logger.error(`sync itens falhou (espelho preservado): ${e?.message || e}`);
        await this.setState('item', null, String(e?.message || e));
      }
      // Catálogo muda devagar → re-sincroniza no máx. a cada 6h (force = botão
      // manual / backfill ignora o throttle).
      if (opts.force || (await this.shouldSyncProduto())) {
        try {
          const n = await this.syncProdutos();
          this.logger.log(`espelho giga_produto: ${n} linhas`);
        } catch (e: any) {
          this.logger.error(`sync produtos falhou (espelho preservado): ${e?.message || e}`);
          await this.setState('produto', null, String(e?.message || e));
        }
      } else {
        this.logger.log('sync produtos pulado (sincronizado há < 6h)');
      }
      // Estoque muda rápido → re-sincroniza TODA hora (full replace).
      try {
        const n = await this.syncEstoque();
        this.logger.log(`espelho giga_estoque: ${n} linhas`);
      } catch (e: any) {
        this.logger.error(`sync estoque falhou (espelho preservado): ${e?.message || e}`);
        await this.setState('estoque', null, String(e?.message || e));
      }
      // CAIXA DETALHADA (14/07): janela deslizante de 3 dias a cada hora.
      // Backfill histórico roda no boot quando a tabela está vazia.
      try {
        const n = await this.syncCaixaMovWindow(3);
        this.logger.log(`espelho giga_caixa_mov (janela 3d): ${n} linhas`);
      } catch (e: any) {
        this.logger.error(`sync caixa_mov falhou (espelho preservado): ${e?.message || e}`);
        await this.setState('caixa_mov', null, String(e?.message || e));
      }
      // FUNCIONÁRIOS (14/07): full replace horário (tabela pequena).
      try {
        const n = await this.syncFuncionarios();
        this.logger.log(`espelho wincred_funcionarios: ${n} linhas`);
      } catch (e: any) {
        this.logger.error(`sync funcionarios falhou (espelho preservado): ${e?.message || e}`);
        await this.setState('funcionarios', null, String(e?.message || e));
      }
    } finally {
      this.syncing = false;
    }
    return this.getState();
  }

  // ── CAIXA DETALHADA (giga_caixa_mov) ──────────────────────────────────────

  private mapCaixaMovRow(r: any) {
    const reg = r.REGISTRO != null ? String(r.REGISTRO).trim() : '';
    if (!reg) return null;
    const d = (v: any) => (v ? new Date(v) : null);
    return {
      registro: reg.slice(0, 20),
      numero: r.NUMERO != null ? String(r.NUMERO).trim().slice(0, 20) : null,
      controle: r.CONTROLE != null ? String(r.CONTROLE).trim().slice(0, 20) : null,
      codigo: r.CODIGO != null ? String(r.CODIGO).trim().slice(0, 14) : null,
      data: d(r.DATA),
      dataFec: d(r.DATAFEC),
      hora: r.HORA != null ? String(r.HORA).trim().slice(0, 10) : null,
      descricao: r.DESCRICAO != null ? String(r.DESCRICAO).trim().slice(0, 120) : null,
      quantidade: r.QUANTIDADE != null ? Number(r.QUANTIDADE) : null,
      valor: r.VALOR != null ? Number(r.VALOR) : null,
      valorTotal: r.VALORTOTAL != null ? Number(r.VALORTOTAL) : null,
      operador: r.OPERADOR != null ? String(r.OPERADOR).trim().slice(0, 30) : null,
      vendedor: r.VENDEDOR != null ? String(r.VENDEDOR).trim().slice(0, 40) : null,
      cliente: r.CLIENTE != null ? String(r.CLIENTE).trim().slice(0, 80) : null,
      loja: r.LOJA != null ? String(r.LOJA).trim().slice(0, 4) : null,
      marcado: r.MARCADO != null ? String(r.MARCADO).trim().slice(0, 4) : null,
      codCliente: r.CODCLIENTE != null ? String(r.CODCLIENTE).trim().slice(0, 20) : null,
      nomeCliente: r.NOMECLIENTE != null ? String(r.NOMECLIENTE).trim().slice(0, 80) : null,
      cpf: r.CPF != null ? String(r.CPF).trim().slice(0, 20) : null,
      vendedora: r.VENDEDORA != null ? String(r.VENDEDORA).trim().slice(0, 40) : null,
      vendedoraCode: r.VENDEDORACODE != null ? String(r.VENDEDORACODE).trim().slice(0, 14) : null,
      fpag: r.FPAG != null ? String(r.FPAG).trim().slice(0, 30) : null,
      obsPedido: r.OBS_PEDIDO != null ? String(r.OBS_PEDIDO).trim().slice(0, 200) : null,
      valorUnitario: r.VALORUNITARIO != null ? Number(r.VALORUNITARIO) : null,
    };
  }

  /** Re-copia [hoje-days, amanhã): pega vendas novas, canceladas e marcados. */
  private async syncCaixaMovWindow(days: number): Promise<number> {
    const from = new Date();
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - days);
    const to = this.windowTo();
    return this.syncCaixaMovRange(from, to);
  }

  private async syncCaixaMovRange(from: Date, to: Date): Promise<number> {
    // Busca o Giga ANTES de tocar o Postgres (falha → espelho intacto).
    const rows = await this.erp.getCaixaMovRows(from, to);
    const data = rows.map((r) => this.mapCaixaMovRow(r)).filter(Boolean) as any[];
    // Dedup por registro (PK) — o Giga não deveria repetir, mas defensivo.
    const byReg = new Map(data.map((d) => [d.registro, d]));
    const unique = Array.from(byReg.values());
    await this.prisma.$transaction(async (tx: any) => {
      await tx.gigaCaixaMov.deleteMany({ where: { data: { gte: from, lt: to } } });
      for (let i = 0; i < unique.length; i += 5000) {
        await tx.gigaCaixaMov.createMany({
          data: unique.slice(i, i + 5000),
          skipDuplicates: true,
        });
      }
    }, { timeout: 120_000 });
    await this.setState('caixa_mov', unique.length, null);
    return unique.length;
  }

  /** Backfill histórico em chunks MENSAIS desde GIGA_MIRROR_FROM. Roda no boot
   *  quando giga_caixa_mov está vazia (fire-and-forget, sequencial, logado). */
  private async maybeBackfillCaixaMov(): Promise<void> {
    const count = await (this.prisma as any).gigaCaixaMov.count().catch(() => -1);
    if (count < 0) return; // erro de leitura — não mexe
    // v2 (14/07): colunas ricas novas (cliente/cpf/vendedora/fpag/valorUnit).
    // Se o espelho foi carregado ANTES da v2, zera e re-backfilla uma vez.
    if (count !== 0) {
      const v2 = await (this.prisma as any).gigaMirrorState
        .findUnique({ where: { tabela: 'caixa_mov_v2' } })
        .catch(() => null);
      if (v2) return; // já está na v2
      this.logger.log('[caixa_mov] upgrade v2 (colunas ricas) — limpando pra re-backfill');
      await (this.prisma as any).gigaCaixaMov.deleteMany({});
    }
    this.logger.log('[caixa_mov] tabela vazia — backfill histórico em chunks mensais');
    const start = this.windowFrom();
    const end = this.windowTo();
    let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    let total = 0;
    while (cursor < end) {
      const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      const chunkTo = next < end ? next : end;
      try {
        const n = await this.syncCaixaMovRange(cursor, chunkTo);
        total += n;
        this.logger.log(`[caixa_mov] backfill ${cursor.toISOString().slice(0, 7)}: ${n} linhas (total ${total})`);
      } catch (e: any) {
        this.logger.error(`[caixa_mov] backfill ${cursor.toISOString().slice(0, 7)} falhou: ${e?.message || e}`);
      }
      cursor = next;
    }
    this.logger.log(`[caixa_mov] backfill concluído: ${total} linhas`);
    // Marca a versão v2 do espelho (colunas ricas) — evita re-backfill em loop.
    await (this.prisma as any).gigaMirrorState
      .upsert({
        where: { tabela: 'caixa_mov_v2' },
        create: { tabela: 'caixa_mov_v2', lastOkAt: new Date(), rows: total },
        update: { lastOkAt: new Date(), rows: total },
      })
      .catch(() => null);
  }

  // ── FUNCIONÁRIOS (wincred_funcionarios) ───────────────────────────────────

  private async syncFuncionarios(): Promise<number> {
    const rows = await this.erp.getFuncionariosRawAll();
    if (!rows.length) return 0; // Giga vazio/fora → preserva o espelho
    const data = rows.map((r) => ({
      codigo: r.codigo.slice(0, 14),
      nome: r.nome ? r.nome.slice(0, 80) : null,
      apelido: r.apelido ? r.apelido.slice(0, 40) : null,
      loja: r.loja ? r.loja.slice(0, 4) : null,
      inativo: !!r.inativo,
    }));
    const byCod = new Map(data.map((d) => [d.codigo, d]));
    const unique = Array.from(byCod.values());
    await this.prisma.$transaction(async (tx: any) => {
      await tx.wincredFuncionario.deleteMany({});
      await tx.wincredFuncionario.createMany({ data: unique, skipDuplicates: true });
    });
    await this.setState('funcionarios', unique.length, null);
    return unique.length;
  }

  private async syncTransferencias(): Promise<number> {
    // Busca o Giga ANTES de mexer no Postgres. Se falhar, joga e o espelho
    // antigo fica intacto.
    const rows = await this.erp.getGigaTransfersDetailed(this.windowFrom(), this.windowTo());
    const data = rows
      .filter((r) => r.origem && r.destino && r.data)
      .map((r) => ({
        ljOrigem: r.origem,
        ljDestino: r.destino,
        controle: r.controle,
        data: new Date(`${r.data}T00:00:00Z`),
        qty: r.qty,
        totalPreco: r.totalPreco,
      }));
    await this.prisma.$transaction(
      async (tx) => {
        await (tx as any).gigaTransferencia.deleteMany({});
        for (let i = 0; i < data.length; i += 2000) {
          await (tx as any).gigaTransferencia.createMany({ data: data.slice(i, i + 2000) });
        }
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
    await this.setState('transferencia', data.length, null);
    return data.length;
  }

  private async syncCaixa(): Promise<number> {
    const rows = await this.erp.getSalesGrossDailyByStore(this.windowFrom(), this.windowTo());
    const data = rows
      .filter((r) => r.loja && r.data)
      .map((r) => ({ loja: r.loja, data: new Date(`${r.data}T00:00:00Z`), bruto: r.bruto }));
    await this.prisma.$transaction(
      async (tx) => {
        await (tx as any).gigaCaixaDiario.deleteMany({});
        for (let i = 0; i < data.length; i += 2000) {
          await (tx as any).gigaCaixaDiario.createMany({ data: data.slice(i, i + 2000) });
        }
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
    await this.setState('caixa', data.length, null);
    return data.length;
  }

  private async syncItens(): Promise<number> {
    const rows = await this.erp.getGigaTransferItems(this.windowFrom(), this.windowTo());
    const data = rows
      .filter((r) => r.controle && r.codigo && r.data)
      .map((r) => ({
        ljOrigem: r.origem,
        ljDestino: r.destino,
        controle: r.controle,
        codigo: r.codigo,
        descricao: r.descricao || null,
        data: new Date(`${r.data}T00:00:00Z`),
        qty: r.qty,
        totalPreco: r.totalPreco,
      }));
    await this.prisma.$transaction(
      async (tx) => {
        await (tx as any).gigaTransferenciaItem.deleteMany({});
        for (let i = 0; i < data.length; i += 2000) {
          await (tx as any).gigaTransferenciaItem.createMany({ data: data.slice(i, i + 2000) });
        }
      },
      { timeout: 180_000, maxWait: 20_000 },
    );
    await this.setState('item', data.length, null);
    return data.length;
  }

  /** true se o catálogo nunca sincronizou OK ou já passou de 6h. */
  private async shouldSyncProduto(): Promise<boolean> {
    const st = await (this.prisma as any).gigaMirrorState.findUnique({ where: { tabela: 'produto' } });
    if (!st?.lastOkAt) return true;
    return Date.now() - new Date(st.lastOkAt).getTime() > 6 * 60 * 60 * 1000;
  }

  private async syncProdutos(): Promise<number> {
    const rows = await this.erp.getGigaProdutos();
    const data = rows.map((r) => ({
      codigo: r.codigo,
      ref: r.ref || null,
      refBase: r.ref ? ProductSearchService.refBaseOf(r.ref) : null,
      descricao: r.descricao || null,
      cor: r.cor || null,
      tamanho: r.tamanho || null,
      grupo: r.grupo || null,
      ncm: r.ncm || null,
      vendaUn: r.vendaUn || 0,
    }));
    await this.prisma.$transaction(
      async (tx) => {
        await (tx as any).gigaProduto.deleteMany({});
        for (let i = 0; i < data.length; i += 2000) {
          await (tx as any).gigaProduto.createMany({ data: data.slice(i, i + 2000) });
        }
      },
      { timeout: 180_000, maxWait: 20_000 },
    );
    await this.setState('produto', data.length, null);
    return data.length;
  }

  private async syncEstoque(): Promise<number> {
    // CONSTITUIÇÃO 14/07: Flow é a fonte do estoque — o full Giga→Flow fica
    // desligado por padrão (ESTOQUE_SYNC_GIGA=1 reativa). O write-through das
    // operações do Flow mantém giga_estoque em dia.
    if (String(process.env.ESTOQUE_SYNC_GIGA ?? '').trim() !== '1') {
      this.logger.log('[estoque] sync Giga→Flow desligado — Flow é a fonte');
      return 0;
    }
    const rows = await this.erp.getGigaEstoque();
    // Vazio = Giga indisponível (sempre há estoque na rede) → NÃO zera o espelho.
    if (!rows.length) throw new Error('getGigaEstoque vazio — espelho preservado');
    const data = rows.map((r) => ({ codigo: r.codigo, loja: r.loja, estoque: r.estoque }));
    await this.prisma.$transaction(
      async (tx) => {
        await (tx as any).gigaEstoque.deleteMany({});
        for (let i = 0; i < data.length; i += 2000) {
          await (tx as any).gigaEstoque.createMany({ data: data.slice(i, i + 2000) });
        }
      },
      { timeout: 180_000, maxWait: 20_000 },
    );
    await this.setState('estoque', data.length, null);
    return data.length;
  }

  private async setState(tabela: string, rows: number | null, error: string | null) {
    const now = new Date();
    const okPatch = error
      ? { lastError: String(error).slice(0, 500) }
      : { lastOkAt: now, lastError: null, ...(rows != null ? { rows } : {}) };
    await (this.prisma as any).gigaMirrorState.upsert({
      where: { tabela },
      create: {
        tabela,
        lastSyncAt: now,
        lastOkAt: error ? null : now,
        lastError: error ? String(error).slice(0, 500) : null,
        rows: rows ?? 0,
      },
      update: { lastSyncAt: now, ...okPatch },
    });
  }

  /** Estado consolidado do espelho (pra tela mostrar "sincronizado às HH:MM"). */
  async getState(): Promise<{
    lastOkAt: Date | null;
    pendente: boolean;
    erro: string | null;
    transferenciaAt: Date | null;
    caixaAt: Date | null;
    estoqueRows: number | null;
    estoqueAt: Date | null;
    syncing: boolean;
  }> {
    const states = await (this.prisma as any).gigaMirrorState.findMany();
    const by: Record<string, any> = {};
    for (const s of states as any[]) by[s.tabela] = s;
    const t = by['transferencia'];
    const c = by['caixa'];
    const e = by['estoque'];
    const oks = [t?.lastOkAt, c?.lastOkAt].filter(Boolean).map((d: any) => new Date(d).getTime());
    return {
      lastOkAt: oks.length ? new Date(Math.max(...oks)) : null,
      pendente: !t?.lastOkAt || !c?.lastOkAt,
      erro: t?.lastError || c?.lastError || null,
      transferenciaAt: t?.lastOkAt ?? null,
      caixaAt: c?.lastOkAt ?? null,
      estoqueRows: e?.rows ?? null,
      estoqueAt: e?.lastOkAt ?? null,
      syncing: this.syncing,
    };
  }
}
