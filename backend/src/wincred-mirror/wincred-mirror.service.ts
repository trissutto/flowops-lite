import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { ProductNativeService } from '../product-native/product-native.service';

/**
 * WincredMirrorService — MUSEU PARCIAL desde 09/2026.
 *
 * A classe nasceu pra IMPORTAR 6 tabelas de catálogo (produtos, estoque,
 * grupos, subgrupos, fornecedores, codigos) do MySQL de um ERP externo pro
 * Postgres do Flow. Esse ERP foi desligado em 27/08/2026: os métodos de
 * importação continuam existindo, mas o pool nunca é criado, então eles
 * respondem erro em vez de sumir da tela. Os crons de 10min/3h estão atrás de
 * `pullGigaLigado()` e são no-op.
 *
 * QUEM ALIMENTA OS ESPELHOS HOJE: o próprio Flow. `wincred_produtos` é escrito
 * pelo cadastro (`product-registration`) e pelo editor (`products-editor`);
 * `wincred_estoque` é mantido pelo delta de cada movimento
 * (`ErpService.mirrorStockApplyDelta`). Ninguém "repuxa" nada de lugar nenhum.
 *
 * O QUE AINDA VALE AQUI:
 *   - `status()` — contagem e idade de cada tabela no Postgres (a coluna do
 *     ERP antigo vem sempre vazia);
 *   - o ÚLTIMO passo do `startSyncAllBackground` — `produtoNativo.syncIncremental()`,
 *     que é INSERT..SELECT dentro do próprio Postgres e atualiza a tabela
 *     nativa `product` que o bipe do PDV lê. É o único passo do "Sync
 *     Completo" que faz alguma coisa, e roda em segundos.
 */
