import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { pullGigaLigado } from '../common/replica-giga';
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

  /**
   * Início do espelho da CAIXA DETALHADA — env PRÓPRIA (31/07, incidente do
   * "faturamento do ano anterior R$ 0,00"): a comparação anual da tela de
   * faturamento precisa de 2024, mas esticar a GIGA_MIRROR_FROM esticaria
   * JUNTO o sync HORÁRIO de transferências/caixa diário (que recarrega a
   * janela inteira toda hora) — 2,5 anos do Giga a cada hora, não.
   * O caixa_mov só recarrega 3 dias no incremental; o histórico extra é
   * backfill único (maybeExtendCaixaMovBackfill). Default: GIGA_MIRROR_FROM.
   */
  private caixaMovFrom(): Date {
    const s = (process.env.GIGA_CAIXA_MOV_FROM || '').trim();
    return s ? new Date(`${s}T00:00:00Z`) : this.windowFrom();
  }

  async onModuleInit() {
    // Backfill no boot se o espelho estiver vazio (1º deploy). Fire-and-forget +
    // pequeno atraso pra não travar o startup numa ida ao Giga.
    setTimeout(() => {
      this.maybeBackfill().catch((e) =>
        this.logger.error(`backfill inicial falhou: ${e?.message || e}`),
      );
    }, 8000);
    // CAIXA DETALHADA DO FLOW (28/08): alimenta o espelho com as vendas do
    // PDV logo no boot — o cron horário mantém depois. É o que faz a
    // Inteligência/Faturamento/DRE enxergarem os dias pós-Giga.
    setTimeout(() => {
      this.espelharCaixaMovDoFlow(35).catch((e) =>
        this.logger.error(`caixa_mov do Flow (boot) falhou: ${e?.message || e}`),
      );
    }, 20_000);
    // Backfill da CAIXA DETALHADA (14/07): histórico mensal desde
    // GIGA_MIRROR_FROM quando a tabela está vazia. Atraso maior pra não
    // competir com o boot nem com o backfill acima.
    setTimeout(() => {
      this.maybeBackfillCaixaMov()
        .then(() =>
          // Depois do backfill de tabela-vazia (no-op quando já cheia): estende
          // o histórico pra trás se GIGA_CAIXA_MOV_FROM recuou (ex.: 2024 pra
          // comparação anual do faturamento). Sequencial de propósito — nunca
          // duas cargas pesadas no Giga ao mesmo tempo.
          this.maybeExtendCaixaMovBackfill(),
        )
        .catch((e) => this.logger.error(`backfill caixa_mov falhou: ${e?.message || e}`));
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
      // CAIXA DETALHADA DO FLOW (28/08) — roda SEMPRE, com ou sem Giga:
      // as vendas do PDV entram no espelho e todos os leitores (BI,
      // faturamento, DRE, vendedoras) seguem funcionando sem porte.
      try {
        const nf = await this.espelharCaixaMovDoFlow(35);
        this.logger.log(`espelho giga_caixa_mov (Flow): ${nf} linhas`);
      } catch (e: any) {
        this.logger.error(`caixa_mov do Flow falhou (espelho preservado): ${e?.message || e}`);
        await this.setState('caixa_mov_flow', null, String(e?.message || e));
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

  /**
   * CAIXA DETALHADA A PARTIR DO PRÓPRIO FLOW — o Giga morreu, a caixa segue.
   *
   * `giga_caixa_mov` virou a espinha dorsal de TODOS os relatórios de venda
   * (Inteligência, faturamento, DRE, top REFs/marcas, vendedoras — os
   * *FromMirror do ErpService leem daqui). O Giga parou de alimentá-la em
   * 24/08; sem esta ponte, todo relatório subcontava os dias novos EM
   * SILÊNCIO (o covers() só confere o INÍCIO do período).
   *
   * Regras:
   *  - corte em 25/08/2026: antes disso a tabela é história do Giga e
   *    NINGUÉM toca; deste dia em diante as linhas nascem daqui.
   *  - registro sintético `f<md5(itemId)>` (venda) / `r<md5(itemId)>`
   *    (devolução, valores NEGATIVOS — a caixa do Giga também lançava
   *    negativo). Registros do Giga são numéricos: prefixo nunca colide.
   *  - obsPedido = "flowops-<saleId>" — a MESMA chave híbrida que o
   *    faturamento usa pra contar cupom sem duplicar.
   *  - o delete da janela só alcança linhas com o prefixo sintético.
   *  - São Paulo é UTC-3 fixo (DST acabou em 2019): a DATA da linha é o
   *    dia local da venda, gravado como meia-noite UTC (convenção do sync).
   */
  async espelharCaixaMovDoFlow(days = 35): Promise<number> {
    const CORTE = new Date('2026-08-25T00:00:00Z');
    const agora = new Date();
    const ini = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate() - days));
    const from = ini < CORTE ? CORTE : ini;
    // margem de 12h na leitura: o filtro fino é pela data SP por linha
    const lidoDesde = new Date(from.getTime() - 12 * 3600_000);

    const spDia = (d: Date) => {
      const sp = new Date(d.getTime() - 3 * 3600_000);
      return sp.toISOString().slice(0, 10);
    };
    const spHora = (d: Date) => {
      const sp = new Date(d.getTime() - 3 * 3600_000);
      return sp.toISOString().slice(11, 16);
    };
    const md5 = (s: string) => createHash('md5').update(s).digest('hex');
    const loja2 = (s: any) => String(s || '').replace(/\D/g, '').padStart(2, '0').slice(-2);

    const vendas: any[] = await (this.prisma as any).pdvSale.findMany({
      where: {
        status: 'finalized',
        isTraining: false,
        createdAt: { gte: lidoDesde },
      },
      include: { items: true },
    });
    const devolucoes: any[] = await (this.prisma as any).pdvReturn.findMany({
      where: { isTraining: false, createdAt: { gte: lidoDesde } },
      include: { items: true },
    });

    const fromDia = from.toISOString().slice(0, 10);
    const rows: any[] = [];
    for (const v of vendas) {
      const quando = v.finalizedAt || v.createdAt;
      const dia = spDia(new Date(quando));
      if (dia < fromDia) continue;
      const numero =
        (v.nfceNumber && String(v.nfceNumber).trim()) || String(v.id).slice(0, 8);
      for (const it of v.items || []) {
        rows.push({
          registro: 'f' + md5(String(it.id)).slice(0, 19),
          numero: numero.slice(0, 20),
          codigo: it.sku ? String(it.sku).slice(0, 14) : null,
          data: new Date(dia + 'T00:00:00Z'),
          dataFec: new Date(dia + 'T00:00:00Z'),
          hora: spHora(new Date(quando)),
          descricao: it.descricao ? String(it.descricao).slice(0, 120) : null,
          quantidade: Number(it.qty) || 1,
          valor: it.precoUnit != null ? Number(it.precoUnit) : null,
          valorTotal: it.total != null ? Number(it.total) : null,
          vendedor: (it.sellerName || v.sellerName || null)?.slice?.(0, 40) ?? null,
          vendedora: (it.sellerName || v.sellerName || null)?.slice?.(0, 40) ?? null,
          cliente: v.customerName ? String(v.customerName).slice(0, 80) : null,
          nomeCliente: v.customerName ? String(v.customerName).slice(0, 80) : null,
          cpf: v.customerCpf ? String(v.customerCpf).slice(0, 20) : null,
          loja: loja2(v.storeCode),
          marcado: null,
          fpag: v.paymentMethod ? String(v.paymentMethod).slice(0, 30) : null,
          obsPedido: ('flowops-' + v.id).slice(0, 200),
          valorUnitario: it.precoUnit != null ? Number(it.precoUnit) : null,
        });
      }
    }
    for (const r of devolucoes) {
      const dia = spDia(new Date(r.createdAt));
      if (dia < fromDia) continue;
      for (const it of r.items || []) {
        rows.push({
          registro: 'r' + md5(String(it.id)).slice(0, 19),
          numero: String(r.id).slice(0, 8),
          codigo: it.sku ? String(it.sku).slice(0, 14) : null,
          data: new Date(dia + 'T00:00:00Z'),
          dataFec: new Date(dia + 'T00:00:00Z'),
          hora: spHora(new Date(r.createdAt)),
          descricao: it.descricao ? String(it.descricao).slice(0, 120) : null,
          quantidade: -(Number(it.qty) || 1),
          valor: it.precoUnit != null ? Number(it.precoUnit) : null,
          valorTotal: it.total != null ? -Number(it.total) : null,
          vendedor: null,
          vendedora: null,
          cliente: r.customerName ? String(r.customerName).slice(0, 80) : null,
          nomeCliente: r.customerName ? String(r.customerName).slice(0, 80) : null,
          cpf: r.customerCpf ? String(r.customerCpf).slice(0, 20) : null,
          loja: loja2(r.storeCode),
          marcado: null,
          fpag: 'DEVOLUCAO',
          obsPedido: ('flowret-' + r.id).slice(0, 200),
          valorUnitario: it.precoUnit != null ? Number(it.precoUnit) : null,
        });
      }
    }

    // dedup por registro (itens re-lidos entre janelas)
    const byReg = new Map(rows.map((r) => [r.registro, r]));
    const unique = Array.from(byReg.values());

    await this.prisma.$transaction(async (tx: any) => {
      await tx.gigaCaixaMov.deleteMany({
        where: {
          data: { gte: from },
          OR: [{ registro: { startsWith: 'f' } }, { registro: { startsWith: 'r' } }],
        },
      });
      for (let i = 0; i < unique.length; i += 5000) {
        await tx.gigaCaixaMov.createMany({
          data: unique.slice(i, i + 5000),
          skipDuplicates: true,
        });
      }
    }, { timeout: 120_000 });
    await this.setState('caixa_mov_flow', unique.length, null);
    return unique.length;
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
    // 🔴 Pull do Giga desligado: NÃO tocar a tabela. Com o pool nulo o getter
    // devolve [] em silêncio e o replace atômico viraria DELETE de tudo +
    // INSERT de nada — apagaria inclusive dado RESTAURADO de backup. O que
    // está no espelho é o último retrato do Giga e fica como está.
    if (!pullGigaLigado()) {
      this.logger.log('[syncCaixaMovRange] pulado — pull do Giga desligado (espelho preservado como está)');
      return 0;
    }
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
    const start = this.caixaMovFrom();
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

  /**
   * ESTENDE o histórico do caixa_mov pra trás quando `GIGA_CAIXA_MOV_FROM`
   * recua (31/07: comparação anual do faturamento precisa de 2024). O
   * backfill original só roda com a tabela VAZIA; este roda com ela cheia,
   * puxando SÓ os meses entre a env e o início real do espelho.
   *
   * Idempotente por natureza: depois de estendido, o início real <= env e o
   * método vira no-op no próximo boot. Meses são processados do MAIS RECENTE
   * pro mais antigo — se o deploy reiniciar no meio, o pedaço que falta é o
   * mais velho (e o mais raro de consultar).
   */
  private async maybeExtendCaixaMovBackfill(): Promise<void> {
    const alvo = this.caixaMovFrom();

    // Início REAL do espelho — mesmo critério robusto do erp.service (OFFSET
    // pula linhas com data lixo do incidente DATAALT; MIN cru mentiria aqui).
    const rows: any[] = await (this.prisma as any)
      .$queryRawUnsafe(
        `SELECT data FROM giga_caixa_mov WHERE data IS NOT NULL ORDER BY data ASC OFFSET 100 LIMIT 1`,
      )
      .catch(() => []);
    const inicioReal = rows?.[0]?.data ? new Date(rows[0].data) : null;
    if (!inicioReal) return; // tabela vazia/ilegível — o backfill do boot cuida

    // Primeiro dia do mês do início real — o chunk mensal alinha aqui.
    const fimExtensao = new Date(Date.UTC(inicioReal.getUTCFullYear(), inicioReal.getUTCMonth(), 1));
    if (alvo.getTime() >= fimExtensao.getTime()) return; // já coberto

    this.logger.log(
      `[caixa_mov] extensão de histórico: ${alvo.toISOString().slice(0, 10)} → ${fimExtensao.toISOString().slice(0, 10)} (mensal, do recente pro antigo)`,
    );
    let cursor = fimExtensao;
    let total = 0;
    while (cursor > alvo) {
      const anterior = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1, 1));
      const chunkFrom = anterior > alvo ? anterior : alvo;
      try {
        const n = await this.syncCaixaMovRange(chunkFrom, cursor);
        total += n;
        this.logger.log(`[caixa_mov] extensão ${chunkFrom.toISOString().slice(0, 7)}: ${n} linhas (total ${total})`);
      } catch (e: any) {
        // Um mês que falhou não interrompe os demais — o boot seguinte tenta
        // de novo só o que continuar faltando (idempotência pelo início real).
        this.logger.error(`[caixa_mov] extensão ${chunkFrom.toISOString().slice(0, 7)} falhou: ${e?.message || e}`);
      }
      cursor = chunkFrom;
    }
    this.logger.log(`[caixa_mov] extensão concluída: ${total} linhas`);
  }

  // ── FUNCIONÁRIOS (wincred_funcionarios) ───────────────────────────────────

  private async syncFuncionarios(): Promise<number> {
    // 🔴 Pull do Giga desligado: NÃO tocar a tabela. Com o pool nulo o getter
    // devolve [] em silêncio e o replace atômico viraria DELETE de tudo +
    // INSERT de nada — apagaria inclusive dado RESTAURADO de backup. O que
    // está no espelho é o último retrato do Giga e fica como está.
    if (!pullGigaLigado()) {
      this.logger.log('[syncFuncionarios] pulado — pull do Giga desligado (espelho preservado como está)');
      return 0;
    }
    const rows = await this.erp.getFuncionariosRawAll();
    if (!rows.length) return 0; // Giga vazio/fora → preserva o espelho
    const data = rows.map((r) => ({
      codigo: r.codigo.slice(0, 14),
      nome: r.nome ? r.nome.slice(0, 80) : null,
      apelido: r.apelido ? r.apelido.slice(0, 40) : null,
      loja: r.loja ? r.loja.slice(0, 4) : null,
      inativo: !!r.inativo,
    }));
    // Chave codigo|LOJA (29/07): o código repete entre lojas — dedup só por
    // código descartava a funcionária das outras lojas e o ranking do Giga
    // mostrava o nome errado (Mirela de Campinas virava Pamela).
    const byCodLoja = new Map(data.map((d) => [`${d.codigo}|${d.loja || ''}`, d]));
    const unique = Array.from(byCodLoja.values());
    await this.prisma.$transaction(async (tx: any) => {
      await tx.wincredFuncionario.deleteMany({});
      await tx.wincredFuncionario.createMany({ data: unique, skipDuplicates: true });
    });
    await this.setState('funcionarios', unique.length, null);
    return unique.length;
  }

  private async syncTransferencias(): Promise<number> {
    // 🔴 Pull do Giga desligado: NÃO tocar a tabela. Com o pool nulo o getter
    // devolve [] em silêncio e o replace atômico viraria DELETE de tudo +
    // INSERT de nada — apagaria inclusive dado RESTAURADO de backup. O que
    // está no espelho é o último retrato do Giga e fica como está.
    if (!pullGigaLigado()) {
      this.logger.log('[syncTransferencias] pulado — pull do Giga desligado (espelho preservado como está)');
      return 0;
    }
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
    const rows = pullGigaLigado()
      ? await this.erp.getSalesGrossDailyByStore(this.windowFrom(), this.windowTo())
      : await this.vendaDiariaDoFlow();
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

  /**
   * VENDA POR LOJA E DIA, DAS VENDAS DO PRÓPRIO FLOW — sem Giga.
   *
   * `giga_caixa_diario` alimenta a conta corrente (royalties 8% + marketing
   * 4% por filial), o painel de franquias e os relatórios de caixa. A fonte
   * era a `caixa` do Giga, que é uma CÓPIA das vendas do Flow — e a cópia
   * vinha incompleta: em agosto/2026 marcava R$ 855.145,25 contra
   * R$ 955.881,42 de venda real, e a partir de 25/08 parou de receber
   * qualquer coisa (27/08 fechou o dia em R$ 0,00 com R$ 39,5 mil vendidos).
   * Com o servidor desligado, a cópia vira zero pra sempre.
   *
   * ⚠ Isto MUDA A BASE DO ROYALTY, pra mais: agosto sairia de R$ 102.617,43
   * para R$ 114.705,77 na rede inteira (a maior parte é loja 01, que é
   * matriz e não paga). Foi decisão do dono em 27/08, com o servidor
   * desligando — ou a base é a venda do Flow, ou não existe base.
   *
   * Regra: venda FINALIZADA, sem treinamento, MENOS as devoluções do dia
   * (a caixa do Giga também tinha lançamento negativo — daí a loja 19
   * aparecer com saldo negativo no espelho antigo). Dia e loja no fuso de
   * São Paulo, que é como a loja fecha o caixa.
   *
   * 🔴 E O HISTÓRICO ANTERIOR AO PDV DO FLOW.
   *
   * `syncCaixa` faz `deleteMany({})` e recria a tabela inteira com o que a
   * fonte devolve. Na primeira execução com a fonte nova isso APAGOU o que só
   * o Giga tinha: a tabela caiu de 7.678 para 921 linhas, perdendo de
   * jan/2025 a abr/2026 — o PDV do Flow só começa em 27/04/2026. Erro meu, e
   * o servidor do Giga já estava inacessível pra refazer o pull.
   *
   * O que salva é `giga_caixa_mov` (a caixa DETALHADA, 249 mil linhas desde
   * 02/01/2025, sincronizada até 24/08/2026): ela é dado do próprio Giga e
   * permite remontar o diário por loja e dia. Então a fonte é uma UNIÃO —
   * venda do Flow onde ela existe, caixa detalhada no resto.
   *
   * ⚠️ A remontagem NÃO reproduz número por número o que o diário do Giga
   * trazia: agosto/2026 fecha em R$ 805.423,41 pela detalhada contra
   * R$ 855.145,25 que o diário marcava (~6%). A detalhada é uma janela
   * deslizante de 3 dias com backfill, então tem buraco. Onde a venda do Flow
   * existe ela vence, justamente por ser a fonte completa.
   */
  private async vendaDiariaDoFlow(): Promise<Array<{ loja: string; data: string; bruto: number }>> {
    const from = this.windowFrom();
    const to = this.windowTo();
    const rows: any[] = await (this.prisma as any).$queryRaw`
      WITH venda AS (
        SELECT lpad(regexp_replace(store_code, '[^0-9]', '', 'g'), 2, '0') AS loja,
               ((COALESCE(finalized_at, created_at) AT TIME ZONE 'America/Sao_Paulo'))::date AS dia,
               sum(total) AS valor
          FROM pdv_sales
         WHERE status = 'finalized'
           AND COALESCE(is_training, false) = false
           AND COALESCE(finalized_at, created_at) >= ${from}
           AND COALESCE(finalized_at, created_at) < ${to}
         GROUP BY 1, 2
      ), devolucao AS (
        SELECT lpad(regexp_replace(store_code, '[^0-9]', '', 'g'), 2, '0') AS loja,
               ((created_at AT TIME ZONE 'America/Sao_Paulo'))::date AS dia,
               sum(valor_total) AS valor
          FROM pdv_returns
         WHERE COALESCE(is_training, false) = false
           AND created_at >= ${from}
           AND created_at < ${to}
         GROUP BY 1, 2
      ), flow AS (
        SELECT COALESCE(v.loja, d.loja) AS loja,
               COALESCE(v.dia, d.dia) AS dia,
               COALESCE(v.valor, 0) - COALESCE(d.valor, 0) AS bruto
          FROM venda v
          FULL OUTER JOIN devolucao d ON d.loja = v.loja AND d.dia = v.dia
         WHERE COALESCE(v.loja, d.loja) IS NOT NULL
      ), historico AS (
        -- Caixa DETALHADA do Giga: cobre o que existia antes do PDV do Flow.
        -- Peça MARCADA é reserva, não venda — fica de fora dos dois lados.
        SELECT lpad(regexp_replace(loja, '[^0-9]', '', 'g'), 2, '0') AS loja,
               data::date AS dia,
               sum(valor_total) AS bruto
          FROM giga_caixa_mov
         WHERE COALESCE(upper(marcado), '') <> 'SIM'
           AND data >= ${from}
           AND data < ${to}
         GROUP BY 1, 2
      )
      SELECT COALESCE(f.loja, h.loja) AS loja,
             to_char(COALESCE(f.dia, h.dia), 'YYYY-MM-DD') AS data,
             COALESCE(f.bruto, h.bruto) AS bruto
        FROM flow f
        FULL OUTER JOIN historico h ON h.loja = f.loja AND h.dia = f.dia
       WHERE COALESCE(f.loja, h.loja) IS NOT NULL`;

    return rows.map((r) => ({
      loja: String(r.loja),
      data: String(r.data),
      bruto: Number(r.bruto) || 0,
    }));
  }

  private async syncItens(): Promise<number> {
    // 🔴 Pull do Giga desligado: NÃO tocar a tabela. Com o pool nulo o getter
    // devolve [] em silêncio e o replace atômico viraria DELETE de tudo +
    // INSERT de nada — apagaria inclusive dado RESTAURADO de backup. O que
    // está no espelho é o último retrato do Giga e fica como está.
    if (!pullGigaLigado()) {
      this.logger.log('[syncItens] pulado — pull do Giga desligado (espelho preservado como está)');
      return 0;
    }
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
    // 🔴 Pull do Giga desligado: NÃO tocar a tabela. Com o pool nulo o getter
    // devolve [] em silêncio e o replace atômico viraria DELETE de tudo +
    // INSERT de nada — apagaria inclusive dado RESTAURADO de backup. O que
    // está no espelho é o último retrato do Giga e fica como está.
    if (!pullGigaLigado()) {
      this.logger.log('[syncProdutos] pulado — pull do Giga desligado (espelho preservado como está)');
      return 0;
    }
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
    // desligado por padrão (ESTOQUE_SYNC_GIGA=1 reativa). Quem mantém
    // giga_estoque em dia são os deltas do próprio Flow (bipe, venda, remessa):
    // desde 22/08 o Giga não carimba mais saldo nenhum de volta.
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
