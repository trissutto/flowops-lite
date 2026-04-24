import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { StockService } from './stock.service';
import { ErpService } from '../erp/erp.service';
import { PrismaService } from '../prisma/prisma.service';
import { WpDbService } from '../wp-db/wp-db.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

/**
 * Controller de DIAGNÓSTICO de estoque.
 * Endpoints de investigação — não uso produtivo.
 */
@Controller('stock')
@UseGuards(JwtAuthGuard)
export class StockController {
  constructor(
    private readonly stock: StockService,
    private readonly erp: ErpService,
    private readonly prisma: PrismaService,
    private readonly wpDb: WpDbService,
  ) {}

  /**
   * GET /stock/wp-diagnose?ref=13015
   *
   * DIAGNÓSTICO do WP MySQL — usado pra investigar por que as miniaturas
   * não aparecem no /minha-loja/realinhamento.
   *
   * Mostra:
   *  1. Se o pool WP está ativo (env vars WP_DB_* configuradas + ping OK)
   *  2. Raw SKUs cadastrados no WC que batem com a REF (LIKE 'REF%')
   *  3. siteurl do WP
   *  4. O que o getImagesByRefs retorna de fato pra essa REF
   */
  @Get('wp-diagnose')
  async wpDiagnose(@Query('ref') ref: string) {
    const pool = this.wpDb.getPool();
    const poolAlive = !!pool;
    const cleanRef = String(ref || '').trim();

    if (!poolAlive) {
      return {
        poolAlive: false,
        hint:
          'Pool WP não inicializou. Verifique no Railway: WP_DB_HOST, WP_DB_PORT, WP_DB_USER, WP_DB_PASSWORD, WP_DB_DATABASE. Se host exigir IP whitelist, libere o IP outbound do Railway.',
      };
    }

    if (!cleanRef) {
      return {
        poolAlive: true,
        error: 'Query param ref é obrigatório (ex: ?ref=13015)',
      };
    }

    // siteurl
    const siteUrlRows = await this.wpDb.query<{ option_value: string }>(
      "SELECT option_value FROM wp_options WHERE option_name = 'siteurl' LIMIT 1",
    );
    const siteUrl = siteUrlRows[0]?.option_value || null;

    // SKUs brutos que batem com LIKE 'REF%'
    const skuRows = await this.wpDb.query<{ sku: string; post_id: number; post_type: string; post_status: string }>(
      `SELECT pm.meta_value AS sku, p.ID AS post_id, p.post_type, p.post_status
         FROM wp_postmeta pm
         JOIN wp_posts p ON p.ID = pm.post_id
        WHERE pm.meta_key = '_sku'
          AND pm.meta_value LIKE ?
        LIMIT 20`,
      [`${cleanRef}%`],
    );

    // Roda o método oficial pra ver o que a função devolveria em produção
    const imagesByRef = await this.wpDb.getImagesByRefs([cleanRef]);

    return {
      poolAlive: true,
      ref: cleanRef,
      siteUrl,
      matchingSkusInWc: skuRows,
      imagesByRef,
      hint: !skuRows.length
        ? `Nenhum SKU no WC com LIKE '${cleanRef}%'. Confira se o SKU do produto no Woo começa com a REF.`
        : !imagesByRef[cleanRef]
        ? 'Achou SKU mas não achou imagem. Produto pode não ter _thumbnail_id definido (foto destacada) no WC.'
        : 'OK — deveria estar aparecendo.',
    };
  }