@Injectable()
export class WincredMirrorService {
  private readonly logger = new Logger(WincredMirrorService.name);
  private readonly RETRY_MAX = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly produtoNativo: ProductNativeService,
  ) {}

  /** Pausa em ms — usado entre batches pra liberar conexao Railway */
  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Normaliza CODIGO do Wincred pra forma numerica padronizada.
   * '5387373' -> '5387373'
   * '0005387373' -> '5387373'
   * '5387373 ' -> '5387373'
   * '0' / '' / null -> null
   * 'ABC123' -> null (nao numerico)
   */
  private normalizeCodigo(raw: any): string | null {
    if (raw == null) return null;
    const s = String(raw).replace(/\D/g, '');
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
    return String(n);
  }

  /**
   * Retry generico em caso de conexao fechada (Railway derruba pool em syncs longos).
   * Backoff exponencial: 200ms, 600ms, 1.5s, 4s, 10s.
   */
  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: any = null;
    const delays = [0, 200, 600, 1500, 4000, 10000];
    for (let i = 0; i <= this.RETRY_MAX; i++) {
      if (i > 0) await this.sleep(delays[i] || 10000);
      try {
        return await fn();
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message || '').toLowerCase();
        const isConnErr =
          msg.includes('server has closed') ||
          msg.includes('connection terminated') ||
          msg.includes('connection lost') ||
          msg.includes('econnreset') ||
          msg.includes('etimedout');
        if (!isConnErr) throw e;
        this.logger.warn(`[retry] ${label} attempt ${i + 1}/${this.RETRY_MAX + 1}: ${e.message}`);
      }
    }
    throw lastErr;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  STATUS
  // ─────────────────────────────────────────────────────────────────────

  async status(): Promise<{
    tables: Array<{
      name: string;
      countPostgres: number;
      countWincred: number | null;
      lastSyncedAt: Date | null;
      ageMin: number | null;
    }>;
  }> {
    const tables = [
      { name: 'produtos', table: 'wincred_produtos', mysql: 'produtos' },
      { name: 'estoque', table: 'wincred_estoque', mysql: 'estoque' },
      { name: 'grupos', table: 'wincred_grupos', mysql: 'grupos' },
      { name: 'subgrupos', table: 'wincred_subgrupos', mysql: 'subgrupos' },
      { name: 'fornecedores', table: 'wincred_fornecedores', mysql: 'fornecedores' },
      { name: 'codigos', table: 'wincred_codigos', mysql: 'codigos' },
    ];

    const result = await Promise.all(
      tables.map(async (t) => {
        // Count Postgres
        let countPg = 0;
        let lastSync: Date | null = null;
        try {
          const rows: any[] = await this.prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS c, MAX(synced_at) AS last FROM "${t.table}"`,
          );
          countPg = Number(rows[0]?.c ?? 0);
          lastSync = rows[0]?.last ? new Date(rows[0].last) : null;
        } catch (e) {
          this.logger.warn(`status PG ${t.name}: ${(e as Error).message}`);
        }
        // Count MySQL Wincred
        let countMy: number | null = null;
        try {
          countMy = await this.countMysql(t.mysql);
        } catch (e) {
          this.logger.warn(`status MY ${t.name}: ${(e as Error).message}`);
        }
        const ageMin = lastSync
          ? Math.floor((Date.now() - lastSync.getTime()) / 60000)
          : null;
        return {
          name: t.name,
          countPostgres: countPg,
          countWincred: countMy,
          lastSyncedAt: lastSync,
          ageMin,
        };
      }),
    );

    return { tables: result };
  }

  private async countMysql(table: string): Promise<number> {
    const pool: any = (this.erp as any).pool;
    if (!pool) throw new Error('importacao encerrada: o sistema antigo foi desligado em 27/08/2026 — nao ha nada pra importar');
    // (02/07) Filtro PLUS_SIZE REMOVIDO — o espelho agora cobre o catálogo
    // INTEIRO. Motivo: bipe/busca/consulta leem do espelho e produtos
    // não-plus (gravatas, acessórios) caíam no fallback Giga em todo acesso.
    const [rows] = await pool.query({ sql: `SELECT COUNT(*) AS c FROM \`${table}\``, timeout: 120_000 });
    return Number((rows as any[])[0]?.c ?? 0);
  }

  // ─────────────────────────────────────────────────────────────────────
  //  SYNC ALL — EM BACKGROUND (02/07)
  //
  //  O botão "Sync Completo" esperava o sync inteiro NA MESMA requisição
  //  HTTP. Com o catálogo completo (352k linhas) isso estoura o timeout do
  //  proxy (~5min): o navegador recebia "Failed to fetch", o processo
  //  morria no meio e clique repetido disparava DOIS syncs concorrentes.
  //  Agora: dispara em background (responde "started" na hora), guarda o
  //  progresso em memória (GET sync/progress) e trava clique duplo.
  // ─────────────────────────────────────────────────────────────────────

  private bgState: {
    running: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    current: string | null;
    results: SyncResult[];
    error: string | null;
  } = { running: false, startedAt: null, finishedAt: null, current: null, results: [], error: null };

  // ── TRAVA ANTI-OVERLAP por tabela (14/07) ─────────────────────────────
  // Full horário, incremental de 10min, botão da tela e full das 3h rodavam
  // SEM trava entre si: dois rebuilds sobrepostos (ou um rebuild morto por
  // deploy no meio) deixavam o espelho pela metade — 782/283k em 11/07,
  // 142k→28k em 14/07. Railway roda 1 instância → boolean em memória basta.
  private syncLocks = new Set<string>();
  private acquireLock(name: string): boolean {
    if (this.syncLocks.has(name)) return false;
    this.syncLocks.add(name);
    return true;
  }
  private releaseLock(name: string) {
    this.syncLocks.delete(name);
  }

  getSyncProgress() {
    return this.bgState;
  }

  startSyncAllBackground(): { started: boolean; alreadyRunning: boolean } {
    if (this.bgState.running) return { started: false, alreadyRunning: true };
    this.bgState = {
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      current: null,
      results: [],
      error: null,
    };
    void (async () => {
      const steps: Array<[string, () => Promise<SyncResult>]> = [
        ['grupos', () => this.syncGrupos()],
        ['subgrupos', () => this.syncSubgrupos()],
        ['fornecedores', () => this.syncFornecedores()],
        ['codigos', () => this.syncCodigos()],
        ['produtos', () => this.syncProdutos()],
        ['estoque', () => this.syncEstoque()],
        // NATIVA por último (03/08, caso BMM-100): com PRODUCT_NATIVE_READS a
        // Consultar/bipe leem a tabela product — sincronizar só wincred_* e
        // parar aqui consertava a tabela que ninguém lê. O incremental com
        // anti-join também puxa linhas ausentes, então cobre REF antiga.
        ['produto-nativo', async () => {
          const r = await this.produtoNativo.syncIncremental();
          return { table: 'produto-nativo', success: true, processed: r.upserted, durationMs: r.ms } as SyncResult;
        }],
      ];
      try {
        for (const [name, fn] of steps) {
          this.bgState.current = name;
          const r = await fn();
          this.bgState.results.push(r);
          if (!r.success) {
            this.logger.error(`[sync-bg] etapa ${name} falhou: ${r.error}`);
          }
        }
      } catch (e: any) {
        this.bgState.error = e?.message || String(e);
        this.logger.error(`[sync-bg] abortado: ${this.bgState.error}`);
      } finally {
        this.bgState.running = false;
        this.bgState.current = null;
        this.bgState.finishedAt = new Date().toISOString();
      }
    })();
    return { started: true, alreadyRunning: false };
  }

  async syncAll(): Promise<{
    total: SyncResult[];
    durationMs: number;
  }> {
    const t0 = Date.now();
    const results: SyncResult[] = [];
    // Ordem: tabelas pequenas primeiro (rapido feedback)
    results.push(await this.syncGrupos());
    results.push(await this.syncSubgrupos());
    results.push(await this.syncFornecedores());
    results.push(await this.syncCodigos());
    results.push(await this.syncProdutos());
    results.push(await this.syncEstoque());
    return { total: results, durationMs: Date.now() - t0 };
  }

  // ─────────────────────────────────────────────────────────────────────
  //  SYNC PRODUTOS (full)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * EAN no espelho (14/07): a coluna de código de barras varia por instalação
   * do Wincred (EAN13/EAN/CODBARRAS/...). Sonda uma vez qual existe e inclui
   * no SELECT dos syncs como EAN_MIRROR. Sem coluna → ean fica null (o
   * fallback Giga do bipe por EAN continua cobrindo).
   */
  private eanColCache: { col: string | null; at: number } | null = null;
  private async detectEanColumn(pool: any): Promise<string | null> {
    const now = Date.now();
    if (this.eanColCache && now - this.eanColCache.at < 6 * 3600_000) return this.eanColCache.col;
    let col: string | null = null;
    try {
      const [cols] = await pool.query(`SHOW COLUMNS FROM produtos`);
      const names = new Set((cols as any[]).map((c) => String(c.Field || '').toUpperCase()));
      for (const cand of ['EAN13', 'EAN', 'CODBARRAS', 'CODIGOBARRAS', 'COD_BARRAS', 'CODIGO_BARRAS']) {
        if (names.has(cand)) { col = cand; break; }
      }
    } catch { /* segue sem EAN */ }
    this.eanColCache = { col, at: now };
    return col;
  }

  async syncProdutos(): Promise<SyncResult> {
    const t0 = Date.now();
    const pool: any = (this.erp as any).pool;
    if (!pool) return { table: 'produtos', success: false, processed: 0, durationMs: 0, error: 'importacao encerrada: o sistema antigo foi desligado em 27/08/2026 — nao ha nada pra importar' };
    if (!this.acquireLock('produtos')) {
      this.logger.warn('[produtos] sync já em andamento — pulando (trava anti-overlap)');
      return { table: 'produtos', success: false, processed: 0, durationMs: 0, error: 'sync de produtos já em andamento' };
    }

    try {
      const total = await this.countMysql('produtos');

      // (02/07) Catálogo INTEIRO sem filtro = 352k linhas. A paginação por
      // OFFSET que servia pras 58k plus-size vira ARMADILHA nesse volume:
      // cada batch do fundo re-varre a tabela (OFFSET 300k+) e o sync levava
      // dezenas de minutos/estourava timeout. Trocada por LEITURA ÚNICA —
      // mesma estratégia do GigaMirrorService.getGigaProdutos, que puxa essa
      // MESMA tabela inteira de hora em hora há semanas sem incidente
      // (~350k linhas ≈ 1-2min de SELECT + inserts locais).
      this.logger.log(`[produtos] iniciando full sync — ${total} linhas no Wincred (leitura única)`);
      const eanCol = await this.detectEanColumn(pool);
      const eanSelect = eanCol ? `, \`${eanCol}\` AS EAN_MIRROR` : '';
      const [rows] = await pool.query({
        sql: `SELECT CODIGO, GRUPO, NOMEGRUPO, DESCRICAOPDV, DESCRICAOCOMPLETA,
                  CUSTO, VENDAUN, FORNECEDOR, UNIDADE, ESTOQUE, MARGEM, DATAALT,
                  SUBGRUPO, COR, TAMANHO, MARCA, REF, CODFORNECEDOR, OPERADOR,
                  CONFPRECO, TRIBUTO, NCM, PLUS_SIZE, ID, CATEGORIAS,
                  COD_PIS, ALIQ_PIS, COD_COFINS, ALIQ_COFINS, ALIQ_ICMS,
                  CST, CSOSN, CFOP${eanSelect}
             FROM produtos`,
        timeout: 300_000,
      });
      this.logger.log(`[produtos] SELECT completo: ${(rows as any[]).length} linhas em ${Date.now() - t0}ms`);

      // Dedup por CODIGO (Wincred nao tem PK em produtos — pode duplicar)
      const seen = new Set<string>();
      const data = (rows as any[])
        .filter((r) => {
          const c = this.normalizeCodigo(r.CODIGO);
          if (!c || seen.has(c)) return false;
          seen.add(c);
          return true;
        })
        .map((r) => ({
            codigo: this.normalizeCodigo(r.CODIGO)!,
            grupo: r.GRUPO != null ? Number(r.GRUPO) : null,
            nomeGrupo: r.NOMEGRUPO || null,
            descricaoPdv: r.DESCRICAOPDV || null,
            descricaoCompleta: r.DESCRICAOCOMPLETA || null,
            custo: r.CUSTO != null ? r.CUSTO : null,
            vendaUn: r.VENDAUN != null ? r.VENDAUN : null,
            fornecedor: r.FORNECEDOR || null,
            unidade: r.UNIDADE || null,
            estoque: r.ESTOQUE != null ? Number(r.ESTOQUE) : null,
            margem: r.MARGEM != null ? r.MARGEM : null,
            dataAlt: r.DATAALT ? new Date(r.DATAALT) : null,
            subgrupo: r.SUBGRUPO != null ? Number(r.SUBGRUPO) : null,
            cor: r.COR || null,
            tamanho: r.TAMANHO || null,
            marca: r.MARCA || null,
            ref: r.REF || null,
            codFornecedor: r.CODFORNECEDOR != null ? Number(r.CODFORNECEDOR) : null,
            operador: r.OPERADOR || null,
            confPreco: r.CONFPRECO || null,
            tributo: r.TRIBUTO || null,
            ncm: r.NCM || null,
            plusSize: r.PLUS_SIZE != null ? Number(r.PLUS_SIZE) : null,
            idWincred: r.ID != null ? BigInt(r.ID) : null,
            categorias: r.CATEGORIAS || null,
            codPis: r.COD_PIS || null,
            aliqPis: r.ALIQ_PIS != null ? r.ALIQ_PIS : null,
            codCofins: r.COD_COFINS || null,
            aliqCofins: r.ALIQ_COFINS != null ? r.ALIQ_COFINS : null,
            aliqIcms: r.ALIQ_ICMS != null ? r.ALIQ_ICMS : null,
            cst: r.CST || null,
            csosn: r.CSOSN || null,
            cfop: r.CFOP != null ? Number(r.CFOP) : null,
            ean: r.EAN_MIRROR ? String(r.EAN_MIRROR).trim().slice(0, 20) || null : null,
          }));

      // REPLACE ATÔMICO (14/07): antes era TRUNCATE + inserts — janela em que
      // o espelho ficava vazio/parcial (bipe no fallback Giga), e deploy no
      // meio deixava o catálogo pela metade até o próximo full. Agora DELETE +
      // inserts numa transação única: leitores veem o catálogo antigo até o
      // commit; falha/restart no meio dá rollback e nada se perde.
      if (!data.length) throw new Error('SELECT produtos veio vazio — espelho preservado');
      await this.prisma.$transaction(
        async (tx) => {
          await (tx as any).wincredProduto.deleteMany({});
          const CHUNK = 1000;
          for (let i = 0; i < data.length; i += CHUNK) {
            await (tx as any).wincredProduto.createMany({
              data: data.slice(i, i + CHUNK),
              skipDuplicates: true,
            });
          }
        },
        { timeout: 300_000, maxWait: 30_000 },
      );

      const durationMs = Date.now() - t0;
      this.logger.log(`[produtos] OK — ${data.length} linhas em ${durationMs}ms (replace atômico)`);
      return { table: 'produtos', success: true, processed: data.length, durationMs };
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.error(`[produtos] FALHOU (espelho antigo preservado): ${msg}`);
      return { table: 'produtos', success: false, processed: 0, durationMs: Date.now() - t0, error: msg };
    } finally {
      this.releaseLock('produtos');
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  SYNC ESTOQUE (full)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * NÃO EXISTE MAIS IMPORTAÇÃO DE ESTOQUE DE FORA — a tabela `wincred_estoque`
   * é do FLOW.
   *
   * Constituição 14/07 (dono): o Flow é a FONTE do estoque. Quem mantém a
   * tabela em dia são os movimentos do próprio sistema — bipe da separação,
   * venda do PDV, entrada de remessa, realinhamento, devolução. O nome
   * `wincred_` é herança: a tabela nasceu como cópia de um ERP externo e
   * continuou com o nome depois que virou a verdade.
   *
   * O que ficava aqui era um FULL que lia o ERP legado e carimbava o saldo
   * DELE por cima. Vivia desligado por env desde 14/07 (quando o Flow virou a
   * fonte); em 22/08 o botão manual deixou de furar a trava, e em 27/08/2026
   * o servidor daquele ERP saiu do ar. Não há de onde puxar.
   *
   * O método continua existindo (o `syncAll` e o botão da tela listam
   * "estoque" entre as tabelas) e responde a verdade em vez de sumir da lista.
   * A mensagem começa com "Não se aplica" de propósito: a tela pinta a linha
   * de verde pelo `success`, e um texto sem essa ressalva pareceria sync feito.
   */
  async syncEstoque(_force = false): Promise<SyncResult> {
    return {
      table: 'estoque',
      success: true,
      processed: 0,
      durationMs: 0,
      error: 'Não se aplica — o estoque não é importado: o Flow é a fonte, e os movimentos do próprio sistema mantêm a tabela em dia. Se um saldo estiver errado, conte a peça e corrija no Flow; peça que sumiu vira registro em Peças extraviadas.',
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  //  SYNC INCREMENTAL — produtos por DATAALT, estoque por delta de produtos
  //  Roda a cada 10min via cron. Custo: ~poucos segundos (so o que mudou).
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Le ultimo run incremental de uma tabela.
   * Retorna null se nunca rodou (forca primeira leitura ampla — 24h).
   */
  private async getSyncState(tabela: string): Promise<{ lastDataAlt: Date | null; lastRunAt: Date | null }> {
    try {
      const rows: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT last_data_alt AS "lastDataAlt", last_run_at AS "lastRunAt"
           FROM wincred_sync_state WHERE tabela = $1 LIMIT 1`,
        tabela,
      );
      const r = rows[0];
      return {
        lastDataAlt: r?.lastDataAlt ? new Date(r.lastDataAlt) : null,
        lastRunAt: r?.lastRunAt ? new Date(r.lastRunAt) : null,
      };
    } catch {
      return { lastDataAlt: null, lastRunAt: null };
    }
  }

  /** Grava estado do sync — upsert. */
  private async setSyncState(
    tabela: string,
    // 'OFF' (31/07): terceiro estado, distinto de OK e de FAIL — o sync não
    // rodou porque foi DESLIGADO por decisão, não porque falhou nem porque
    // deu certo. Sem ele, um sync desligado se disfarçaria de sync saudável.
    state: { lastDataAlt?: Date | null; rowCount: number; status: 'OK' | 'FAIL' | 'OFF'; error?: string | null },
  ): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO wincred_sync_state (tabela, last_run_at, last_data_alt, last_row_count, last_status, last_error)
         VALUES ($1, NOW(), $2, $3, $4, $5)
         ON CONFLICT (tabela) DO UPDATE SET
           last_run_at = NOW(),
           last_data_alt = COALESCE(EXCLUDED.last_data_alt, wincred_sync_state.last_data_alt),
           last_row_count = EXCLUDED.last_row_count,
           last_status = EXCLUDED.last_status,
           last_error = EXCLUDED.last_error`,
        tabela,
        state.lastDataAlt ?? null,
        state.rowCount,
        state.status,
        state.error ?? null,
      );
    } catch (e) {
      this.logger.warn(`[sync-state] falha gravar ${tabela}: ${(e as Error).message}`);
    }
  }

  /**
   * Sync incremental — pega produtos modificados desde ultimo run e
   * re-sincroniza estoque APENAS desses produtos.
   *
   * Janela default: 24h se for primeiro run, senao desde lastDataAlt.
   * Custo tipico: 50-500 linhas / 1-5s no Wincred.
   */
  async syncIncremental(): Promise<{ produtosAtualizados: number; estoqueAtualizado: number; durationMs: number; janelaInicio: Date }> {
    const t0 = Date.now();
    const pool: any = (this.erp as any).pool;
    if (!pool) {
      this.logger.warn('[incremental] pulado — importacao encerrada (sistema antigo desligado em 27/08/2026)');
      return { produtosAtualizados: 0, estoqueAtualizado: 0, durationMs: 0, janelaInicio: new Date() };
    }

    // Determina janela: ultimo DATAALT ou 24h atras
    const state = await this.getSyncState('produtos');
    const janelaInicio = state.lastDataAlt || new Date(Date.now() - 24 * 60 * 60 * 1000);
    const isoDate = janelaInicio.toISOString().slice(0, 10);

    this.logger.log(`[incremental] janela DATAALT >= ${isoDate}`);

    // ── 1. Produtos modificados ──
    let produtosAtualizados = 0;
    let maxDataAlt: Date | null = null;
    try {
      const eanColInc = await this.detectEanColumn(pool);
      const eanSelectInc = eanColInc ? `, \`${eanColInc}\` AS EAN_MIRROR` : '';
      const [rows] = await pool.query(
        {
          sql: `SELECT CODIGO, GRUPO, NOMEGRUPO, DESCRICAOPDV, DESCRICAOCOMPLETA,
                CUSTO, VENDAUN, FORNECEDOR, UNIDADE, ESTOQUE, MARGEM, DATAALT,
                SUBGRUPO, COR, TAMANHO, MARCA, REF, CODFORNECEDOR, OPERADOR,
                CONFPRECO, TRIBUTO, NCM, PLUS_SIZE, ID, CATEGORIAS,
                COD_PIS, ALIQ_PIS, COD_COFINS, ALIQ_COFINS, ALIQ_ICMS,
                CST, CSOSN, CFOP${eanSelectInc}
           FROM produtos
          WHERE DATAALT IS NOT NULL
            AND DATAALT >= ?
          ORDER BY DATAALT`,
          timeout: 120_000,
        },
        [isoDate],
      );

      const list = rows as any[];
      this.logger.log(`[incremental] ${list.length} produtos modificados`);

      for (const r of list) {
        const codigo = this.normalizeCodigo(r.CODIGO);
        if (!codigo) continue;

        const data = {
          grupo: r.GRUPO != null ? Number(r.GRUPO) : null,
          nomeGrupo: r.NOMEGRUPO || null,
          descricaoPdv: r.DESCRICAOPDV || null,
          descricaoCompleta: r.DESCRICAOCOMPLETA || null,
          custo: r.CUSTO != null ? r.CUSTO : null,
          vendaUn: r.VENDAUN != null ? r.VENDAUN : null,
          fornecedor: r.FORNECEDOR || null,
          unidade: r.UNIDADE || null,
          estoque: r.ESTOQUE != null ? Number(r.ESTOQUE) : null,
          margem: r.MARGEM != null ? r.MARGEM : null,
          dataAlt: r.DATAALT ? new Date(r.DATAALT) : null,
          subgrupo: r.SUBGRUPO != null ? Number(r.SUBGRUPO) : null,
          cor: r.COR || null,
          tamanho: r.TAMANHO || null,
          marca: r.MARCA || null,
          ref: r.REF || null,
          codFornecedor: r.CODFORNECEDOR != null ? Number(r.CODFORNECEDOR) : null,
          operador: r.OPERADOR || null,
          confPreco: r.CONFPRECO || null,
          tributo: r.TRIBUTO || null,
          ncm: r.NCM || null,
          plusSize: r.PLUS_SIZE != null ? Number(r.PLUS_SIZE) : null,
          idWincred: r.ID != null ? BigInt(r.ID) : null,
          categorias: r.CATEGORIAS || null,
          codPis: r.COD_PIS || null,
          aliqPis: r.ALIQ_PIS != null ? r.ALIQ_PIS : null,
          codCofins: r.COD_COFINS || null,
          aliqCofins: r.ALIQ_COFINS != null ? r.ALIQ_COFINS : null,
          aliqIcms: r.ALIQ_ICMS != null ? r.ALIQ_ICMS : null,
          cst: r.CST || null,
          csosn: r.CSOSN || null,
          cfop: r.CFOP != null ? Number(r.CFOP) : null,
          ean: r.EAN_MIRROR ? String(r.EAN_MIRROR).trim().slice(0, 20) || null : null,
        };

        try {
          await (this.prisma as any).wincredProduto.upsert({
            where: { codigo },
            create: { codigo, ...data },
            update: data,
          });
          produtosAtualizados++;
        } catch (e) {
          this.logger.warn(`[incremental] upsert produto ${codigo}: ${(e as Error).message}`);
        }

        if (r.DATAALT) {
          const d = new Date(r.DATAALT);
          if (!maxDataAlt || d > maxDataAlt) maxDataAlt = d;
        }
      }

      // ── 2. Estoque: NÃO entra aqui ──
      // O incremental cuida só do CADASTRO do produto. O estoque é do Flow
      // (constituição 14/07) e quem o mantém em dia são os movimentos do
      // próprio sistema; o trecho que relia o saldo de um ERP externo saiu
      // junto com o `syncEstoque` acima.
      const estoqueAtualizado = 0;

      await this.setSyncState('produtos', {
        lastDataAlt: maxDataAlt,
        rowCount: produtosAtualizados,
        status: 'OK',
      });
      // Status honesto: gravar 'OK' aqui faria a tela de status jurar que o
      // estoque sincronizou — o mesmo "espelho congelado que não avisa" que já
      // mordeu o financeiro. Quem lê tem que saber que este sync não mexe em
      // estoque por decisão, e que a fonte é o Flow.
      await this.setSyncState('estoque', {
        lastDataAlt: maxDataAlt,
        rowCount: estoqueAtualizado,
        status: 'OFF',
        error: 'Não se aplica — o estoque não é importado: o Flow é a fonte, e os movimentos do próprio sistema mantêm a tabela em dia. Se um saldo estiver errado, conte a peça e corrija no Flow; peça que sumiu vira registro em Peças extraviadas.',
      });

      const durationMs = Date.now() - t0;
      this.logger.log(
        `[incremental] OK — ${produtosAtualizados} produtos, ${estoqueAtualizado} estoque, ${durationMs}ms`,
      );
      return { produtosAtualizados, estoqueAtualizado, durationMs, janelaInicio };
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.error(`[incremental] FALHOU: ${msg}`);
      await this.setSyncState('produtos', {
        rowCount: produtosAtualizados,
        status: 'FAIL',
        error: msg.slice(0, 500),
      });
      throw e;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  DIVERGENCIAS — compara Wincred vs Mirror (#201)
  // ─────────────────────────────────────────────────────────────────────

  async getDivergencias(): Promise<{
    totaisProdutos: { wincred: number; mirror: number; diff: number };
    totaisEstoque: { wincred: number; mirror: number; diff: number };
    syncState: Array<{ tabela: string; lastRunAt: Date | null; lastDataAlt: Date | null; lastStatus: string | null; lastRowCount: number | null; ageMin: number | null }>;
    sampleDiffEstoque: Array<{ codigo: string; loja: string; wincred: number; mirror: number; diff: number }>;
  }> {
    // Totais
    const totalProdMy = await this.countMysql('produtos');
    const totalEstMy = await this.countMysql('estoque');

    let totalProdPg = 0;
    let totalEstPg = 0;
    try {
      const a: any[] = await this.prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS c FROM wincred_produtos`);
      totalProdPg = Number(a[0]?.c || 0);
    } catch {}
    try {
      const a: any[] = await this.prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS c FROM wincred_estoque`);
      totalEstPg = Number(a[0]?.c || 0);
    } catch {}

    // Sync state
    let syncStateRows: any[] = [];
    try {
      syncStateRows = await this.prisma.$queryRawUnsafe(
        `SELECT tabela, last_run_at AS "lastRunAt", last_data_alt AS "lastDataAlt",
                last_status AS "lastStatus", last_row_count AS "lastRowCount"
           FROM wincred_sync_state ORDER BY tabela`,
      );
    } catch {}

    const syncState = syncStateRows.map((r) => {
      const lastRunAt = r.lastRunAt ? new Date(r.lastRunAt) : null;
      const ageMin = lastRunAt ? Math.floor((Date.now() - lastRunAt.getTime()) / 60000) : null;
      return {
        tabela: r.tabela,
        lastRunAt,
        lastDataAlt: r.lastDataAlt ? new Date(r.lastDataAlt) : null,
        lastStatus: r.lastStatus,
        lastRowCount: r.lastRowCount,
        ageMin,
      };
    });

    // Sample diff estoque — pega 30 produtos PLUS_SIZE com DATAALT recente e
    // compara estoque Wincred vs Mirror.
    let sampleDiffEstoque: Array<{ codigo: string; loja: string; wincred: number; mirror: number; diff: number }> = [];
    const pool: any = (this.erp as any).pool;
    if (pool) {
      try {
        const [topProds] = await pool.query(
          `SELECT CODIGO FROM produtos
            WHERE CODIGO IS NOT NULL
            ORDER BY DATAALT DESC
            LIMIT 30`,
        );
        const codigosNorm: string[] = (topProds as any[])
          .map((r) => this.normalizeCodigo(r.CODIGO))
          .filter((c): c is string => !!c);

        if (codigosNorm.length > 0) {
          const variants: string[] = [];
          for (const c of codigosNorm) {
            variants.push(c);
            variants.push(c.padStart(10, '0'));
            variants.push(c.padStart(14, '0'));
          }
          const placeholders = variants.map(() => '?').join(',');
          const [estMy] = await pool.query(
            `SELECT CODIGO, LOJA, ESTOQUE FROM estoque WHERE CODIGO IN (${placeholders})`,
            variants,
          );
          const wincredMap = new Map<string, number>();
          for (const r of estMy as any[]) {
            const c = this.normalizeCodigo(r.CODIGO);
            const l = String(r.LOJA || '').trim();
            if (!c || !l) continue;
            wincredMap.set(`${c}|${l}`, Number(r.ESTOQUE) || 0);
          }

          const estPg: any[] = await this.prisma.$queryRawUnsafe(
            `SELECT codigo, loja, estoque FROM wincred_estoque WHERE codigo = ANY($1::text[])`,
            codigosNorm,
          );
          const mirrorMap = new Map<string, number>();
          for (const r of estPg) {
            const c = String(r.codigo).trim();
            const l = String(r.loja).trim();
            mirrorMap.set(`${c}|${l}`, Number(r.estoque) || 0);
          }

          const allKeys = new Set([...wincredMap.keys(), ...mirrorMap.keys()]);
          for (const k of allKeys) {
            const w = wincredMap.get(k) || 0;
            const m = mirrorMap.get(k) || 0;
            if (w !== m) {
              const [codigo, loja] = k.split('|');
              sampleDiffEstoque.push({ codigo, loja, wincred: w, mirror: m, diff: w - m });
            }
            if (sampleDiffEstoque.length >= 50) break;
          }
        }
      } catch (e) {
        this.logger.warn(`[divergencias] sample estoque: ${(e as Error).message}`);
      }
    }

    return {
      totaisProdutos: {
        wincred: totalProdMy,
        mirror: totalProdPg,
        diff: totalProdMy - totalProdPg,
      },
      totaisEstoque: {
        wincred: totalEstMy,
        mirror: totalEstPg,
        diff: totalEstMy - totalEstPg,
      },
      syncState,
      sampleDiffEstoque,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  //  SYNC GRUPOS / SUBGRUPOS / FORNECEDORES / CODIGOS (tabelas pequenas)
  // ─────────────────────────────────────────────────────────────────────

  async syncGrupos(): Promise<SyncResult> {
    return this.syncSmallTable('grupos', 'wincred_grupos', async (pool) => {
      const [rows] = await pool.query(`SELECT CODIGO, GRUPO FROM grupos`);
      return (rows as any[]).map((r) => ({
        codigo: Number(r.CODIGO),
        grupo: r.GRUPO || null,
      }));
    }, async (data, tx) => {
      if (data.length) await tx.wincredGrupo.createMany({ data, skipDuplicates: true });
      return data.length;
    }, { preservarFlow: true });
  }

  async syncSubgrupos(): Promise<SyncResult> {
    return this.syncSmallTable('subgrupos', 'wincred_subgrupos', async (pool) => {
      const [rows] = await pool.query(`SELECT CODIGO, SUBGRUPO, GRUPO FROM subgrupos`);
      return (rows as any[]).map((r) => ({
        codigo: Number(r.CODIGO),
        subgrupo: r.SUBGRUPO || null,
        grupo: r.GRUPO != null ? Number(r.GRUPO) : null,
      }));
    }, async (data, tx) => {
      if (data.length) await tx.wincredSubgrupo.createMany({ data, skipDuplicates: true });
      return data.length;
    }, { preservarFlow: true });
  }

  async syncFornecedores(): Promise<SyncResult> {
    return this.syncSmallTable('fornecedores', 'wincred_fornecedores', async (pool) => {
      const [rows] = await pool.query(
        `SELECT CODIGO, RAZAOSOCIAL, FANTASIA, CNPJ, IE, DATACADASTRO,
                ENDERECO, BAIRRO, CIDADE, UF, DDD, FONE, FAX, CEP,
                EMAIL, CONTATO, OBS FROM fornecedores`,
      );
      return (rows as any[]).map((r) => ({
        codigo: Number(r.CODIGO),
        razaoSocial: r.RAZAOSOCIAL || null,
        fantasia: r.FANTASIA || null,
        cnpj: r.CNPJ || null,
        ie: r.IE || null,
        dataCadastro: r.DATACADASTRO ? new Date(r.DATACADASTRO) : null,
        endereco: r.ENDERECO || null,
        bairro: r.BAIRRO || null,
        cidade: r.CIDADE || null,
        uf: r.UF || null,
        ddd: r.DDD || null,
        fone: r.FONE || null,
        fax: r.FAX || null,
        cep: r.CEP || null,
        email: r.EMAIL || null,
        contato: r.CONTATO || null,
        obs: r.OBS ? Buffer.from(r.OBS) : null,
      }));
    }, async (data, tx) => {
      if (data.length) await tx.wincredFornecedor.createMany({ data, skipDuplicates: true });
      return data.length;
      // preservarFlow: fornecedor cadastrado no Flow (faixa 90.000+) pode ainda
      // não existir no Giga. Sem isto ele sumiria no próximo sync — e junto o
      // vínculo dele nas contas a pagar já lançadas.
    }, { preservarFlow: true });
  }

  async syncCodigos(): Promise<SyncResult> {
    return this.syncSmallTable('codigos', 'wincred_codigos', async (pool) => {
      const [rows] = await pool.query(`SELECT CODIGO FROM codigos WHERE CODIGO IS NOT NULL`);
      const seen = new Set<string>();
      return (rows as any[])
        .map((r) => String(r.CODIGO).trim())
        .filter((c) => {
          if (!c || seen.has(c)) return false;
          seen.add(c);
          return true;
        })
        .map((codigo) => ({ codigo }));
    }, async (data, tx) => {
      if (data.length) await tx.wincredCodigo.createMany({ data, skipDuplicates: true });
      return data.length;
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  GET STOCK DISTRIBUTION (drop-in replacement)
  //  Mesma assinatura/retorno do ErpService.getStockDistribution mas le do
  //  Postgres (wincred_produtos JOIN wincred_estoque). 100-300x mais rapido.
  // ─────────────────────────────────────────────────────────────────────

  async getStockDistribution(filters: {
    grupoCodigo?: number | null;
    subgrupoCodigo?: number | null;
    search?: string | null;
    tamanhos?: string[] | null;
    lojas?: string[] | null;
    mode?: 'imbalanced' | 'all';
    minTotal?: number;
    limit?: number;
  } = {}): Promise<{
    rows: Array<{
      codigo: string;
      ref: string;
      cor: string | null;
      tamanho: string | null;
      descricao: string;
      preco: number;
      estoquePorLoja: Record<string, number>;
      total: number;
      criticidade: 'ALTO' | 'MEDIO' | 'OK';
    }>;
    lojas: string[];
    totalRows: number;
    truncated: boolean;
  }> {
    const t0 = Date.now();
    const limit = Math.max(50, Math.min(5000, filters.limit || 1500));
    const mode = filters.mode || 'imbalanced';
    const minTotal = Math.max(0, filters.minTotal ?? 2);

    const defaultPlusSize = [
      '46', '48', '50', '52', '54', '56', '58', '60',
      '46/48', '48/50', '50/52', '52/54', '54/56', '56/58', '58/60',
    ];
    const tamanhos = (filters.tamanhos && filters.tamanhos.length > 0)
      ? filters.tamanhos.map((t) => t.toUpperCase().trim()).filter(Boolean)
      : defaultPlusSize;
    const ignoredLojas = new Set(['SITE', 'PF']);

    // ── Monta WHERE dinamico ──
    const conds: string[] = [];
    const params: any[] = [];

    // Tamanho — APENAS quando NAO ha search especifica.
    // Quando user busca um produto especifico (drawer), quer ver TODOS os
    // tamanhos. So aplicar filtro plus size na lista geral.
    if (!filters.search?.trim()) {
      const tamanhosEscaped = tamanhos.map((t) => `'${t.replace(/'/g, "''")}'`).join(',');
      conds.push(`TRIM(UPPER(COALESCE(p.tamanho, ''))) IN (${tamanhosEscaped})`);
    }

    // REF nao vazia (TRIM cobre padding do Wincred)
    conds.push(`TRIM(COALESCE(p.ref, '')) <> ''`);

    if (filters.grupoCodigo) {
      conds.push(`p.grupo = $${params.length + 1}`);
      params.push(filters.grupoCodigo);
    }
    if (filters.subgrupoCodigo) {
      conds.push(`p.subgrupo = $${params.length + 1}`);
      params.push(filters.subgrupoCodigo);
    }
    if (filters.search?.trim()) {
      const rawSearch = filters.search.trim().toUpperCase();
      // Fast path: REF exata (igualdade)
      const isLikelyRef =
        !rawSearch.includes(' ') &&
        rawSearch.length >= 3 &&
        rawSearch.length <= 20 &&
        /[A-Z]/.test(rawSearch) &&
        /[0-9\-]/.test(rawSearch);
      if (isLikelyRef) {
        // LIKE com prefixo tolerante ao padding e variantes do REF.
        // 'VLM-222' bate com 'VLM-222', 'VLM-222 ', 'VLM-222EM', 'VLM-222MO', etc.
        // Usa UPPER + TRIM nas duas pontas pra ser case/padding insensible.
        conds.push(`UPPER(TRIM(COALESCE(p.ref, ''))) LIKE $${params.length + 1}`);
        params.push(`${rawSearch}%`);
      } else {
        const tokens = rawSearch.split(/\s+/).filter((t) => t.length > 0);
        for (const tok of tokens) {
          const term = `%${tok}%`;
          conds.push(
            `(TRIM(UPPER(COALESCE(p.ref, ''))) LIKE $${params.length + 1} OR UPPER(COALESCE(p."descricaoCompleta", '')) LIKE $${params.length + 2} OR p.codigo LIKE $${params.length + 3})`,
          );
          params.push(term, term, term);
        }
      }
    }

    params.push(limit);
    const limitParam = `$${params.length}`;

    // Query principal: JOIN com agregacao usando json_object_agg
    const sql = `
      SELECT
        p.codigo,
        p.ref,
        p.cor,
        p.tamanho,
        COALESCE(p."descricaoCompleta", '') AS descricao,
        COALESCE(p."vendaUn", 0)::float AS preco,
        COALESCE(
          json_object_agg(
            e.loja, e.estoque
          ) FILTER (WHERE e.loja IS NOT NULL),
          '{}'::json
        ) AS estoque_obj
      FROM wincred_produtos p
      LEFT JOIN wincred_estoque e ON e.codigo = p.codigo
      WHERE ${conds.join(' AND ')}
      GROUP BY p.codigo, p.ref, p.cor, p.tamanho, p."descricaoCompleta", p."vendaUn"
      ORDER BY p.ref, p.cor, p.tamanho
      LIMIT ${limitParam}
    `;

    let rawRows: any[] = [];
    try {
      rawRows = await this.prisma.$queryRawUnsafe(sql, ...params);
    } catch (e) {
      this.logger.error(`getStockDistribution falhou: ${(e as Error).message}`);
      return { rows: [], lojas: [], totalRows: 0, truncated: false };
    }
    this.logger.log(`[mirror] getStockDistribution: ${rawRows.length} linhas em ${Date.now() - t0}ms`);

    // Parse e calcula criticidade
    const lojasSet = new Set<string>();
    type Parsed = {
      codigo: string; ref: string; cor: string | null; tamanho: string | null;
      descricao: string; preco: number;
      estoquePorLoja: Record<string, number>; total: number;
      criticidade: 'ALTO' | 'MEDIO' | 'OK';
    };
    const parsed: Parsed[] = [];

    for (const r of rawRows) {
      const estoqueObj = r.estoque_obj || {};
      const estoquePorLoja: Record<string, number> = {};
      let total = 0;
      for (const [loja, qty] of Object.entries(estoqueObj)) {
        const lojaCode = String(loja).trim().toUpperCase();
        if (!lojaCode || ignoredLojas.has(lojaCode)) continue;
        const q = Number(qty) || 0;
        estoquePorLoja[lojaCode] = (estoquePorLoja[lojaCode] || 0) + q;
        lojasSet.add(lojaCode);
        total += q;
      }

      // Filtro lojas
      if (filters.lojas && filters.lojas.length > 0) {
        const filtered: Record<string, number> = {};
        let filteredTotal = 0;
        for (const lj of filters.lojas) {
          const code = lj.toUpperCase().trim();
          const v = estoquePorLoja[code] || 0;
          filtered[code] = v;
          filteredTotal += v;
        }
        Object.assign(estoquePorLoja, filtered);
        for (const k of Object.keys(estoquePorLoja)) {
          if (!filters.lojas.includes(k)) delete estoquePorLoja[k];
        }
        total = filteredTotal;
      }

      const valores = Object.values(estoquePorLoja);
      const temZero = valores.some((v) => v <= 0);
      const maxQty = valores.length > 0 ? Math.max(...valores) : 0;
      let criticidade: 'ALTO' | 'MEDIO' | 'OK' = 'OK';
      if (temZero && maxQty >= 3) criticidade = 'ALTO';
      else if (temZero && maxQty >= 2) criticidade = 'MEDIO';

      parsed.push({
        codigo: String(r.codigo).trim(),
        ref: String(r.ref || '').trim(),
        cor: r.cor ? String(r.cor).trim() : null,
        tamanho: r.tamanho ? String(r.tamanho).trim() : null,
        descricao: String(r.descricao || '').trim(),
        preco: Number(r.preco) || 0,
        estoquePorLoja, total, criticidade,
      });
    }

    // Filtra mode + minTotal
    let filtered = parsed;
    if (minTotal > 0) {
      filtered = filtered.filter((r) => {
        const vals = Object.values(r.estoquePorLoja || {});
        const m = vals.length > 0 ? Math.max(...vals) : 0;
        return m >= minTotal;
      });
    }
    if (mode === 'imbalanced') {
      filtered = filtered.filter((r) => r.criticidade !== 'OK');
    }

    // Ordena
    const ordWeight: Record<string, number> = { ALTO: 0, MEDIO: 1, OK: 2 };
    filtered.sort((a, b) => {
      const dw = ordWeight[a.criticidade] - ordWeight[b.criticidade];
      if (dw !== 0) return dw;
      return b.total - a.total;
    });

    const lojas = Array.from(lojasSet)
      .filter((l) => !ignoredLojas.has(l))
      .filter((l) => !filters.lojas || filters.lojas.includes(l))
      .sort();

    return {
      rows: filtered,
      lojas,
      totalRows: filtered.length,
      truncated: rawRows.length >= limit,
    };
  }

  /**
   * Visão RAIZ (REF+COR) da distribuição de estoque — porta 1:1 do
   * `ErpService.getStockDistributionByRef` pro ESPELHO (29/08).
   *
   * O original rodava no MySQL do Giga vivo; com o pool trancado (atestado
   * 28/08) a tela /retaguarda/distribuicao-estoque no modo raiz voltava vazia
   * SEM erro. Mesmo contrato de saída (a tela não sabe a diferença), mesma
   * mecânica: 1 query de produtos agrupada por REF+COR + 1 de estoque por
   * código + nomes de grupo/subgrupo em batch. Fonte de estoque:
   * `wincred_estoque` (igual ao `getStockDistribution` clássico acima).
   */
  async getStockDistributionByRef(filters: {
    grupoCodigo?: number | null;
    subgrupoCodigo?: number | null;
    search?: string | null;
    tamanhos?: string[] | null;
    diasMaximos?: number | null;
    diasMinimos?: number | null;
    mode?: 'imbalanced' | 'all';
    minTotal?: number;
    limit?: number;
  } = {}): Promise<{
    refs: Array<{
      ref: string;
      cor: string | null;
      descricao: string;
      preco: number;
      dataAlt: string | null;
      grupoCodigo: number | null;
      subgrupoCodigo: number | null;
      grupoNome: string | null;
      subgrupoNome: string | null;
      tamanhos: string[];
      variacoes: number;
      lojasComEstoque: number;
      estoquePorLoja: Record<string, number>;
      total: number;
    }>;
    lojas: string[];
    totalRows: number;
    truncated: boolean;
  }> {
    const t0 = Date.now();
    const limit = Math.max(50, Math.min(10000, filters.limit || 3000));
    const mode = filters.mode || 'imbalanced';
    const minTotal = Math.max(0, filters.minTotal ?? 2);
    const defaultPlusSize = [
      '46', '48', '50', '52', '54', '56', '58', '60',
      '46/48', '48/50', '50/52', '52/54', '54/56', '56/58', '58/60',
    ];
    const tamanhos = (filters.tamanhos && filters.tamanhos.length > 0)
      ? filters.tamanhos.map((t) => t.toUpperCase().trim()).filter(Boolean)
      : defaultPlusSize;
    const ignoredLojas = new Set(['SITE', 'PF']);

    // ── 1) Produtos agrupados por REF+COR ──
    const conds: string[] = [
      `TRIM(UPPER(COALESCE(p.tamanho, ''))) IN (${tamanhos.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')})`,
      `TRIM(COALESCE(p.ref, '')) <> ''`,
    ];
    const params: any[] = [];
    if (filters.grupoCodigo) {
      conds.push(`p.grupo = $${params.length + 1}`);
      params.push(filters.grupoCodigo);
    }
    if (filters.subgrupoCodigo) {
      conds.push(`p.subgrupo = $${params.length + 1}`);
      params.push(filters.subgrupoCodigo);
    }
    if (filters.search?.trim()) {
      const tokens = filters.search.trim().toUpperCase().split(/\s+/).filter(Boolean);
      for (const tok of tokens) {
        const term = `%${tok}%`;
        conds.push(
          `(UPPER(COALESCE(p.ref, '')) LIKE $${params.length + 1} OR UPPER(COALESCE(p."descricaoCompleta", '')) LIKE $${params.length + 2} OR p.codigo LIKE $${params.length + 3})`,
        );
        params.push(term, term, term);
      }
    }
    if (filters.diasMaximos != null) {
      conds.push(`p."dataAlt" >= CURRENT_DATE - $${params.length + 1}::int`);
      params.push(Math.max(1, Math.round(filters.diasMaximos)));
    }
    if (filters.diasMinimos != null) {
      conds.push(`p."dataAlt" <= CURRENT_DATE - $${params.length + 1}::int`);
      params.push(Math.max(1, Math.round(filters.diasMinimos)));
    }
    params.push(limit);

    let rawRefs: any[] = [];
    try {
      rawRefs = await this.prisma.$queryRawUnsafe(
        `SELECT TRIM(p.ref) AS ref,
                COALESCE(p.cor, '') AS cor,
                MAX(COALESCE(p."descricaoCompleta", '')) AS descricao,
                ROUND(AVG(COALESCE(p."vendaUn", 0))::numeric, 2)::float AS preco,
                MAX(p."dataAlt") AS data_alt,
                MAX(p.grupo) AS grupo_codigo,
                MAX(p.subgrupo) AS subgrupo_codigo,
                array_agg(DISTINCT p.codigo) AS codigos,
                array_agg(DISTINCT TRIM(p.tamanho)) FILTER (WHERE COALESCE(TRIM(p.tamanho), '') <> '') AS tamanhos
           FROM wincred_produtos p
          WHERE ${conds.join(' AND ')}
          GROUP BY TRIM(p.ref), COALESCE(p.cor, '')
          ORDER BY MAX(COALESCE(p."descricaoCompleta", '')) ASC
          LIMIT $${params.length}`,
        ...params,
      );
    } catch (e) {
      this.logger.error(`getStockDistributionByRef (espelho) falhou: ${(e as Error).message}`);
      return { refs: [], lojas: [], totalRows: 0, truncated: false };
    }
    this.logger.log(`[mirror] getStockDistributionByRef: ${rawRefs.length} refs em ${Date.now() - t0}ms`);
    if (rawRefs.length === 0) return { refs: [], lojas: [], totalRows: 0, truncated: false };

    // ── 2) Estoque agregado dos códigos envolvidos ──
    const allCodigos = new Set<string>();
    for (const r of rawRefs) {
      for (const c of (r.codigos || []) as string[]) {
        const trimmed = String(c || '').trim();
        if (trimmed) allCodigos.add(trimmed);
      }
    }
    const estoquePorCodigo = new Map<string, Record<string, number>>();
    const lojasSet = new Set<string>();
    if (allCodigos.size > 0) {
      try {
        const est: any[] = await this.prisma.$queryRawUnsafe(
          `SELECT codigo, loja, SUM(estoque)::float AS est
             FROM wincred_estoque
            WHERE codigo = ANY($1::text[])
            GROUP BY codigo, loja`,
          Array.from(allCodigos),
        );
        for (const r of est) {
          const cod = String(r.codigo).trim();
          const loja = String(r.loja || '').trim().toUpperCase();
          if (!loja || ignoredLojas.has(loja)) continue;
          const qty = Number(r.est) || 0;
          if (qty === 0) continue;
          if (!estoquePorCodigo.has(cod)) estoquePorCodigo.set(cod, {});
          const mapa = estoquePorCodigo.get(cod)!;
          mapa[loja] = (mapa[loja] || 0) + qty;
          lojasSet.add(loja);
        }
      } catch (e) {
        this.logger.warn(`getStockDistributionByRef (espelho) estoque falhou: ${(e as Error).message}`);
      }
    }

    // ── 3) Nomes de grupo/subgrupo ──
    const grupoCodes = Array.from(new Set(rawRefs.map((r) => r.grupo_codigo).filter((v) => v != null).map(Number)));
    const subgrupoCodes = Array.from(new Set(rawRefs.map((r) => r.subgrupo_codigo).filter((v) => v != null).map(Number)));
    const grupoNames = new Map<number, string>();
    const subgrupoNames = new Map<number, string>();
    if (grupoCodes.length) {
      const gs = await (this.prisma as any).wincredGrupo
        .findMany({ where: { codigo: { in: grupoCodes } } })
        .catch(() => []);
      for (const g of gs) grupoNames.set(Number(g.codigo), String(g.grupo || '').trim());
    }
    if (subgrupoCodes.length) {
      const sgs = await (this.prisma as any).wincredSubgrupo
        .findMany({ where: { codigo: { in: subgrupoCodes } } })
        .catch(() => []);
      for (const s of sgs) subgrupoNames.set(Number(s.codigo), String(s.subgrupo || '').trim());
    }

    // ── 4) Monta lista final (mesma régua do original) ──
    const out: Array<any> = [];
    for (const r of rawRefs) {
      const codigos = ((r.codigos || []) as string[]).map((c) => String(c).trim()).filter(Boolean);
      const estoquePorLoja: Record<string, number> = {};
      let total = 0;
      const variacoesComEstoque = new Set<string>();
      for (const cod of codigos) {
        const mapa = estoquePorCodigo.get(cod);
        if (!mapa) continue;
        let temEstoque = false;
        for (const [loja, qty] of Object.entries(mapa)) {
          if (qty <= 0) continue;
          estoquePorLoja[loja] = (estoquePorLoja[loja] || 0) + qty;
          total += qty;
          temEstoque = true;
        }
        if (temEstoque) variacoesComEstoque.add(cod);
      }
      const lojasComEstoque = Object.values(estoquePorLoja).filter((v) => v > 0).length;
      const gCode = r.grupo_codigo != null ? Number(r.grupo_codigo) : null;
      const sCode = r.subgrupo_codigo != null ? Number(r.subgrupo_codigo) : null;
      out.push({
        ref: String(r.ref || '').trim(),
        cor: r.cor ? String(r.cor).trim() : null,
        descricao: String(r.descricao || '').trim(),
        preco: Number(r.preco) || 0,
        dataAlt: r.data_alt ? new Date(r.data_alt).toISOString() : null,
        grupoCodigo: gCode,
        subgrupoCodigo: sCode,
        grupoNome: gCode != null ? grupoNames.get(gCode) || null : null,
        subgrupoNome: sCode != null ? subgrupoNames.get(sCode) || null : null,
        tamanhos: ((r.tamanhos || []) as string[]).sort((a, b) => {
          const na = parseInt(a, 10);
          const nb = parseInt(b, 10);
          if (!isNaN(na) && !isNaN(nb)) return na - nb;
          return a.localeCompare(b);
        }),
        variacoes: variacoesComEstoque.size,
        lojasComEstoque,
        estoquePorLoja,
        total,
      });
    }

    let filtered = out.filter((r) => r.total > 0);
    if (minTotal > 0) filtered = filtered.filter((r) => r.total >= minTotal);
    if (mode === 'imbalanced') {
      filtered = filtered.filter((r) => {
        const vals = Object.values(r.estoquePorLoja) as number[];
        if (vals.length === 0) return false;
        const max = Math.max(...vals);
        const min = Math.min(0, ...vals);
        return max >= 2 && min === 0;
      });
    }
    const lojas = Array.from(lojasSet).filter((l) => !ignoredLojas.has(l)).sort();
    return { refs: filtered, lojas, totalRows: filtered.length, truncated: rawRefs.length >= limit };
  }

  // Helper para tabelas pequenas (1 batch so)
  private async syncSmallTable<T>(
    tableName: string,
    pgTable: string,
    fetcher: (pool: any) => Promise<T[]>,
    // Recebe o client da TRANSAÇÃO. Usar `this.prisma` aqui dentro abriria uma
    // segunda conexão, que ficaria esperando o lock do DELETE da transação —
    // trava até o timeout.
    inserter: (data: T[], tx: any) => Promise<number>,
    // `preservarFlow` (31/07): a tabela tem linhas que NASCERAM no Flow e podem
    // ainda não existir no Giga — categoria criada no cadastro de produto com a
    // réplica na fila. TRUNCATE apagaria essas linhas antes de a réplica sair, e
    // o produto ficaria apontando pra uma categoria que sumiu. Com a opção
    // ligada, o refresh derruba só o que veio do Giga.
    opts?: { preservarFlow?: boolean },
  ): Promise<SyncResult> {
    const t0 = Date.now();
    const pool: any = (this.erp as any).pool;
    if (!pool) return { table: tableName, success: false, processed: 0, durationMs: 0, error: 'importacao encerrada: o sistema antigo foi desligado em 27/08/2026 — nao ha nada pra importar' };
    try {
      // LÊ ANTES DE APAGAR (31/07). A ordem era inversa: apagava e só então
      // buscava no Giga. Com o Giga fora na hora do cron, o DELETE passava, o
      // fetch estourava e a tabela ficava VAZIA — e assim continuava, porque a
      // próxima execução apagaria o vazio de novo. Grupo, subgrupo e fornecedor
      // somem juntos, e o cadastro de produto exige os três: em menos de 24h
      // ninguém cadastra peça nova.
      //
      // Mesma regra que `syncEstoque` e o espelho de crediário já seguem:
      // melhor a cópia velha inteira que uma nova pela metade.
      const data = await fetcher(pool);

      // Vazio não é resposta válida: estas tabelas nunca estão vazias de
      // verdade. Vazio significa Giga indisponível — preserva o que está lá.
      if (!data.length) {
        throw new Error('SELECT veio vazio — Giga indisponível, cópia preservada');
      }

      // Só agora troca, e numa transação: quem estiver lendo vê a cópia antiga
      // inteira até o commit, nunca um estado intermediário.
      const processed = await this.prisma.$transaction(async (tx: any) => {
        if (opts?.preservarFlow) {
          await tx.$executeRawUnsafe(`DELETE FROM "${pgTable}" WHERE flow_is_source = false`);
        } else {
          await tx.$executeRawUnsafe(`DELETE FROM "${pgTable}"`);
        }
        return inserter(data, tx);
      }, { timeout: 120_000 });

      const durationMs = Date.now() - t0;
      this.logger.log(`[${tableName}] OK — ${processed} linhas em ${durationMs}ms`);
      return { table: tableName, success: true, processed, durationMs };
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.error(`[${tableName}] FALHOU: ${msg}`);
      return { table: tableName, success: false, processed: 0, durationMs: Date.now() - t0, error: msg };
    }
  }
}

export type SyncResult = {
  table: string;
  success: boolean;
  processed: number;
  durationMs: number;
  error?: string;
};
