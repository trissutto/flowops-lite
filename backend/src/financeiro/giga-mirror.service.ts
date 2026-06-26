import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

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
    } finally {
      this.syncing = false;
    }
    return this.getState();
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