  /**
   * GET /stock/diagnose?sku=11573739
   *
   * Mostra, pra um SKU:
   *  1. RAW do ERP — TODAS as linhas da tabela `estoque` (sem filtrar ESTOQUE>0),
   *     revela duplicatas, devoluções (qty negativa), linhas zeradas.
   *  2. Produto no cadastro do Gigasistemas (tabela `produtos`)
   *  3. Lojas ativas do FlowOps e o que o ERP responde AO VIVO (sem cache)
   *  4. Cache atual pra cada combo (sku, loja)
   *
   * Com isso dá pra ver rapidinho por que a engine achou que uma loja tinha estoque.
   */
  @Get('diagnose')
  async diagnose(@Query('sku') sku: string) {
    if (!sku?.trim()) {
      return { error: 'Query param sku é obrigatório' };
    }
    const cleanSku = sku.trim();

    // 1. Raw do ERP
    const rawRows = await this.erp.getStockRawBySku(cleanSku);

    // Detecta duplicatas (mesma LOJA aparece mais de uma vez)
    const byStore = new Map<string, { qty: number; rows: number }>();
    for (const r of rawRows) {
      const cur = byStore.get(r.storeCode) ?? { qty: 0, rows: 0 };
      cur.qty += r.qty;
      cur.rows += 1;
      byStore.set(r.storeCode, cur);
    }
    const duplicates = [...byStore.entries()]
      .filter(([, v]) => v.rows > 1)
      .map(([storeCode, v]) => ({ storeCode, rowCount: v.rows, sumQty: v.qty }));

    // 2. Produto no cadastro
    const product = await this.erp.getProduct(cleanSku);

    // 3. Consulta AO VIVO pro que a engine usaria (stock service com filtro ESTOQUE>0)
    const stores = await this.prisma.store.findMany({ where: { active: true } });
    const storeCodes = stores.map((s) => s.code);
    const liveStock = await this.stock.getStockLive([cleanSku], storeCodes);

    // 4. Cache snapshot
    const cacheSnap = this.stock.snapshotCache([cleanSku], storeCodes);

    // Combina tudo por loja pra ficar visual
    const perStore = stores.map((s) => {
      const raw = rawRows.filter((r) => r.storeCode === s.code);
      const rawSum = raw.reduce((acc, r) => acc + r.qty, 0);
      const rawPositive = raw.filter((r) => r.qty > 0).reduce((acc, r) => acc + r.qty, 0);
      const engineWouldSee = liveStock.find((e) => e.storeCode === s.code)?.availableQty ?? 0;
      const cache = cacheSnap.find((c) => c.storeCode === s.code);
      return {
        storeCode: s.code,
        storeName: s.name,
        rawRows: raw, // linhas cruas (inclusive negativas/zero)
        rawRowCount: raw.length,
        rawSumQty: rawSum, // soma real (incluindo negativos)
        rawPositiveQty: rawPositive, // soma só das linhas positivas (o que a query ESTOQUE>0 retorna)
        engineWouldSee, // o que a engine receberia do stock service agora
        cachedQty: cache?.cachedQty ?? null,
        divergence:
          engineWouldSee !== rawSum
            ? `⚠ engine vê ${engineWouldSee} mas soma real é ${rawSum}`
            : null,
      };
    });

    return {
      sku: cleanSku,
      product,
      duplicatesInErp: duplicates,
      perStore,
      warnings: [
        ...(duplicates.length
          ? [`ERP tem linhas duplicadas pra CODIGO+LOJA: ${duplicates.map((d) => `${d.storeCode}(${d.rowCount} linhas, soma ${d.sumQty})`).join(', ')}`]
          : []),
        ...perStore
          .filter((p) => p.divergence)
          .map((p) => `${p.storeCode}: ${p.divergence}`),
      ],
    };
  }

  /**
   * GET /stock/giga-tables?search=credi
   *
   * DIAGNÓSTICO de schema do Gigasistemas — lista tabelas que batem com o
   * padrão (LIKE '%search%') e, para as 10 primeiras, devolve colunas +
   * 3 linhas de amostra + contagem de registros.
   *
   * Usado pra descobrir estruturas de tabelas pouco conhecidas (ex: crediarios,
   * vendedores, fidelidade) sem precisar dump do MySQL.
   */
  @Get('giga-tables')
  async gigaTables(@Query('search') search: string) {
    const pattern = (search || '').trim() || 'credi';
    return this.erp.listTablesLike(pattern);
  }
}
