import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * WincredMirrorService — espelha as 6 tabelas criticas do MySQL Wincred
 * no Postgres do Flowops. Estrategia:
 *   - FULL SYNC: TRUNCATE + INSERT em batches (usado na 1a carga ou recovery)
 *   - INCREMENTAL: por DATAALT > ultimoSync (so produtos tem DATAALT util)
 *
 * Tabelas espelhadas:
 *   produtos, estoque, grupos, subgrupos, fornecedores, codigos
 *
 * Performance esperada (full sync):
 *   - produtos:     30-90s (50k+ linhas)
 *   - estoque:      60-180s (centenas de milhares de linhas)
 *   - grupos:       <100ms
 *   - subgrupos:    <100ms
 *   - fornecedores: <500ms
 *   - codigos:      <100ms
 *
 * SOMENTE LEITURA no Wincred. Toda escrita acontece no Postgres.
 */
@Injectable()
export class WincredMirrorService {
  private readonly logger = new Logger(WincredMirrorService.name);
  private readonly BATCH = 200;
  private readonly RETRY_MAX = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
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
    if (!pool) throw new Error('MySQL pool nao inicializado');
    // Filtro plus size aplicado em produtos (so sincroniza o que importa)
    const where = table === 'produtos' ? ` WHERE PLUS_SIZE IN (1, 2)` : '';
    const [rows] = await pool.query(`SELECT COUNT(*) AS c FROM \`${table}\`${where}`);
    return Number((rows as any[])[0]?.c ?? 0);
  }

  // ─────────────────────────────────────────────────────────────────────
  //  SYNC ALL
  // ─────────────────────────────────────────────────────────────────────

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

  async syncProdutos(): Promise<SyncResult> {
    const t0 = Date.now();
    const pool: any = (this.erp as any).pool;
    if (!pool) return { table: 'produtos', success: false, processed: 0, durationMs: 0, error: 'MySQL pool nao inicializado' };

    try {
      const total = await this.countMysql('produtos');

      // Filtro PLUS_SIZE: so sincronizamos os produtos relevantes.
      // Sempre TRUNCATE — full sync sempre limpo e simples.
      this.logger.log(`[produtos] iniciando full sync — ${total} linhas no Wincred filtrado`);
      await this.withRetry('truncate produtos', () =>
        this.prisma.$executeRawUnsafe(`TRUNCATE TABLE "wincred_produtos"`),
      );

      let processed = 0;
      let offset = 0;
      while (offset < total) {
        // OFFSET pagination — mais simples e robusta que cursor com CODIGO varchar.
        // Com 58k linhas e batch 200 = ~290 batches. OK pra performance.
        const [rows] = await pool.query(
          `SELECT CODIGO, GRUPO, NOMEGRUPO, DESCRICAOPDV, DESCRICAOCOMPLETA,
                  CUSTO, VENDAUN, FORNECEDOR, UNIDADE, ESTOQUE, MARGEM, DATAALT,
                  SUBGRUPO, COR, TAMANHO, MARCA, REF, CODFORNECEDOR, OPERADOR,
                  CONFPRECO, TRIBUTO, NCM, PLUS_SIZE, ID, CATEGORIAS,
                  COD_PIS, ALIQ_PIS, COD_COFINS, ALIQ_COFINS, ALIQ_ICMS,
                  CST, CSOSN, CFOP
             FROM produtos
            WHERE PLUS_SIZE IN (1, 2)
            ORDER BY ID
            LIMIT ? OFFSET ?`,
          [this.BATCH, offset],
        );
        if (!(rows as any[]).length) break;

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
          }));

        if (data.length) {
          await this.withRetry(`produtos@${processed}`, () =>
            (this.prisma as any).wincredProduto.createMany({
              data,
              skipDuplicates: true,
            }),
          );
        }
        processed += data.length;
        offset += this.BATCH;
        // Log + pausa a cada 10 batches (libera conexao Railway)
        if (offset % (this.BATCH * 10) === 0) {
          this.logger.log(`[produtos] ${processed}/${total} (${Math.round((processed / total) * 100)}%) offset=${offset}`);
          await this.sleep(50);
        }
      }

      const durationMs = Date.now() - t0;
      this.logger.log(`[produtos] OK — ${processed} linhas em ${durationMs}ms`);
      return { table: 'produtos', success: true, processed, durationMs };
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.error(`[produtos] FALHOU: ${msg}`);
      return { table: 'produtos', success: false, processed: 0, durationMs: Date.now() - t0, error: msg };
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  SYNC ESTOQUE (full)
  // ─────────────────────────────────────────────────────────────────────

  async syncEstoque(): Promise<SyncResult> {
    const t0 = Date.now();
    const pool: any = (this.erp as any).pool;
    if (!pool) return { table: 'estoque', success: false, processed: 0, durationMs: 0, error: 'MySQL pool nao inicializado' };

    try {
      const total = await this.countMysql('estoque');
      this.logger.log(`[estoque] iniciando sync — ${total} linhas no Wincred`);

      await this.withRetry('truncate estoque', () => this.prisma.$executeRawUnsafe(`TRUNCATE TABLE "wincred_estoque"`));

      let processed = 0;
      let offset = 0;
      while (offset < total) {
        const [rows] = await pool.query(
          `SELECT CODIGO, ESTOQUE, LOJA FROM estoque ORDER BY CODIGO, LOJA LIMIT ? OFFSET ?`,
          [this.BATCH, offset],
        );
        if (!(rows as any[]).length) break;

        // Dedup por (CODIGO, LOJA)
        const seen = new Set<string>();
        const data = (rows as any[])
          .filter((r) => {
            const c = this.normalizeCodigo(r.CODIGO);
            const l = String(r.LOJA || '').trim();
            if (!c || !l) return false;
            const k = `${c}|${l}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .map((r) => ({
            codigo: this.normalizeCodigo(r.CODIGO)!,
            loja: String(r.LOJA).trim(),
            estoque: r.ESTOQUE != null ? Number(r.ESTOQUE) : null,
          }));

        if (data.length) {
          await this.withRetry(`estoque@${offset}`, () =>
            (this.prisma as any).wincredEstoque.createMany({
              data,
              skipDuplicates: true,
            }),
          );
        }
        processed += data.length;
        offset += this.BATCH;
        if (offset % (this.BATCH * 20) === 0) {
          this.logger.log(`[estoque] ${processed}/${total} (${Math.round((processed / total) * 100)}%)`);
          await this.sleep(50);
        }
      }

      const durationMs = Date.now() - t0;
      this.logger.log(`[estoque] OK — ${processed} linhas em ${durationMs}ms`);
      return { table: 'estoque', success: true, processed, durationMs };
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.error(`[estoque] FALHOU: ${msg}`);
      return { table: 'estoque', success: false, processed: 0, durationMs: Date.now() - t0, error: msg };
    }
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
    state: { lastDataAlt?: Date | null; rowCount: number; status: 'OK' | 'FAIL'; error?: string | null },
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
      this.logger.warn('[incremental] MySQL pool nao inicializado');
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
      const [rows] = await pool.query(
        `SELECT CODIGO, GRUPO, NOMEGRUPO, DESCRICAOPDV, DESCRICAOCOMPLETA,
                CUSTO, VENDAUN, FORNECEDOR, UNIDADE, ESTOQUE, MARGEM, DATAALT,
                SUBGRUPO, COR, TAMANHO, MARCA, REF, CODFORNECEDOR, OPERADOR,
                CONFPRECO, TRIBUTO, NCM, PLUS_SIZE, ID, CATEGORIAS,
                COD_PIS, ALIQ_PIS, COD_COFINS, ALIQ_COFINS, ALIQ_ICMS,
                CST, CSOSN, CFOP
           FROM produtos
          WHERE PLUS_SIZE IN (1, 2)
            AND DATAALT IS NOT NULL
            AND DATAALT >= ?
          ORDER BY DATAALT`,
        [isoDate],
      );

      const list = rows as any[];
      this.logger.log(`[incremental] ${list.length} produtos modificados`);

      const codigosModificados: string[] = [];
      for (const r of list) {
        const codigo = this.normalizeCodigo(r.CODIGO);
        if (!codigo) continue;
        codigosModificados.push(codigo);

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

      // ── 2. Estoque dos produtos modificados (somente eles) ──
      let estoqueAtualizado = 0;
      if (codigosModificados.length > 0) {
        // Wincred guarda CODIGO em estoque com formato variavel (padding zeros, etc).
        // Vamos buscar pelos codigos normalizados — convertemos cada para varias formas.
        // Mais simples: SELECT estoque WHERE codigo numerico IN (lista numerica).
        // Como nao da pra fazer cast em WHERE com MySQL eficiente, fazemos batch IN
        // com varias representacoes (sem padding + raw).
        // Estrategia pragmatica: SELECT WHERE CODIGO IN (?,?,?...) tentando varias formas.

        // Forma 1: codigo puro
        const codigosLote = [...new Set(codigosModificados)];
        // Chunks de 500 (placeholder limit MySQL)
        for (let i = 0; i < codigosLote.length; i += 500) {
          const chunk = codigosLote.slice(i, i + 500);
          // Inclui ambas as formas: '5387373' e '0005387373' (padding 10)
          const variants: string[] = [];
          for (const c of chunk) {
            variants.push(c);                       // forma normalizada
            variants.push(c.padStart(10, '0'));     // padding 10 (formato wincred comum)
            variants.push(c.padStart(14, '0'));     // padding 14 (varchar max)
          }
          const placeholders = variants.map(() => '?').join(',');
          const [estRows] = await pool.query(
            `SELECT CODIGO, ESTOQUE, LOJA FROM estoque WHERE CODIGO IN (${placeholders})`,
            variants,
          );

          // Deleta estoque desses codigos no Postgres, re-insere
          await this.prisma.$executeRawUnsafe(
            `DELETE FROM wincred_estoque WHERE codigo = ANY($1::text[])`,
            chunk,
          );

          const seen = new Set<string>();
          const dataEst = (estRows as any[])
            .filter((r) => {
              const c = this.normalizeCodigo(r.CODIGO);
              const l = String(r.LOJA || '').trim();
              if (!c || !l) return false;
              const k = `${c}|${l}`;
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            })
            .map((r) => ({
              codigo: this.normalizeCodigo(r.CODIGO)!,
              loja: String(r.LOJA).trim(),
              estoque: r.ESTOQUE != null ? Number(r.ESTOQUE) : null,
            }));

          if (dataEst.length) {
            await (this.prisma as any).wincredEstoque.createMany({
              data: dataEst,
              skipDuplicates: true,
            });
            estoqueAtualizado += dataEst.length;
          }
        }
      }

      await this.setSyncState('produtos', {
        lastDataAlt: maxDataAlt,
        rowCount: produtosAtualizados,
        status: 'OK',
      });
      await this.setSyncState('estoque', {
        lastDataAlt: maxDataAlt,
        rowCount: estoqueAtualizado,
        status: 'OK',
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
            WHERE PLUS_SIZE IN (1, 2)
              AND CODIGO IS NOT NULL
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
    }, async (data) => {
      if (data.length) await (this.prisma as any).wincredGrupo.createMany({ data, skipDuplicates: true });
      return data.length;
    });
  }

  async syncSubgrupos(): Promise<SyncResult> {
    return this.syncSmallTable('subgrupos', 'wincred_subgrupos', async (pool) => {
      const [rows] = await pool.query(`SELECT CODIGO, SUBGRUPO, GRUPO FROM subgrupos`);
      return (rows as any[]).map((r) => ({
        codigo: Number(r.CODIGO),
        subgrupo: r.SUBGRUPO || null,
        grupo: r.GRUPO != null ? Number(r.GRUPO) : null,
      }));
    }, async (data) => {
      if (data.length) await (this.prisma as any).wincredSubgrupo.createMany({ data, skipDuplicates: true });
      return data.length;
    });
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
    }, async (data) => {
      if (data.length) await (this.prisma as any).wincredFornecedor.createMany({ data, skipDuplicates: true });
      return data.length;
    });
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
    }, async (data) => {
      if (data.length) await (this.prisma as any).wincredCodigo.createMany({ data, skipDuplicates: true });
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

  // Helper para tabelas pequenas (1 batch so)
  private async syncSmallTable<T>(
    tableName: string,
    pgTable: string,
    fetcher: (pool: any) => Promise<T[]>,
    inserter: (data: T[]) => Promise<number>,
  ): Promise<SyncResult> {
    const t0 = Date.now();
    const pool: any = (this.erp as any).pool;
    if (!pool) return { table: tableName, success: false, processed: 0, durationMs: 0, error: 'MySQL pool nao inicializado' };
    try {
      await this.prisma.$executeRawUnsafe(`TRUNCATE TABLE "${pgTable}"`);
      const data = await fetcher(pool);
      const processed = await inserter(data);
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
