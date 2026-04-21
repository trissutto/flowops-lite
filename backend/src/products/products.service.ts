import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { ErpService } from '../erp/erp.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ProductsService
 *
 * Proxy REST do WooCommerce pra produtos.
 * Endpoints do WC usados:
 *   GET /wc/v3/products                    → lista paginada
 *   GET /wc/v3/products/:id                → detalhe do produto
 *   GET /wc/v3/products/:id/variations     → variações (quando type=variable)
 *
 * Retorno é "achatado" com só os campos que a tela usa,
 * pra não jogar payload gigante no frontend.
 */
/**
 * Estado do sync em massa — mantido em memória (singleton do provider).
 * Não persiste em DB porque é estado volátil e o frontend faz polling.
 */
export interface BulkSyncState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  // ─── Pre-scan (fase 1, leve, decide o que processar) ───
  // Roda antes do loop principal: consulta WC + ERP em lote pra descartar
  // produtos já alinhados. Sem isso, o sync tocava todos os 1294 produtos
  // mesmo quando só ~50 estavam divergentes (waste de tempo e API calls).
  prescanRunning: boolean;
  prescanFinished: boolean;
  prescanTotalProducts: number;     // produtos variáveis no catálogo
  prescanProcessed: number;         // produtos analisados no pre-scan
  productsAlreadySynced: number;    // produtos pulados (já alinhados)
  // ─── Fase 3 (auto-rascunho: produtos publicados com estoque pai < threshold) ───
  // Roda DEPOIS do sync principal. Varre catálogo publicado inteiro (não só
  // os processados no sync) e baixa pra rascunho quem tem soma < 5.
  lowStockDraftRunning: boolean;
  lowStockDraftFinished: boolean;
  lowStockThreshold: number;        // padrão: 5
  lowStockCandidates: number;       // quantos produtos caíram na regra
  productsMarkedDraft: number;      // quantos PUT status=draft bem-sucedidos
  lowStockDraftFailed: number;      // falhas no PUT
  // ─── Loop principal (fase 2, processa só os divergentes) ───
  totalProducts: number;            // = produtos que vão ser processados
  processed: number;
  currentProductId: number | null;
  currentProductName: string | null;
  variationsUpdated: number;
  variationsUnchanged: number;
  variationsFailed: number;
  variationsSkipped: number;
  productsFailed: number;
  // Pais corrigidos SEM nenhuma variação ter sido alterada — ou seja,
  // casos onde só o produto pai estava dessincronizado da soma das filhas.
  parentsFixedStandalone: number;
  lastError: string | null;
  // Nome do arquivo de backup gerado DURANTE o sync (estado anterior).
  // Fica disponível assim que termina — botão "Baixar backup" aparece.
  backupFilename: string | null;
  backupVariationsCount: number;
  // Últimos 50 produtos processados (pra exibir log rolante)
  recentLog: Array<{
    productId: number;
    name: string;
    updated: number;
    failed: number;
    skipped: number;
    success: boolean;
    error?: string;
  }>;
}

/**
 * Auditoria de SKU — lista variações que foram PULADAS no sync
 * (sem SKU no site OU SKU não encontrado no ERP gigasistemas21).
 * Scan read-only — não faz nenhum PUT.
 */
export interface SkuAuditState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  totalProducts: number;
  processed: number;
  currentProductId: number | null;
  currentProductName: string | null;
  entriesFound: number;
  missingSkuCount: number;      // variações sem SKU no WC
  notInErpCount: number;        // variações com SKU mas não encontrado no ERP
  productsFailed: number;
  lastError: string | null;
}

export interface SkuAuditEntry {
  productId: number;
  productName: string;
  productSku: string | null;
  categories: string[];
  variationId: number;
  variationSku: string | null;
  variationAttrs: string;        // ex: "Tamanho 48 · Cor Azul"
  variationStock: number | null; // estoque atual no WC
  image: string | null;
  reason: 'sem-sku' | 'nao-encontrado';
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  private bulkSync: BulkSyncState = {
    running: false,
    startedAt: null,
    finishedAt: null,
    prescanRunning: false,
    prescanFinished: false,
    prescanTotalProducts: 0,
    prescanProcessed: 0,
    productsAlreadySynced: 0,
    lowStockDraftRunning: false,
    lowStockDraftFinished: false,
    lowStockThreshold: 5,
    lowStockCandidates: 0,
    productsMarkedDraft: 0,
    lowStockDraftFailed: 0,
    totalProducts: 0,
    processed: 0,
    currentProductId: null,
    currentProductName: null,
    variationsUpdated: 0,
    variationsUnchanged: 0,
    variationsFailed: 0,
    variationsSkipped: 0,
    productsFailed: 0,
    parentsFixedStandalone: 0,
    lastError: null,
    backupFilename: null,
    backupVariationsCount: 0,
    recentLog: [],
  };

  // Buffer de linhas pro backup gerado DURANTE o bulk sync.
  // Preenchido a partir dos `details.before` retornados pelo syncStockFromErp.
  private bulkBackupRows: Array<{ sku: string; stock_quantity: number }> = [];

  // ─── Auditoria de SKU ───
  private skuAuditState: SkuAuditState = {
    running: false,
    startedAt: null,
    finishedAt: null,
    totalProducts: 0,
    processed: 0,
    currentProductId: null,
    currentProductName: null,
    entriesFound: 0,
    missingSkuCount: 0,
    notInErpCount: 0,
    productsFailed: 0,
    lastError: null,
  };
  private skuAuditEntries: SkuAuditEntry[] = [];
  private skuAuditLastFinishedAt: string | null = null;

  // Estado do backup assíncrono
  private backupState: {
    running: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    totalProducts: number;
    processed: number;
    currentProductName: string | null;
    variationsCount: number;
    filename: string | null;
    savedPath: string | null;
    error: string | null;
  } = {
    running: false,
    startedAt: null,
    finishedAt: null,
    totalProducts: 0,
    processed: 0,
    currentProductName: null,
    variationsCount: 0,
    filename: null,
    savedPath: null,
    error: null,
  };

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly erp: ErpService,
    private readonly prisma: PrismaService,
  ) {}

  private get baseUrl() {
    return `${this.config.get('WC_URL')}/wp-json/wc/v3`;
  }
  private get auth() {
    return {
      username: this.config.get<string>('WC_CONSUMER_KEY') ?? '',
      password: this.config.get<string>('WC_CONSUMER_SECRET') ?? '',
    };
  }

  /**
   * Lista paginada de produtos.
   * Se o produto é variável, retorna também o número de variações e a SOMA
   * de estoque de todas as variações.
   */
  async list(params: {
    page?: number;
    perPage?: number;
    search?: string;
    status?: string; // publish (default), draft, any...
    stockStatus?: 'instock' | 'outofstock' | 'onbackorder';
  }) {
    const qs: any = {
      per_page: params.perPage ?? 50,
      page: params.page ?? 1,
      status: params.status ?? 'publish',
      orderby: 'date',
      order: 'desc',
    };
    if (params.search) qs.search = params.search;
    if (params.stockStatus) qs.stock_status = params.stockStatus;

    const res = await firstValueFrom(
      this.http.get(`${this.baseUrl}/products`, { auth: this.auth, params: qs }),
    );

    const list: any[] = res.data ?? [];

    const data = list.map((p) => this.flatten(p));

    return {
      data,
      total: Number(res.headers['x-wp-total'] ?? 0),
      totalPages: Number(res.headers['x-wp-totalpages'] ?? 0),
      page: qs.page,
    };
  }

  /**
   * Detalhe do produto + variações (se houver).
   */
  async getById(id: number) {
    const res = await firstValueFrom(
      this.http.get(`${this.baseUrl}/products/${id}`, { auth: this.auth }),
    );
    const p = res.data;
    const flat = this.flatten(p);

    let variations: any[] = [];
    if (p.type === 'variable' && Array.isArray(p.variations) && p.variations.length > 0) {
      variations = await this.fetchAllVariations(id);
    }

    // Busca estoque do ERP em paralelo — pega todos os SKUs envolvidos
    // (SKU do produto simples + SKUs de todas as variações) numa query só
    const allSkus = [
      p.sku,
      ...variations.map((v: any) => v.sku),
    ].filter((s) => !!s) as string[];

    const erpStockMap = allSkus.length > 0 ? await this.erp.getStockTotalBySkus(allSkus) : {};

    // Anexa o estoque ERP em cada variação.
    // erpSku: quando encontramos a SKU no gigasistemas21, exibimos o próprio SKU
    // (pois o match é por SKU exato). Quando null, indica "sem referência no ERP"
    // e serve pra tela de auditoria de SKUs divergentes/inexistentes.
    const variationsWithErp = variations.map((v) => ({
      ...v,
      erpStock: v.sku ? (erpStockMap[v.sku] ?? null) : null,
      erpSku:
        v.sku && erpStockMap[v.sku] !== undefined && erpStockMap[v.sku] !== null
          ? v.sku
          : null,
    }));

    return {
      ...flat,
      erpStock: p.sku ? (erpStockMap[p.sku] ?? null) : null,
      erpSku:
        p.sku && erpStockMap[p.sku] !== undefined && erpStockMap[p.sku] !== null
          ? p.sku
          : null,
      description: this.stripHtml(p.description ?? ''),
      shortDescription: this.stripHtml(p.short_description ?? ''),
      categories: (p.categories ?? []).map((c: any) => c.name),
      tags: (p.tags ?? []).map((t: any) => t.name),
      images: (p.images ?? []).map((i: any) => ({ src: i.src, alt: i.alt })),
      attributes: (p.attributes ?? []).map((a: any) => ({ name: a.name, options: a.options })),
      variations: variationsWithErp,
      // Resumo do estoque agregado (pra tela de listagem/detalhe)
      variationsStockSum:
        variations.length > 0
          ? variations.reduce((s, v) => s + (Number(v.stockQuantity) || 0), 0)
          : null,
      // Soma ERP — pra comparação rápida
      variationsErpStockSum:
        variationsWithErp.length > 0
          ? variationsWithErp.reduce((s, v) => s + (Number(v.erpStock) || 0), 0)
          : null,
    };
  }

  /**
   * Busca TODAS as variações de um produto (paginando internamente).
   */
  private async fetchAllVariations(productId: number): Promise<any[]> {
    const all: any[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const res = await firstValueFrom(
        this.http.get(`${this.baseUrl}/products/${productId}/variations`, {
          auth: this.auth,
          params: { per_page: perPage, page },
        }),
      );
      const list: any[] = res.data ?? [];
      if (list.length === 0) break;

      for (const v of list) {
        all.push({
          id: v.id,
          sku: v.sku || null,
          price: v.price ? Number(v.price) : null,
          regularPrice: v.regular_price ? Number(v.regular_price) : null,
          salePrice: v.sale_price ? Number(v.sale_price) : null,
          stockQuantity: v.stock_quantity ?? null,
          stockStatus: v.stock_status, // instock | outofstock | onbackorder
          manageStock: v.manage_stock,
          // Atributos: [{ name: 'Tamanho', option: '48' }, ...]
          attributes: (v.attributes ?? []).map((a: any) => ({
            name: a.name,
            option: a.option,
          })),
          image: v.image?.src ?? null,
        });
      }

      const totalPages = Number(res.headers['x-wp-totalpages'] ?? 1);
      if (page >= totalPages) break;
      page += 1;
    }

    // Ordena pelos atributos (ex: por tamanho crescente quando numérico)
    all.sort((a, b) => {
      const av = (a.attributes[0]?.option ?? '').toString();
      const bv = (b.attributes[0]?.option ?? '').toString();
      const an = Number(av);
      const bn = Number(bv);
      if (!isNaN(an) && !isNaN(bn)) return an - bn;
      return av.localeCompare(bv);
    });

    return all;
  }

  /**
   * Reduz o payload do WC pra só os campos que a lista precisa.
   */
  private flatten(p: any) {
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      sku: p.sku || null,
      type: p.type, // simple | variable | grouped | external
      status: p.status,
      permalink: p.permalink,
      price: p.price ? Number(p.price) : null,
      regularPrice: p.regular_price ? Number(p.regular_price) : null,
      salePrice: p.sale_price ? Number(p.sale_price) : null,
      priceRange: this.extractPriceRange(p),
      stockQuantity: p.stock_quantity ?? null,
      stockStatus: p.stock_status, // instock | outofstock | onbackorder
      manageStock: p.manage_stock,
      totalSales: p.total_sales ?? 0,
      image: p.images?.[0]?.src ?? null,
      categories: (p.categories ?? []).map((c: any) => c.name),
      dateModified: p.date_modified,
      variationsCount: Array.isArray(p.variations) ? p.variations.length : 0,
    };
  }

  private extractPriceRange(p: any): { min: number; max: number } | null {
    if (p.type !== 'variable') return null;
    // O WC costuma retornar price_html tipo "R$ 50,00 – R$ 80,00"
    // Aqui só aproximamos com regular_price/price quando tem
    return null;
  }

  private stripHtml(html: string): string {
    if (!html) return '';
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Sobrescreve o estoque das variações no WooCommerce com os valores vindos
   * do ERP (gigasistemas21) e atualiza o produto pai com a soma.
   *
   * Fluxo:
   *  1. Busca detalhe do produto (já traz erpStock por variação)
   *  2. Valida: tem que ser tipo "variable" e ter variações
   *  3. Para cada variação com SKU + ref no ERP, faz PUT no WC com stock_quantity = ERP
   *     (concorrência limitada pra não explodir o endpoint)
   *  4. Atualiza o produto pai com a soma (ERP das que atualizaram + WC das que faltavam)
   *  5. Grava log em integration_logs pra auditoria
   *  6. Retorna relatório detalhado pro frontend mostrar
   *
   * IMPORTANTE: é operação IRREVERSÍVEL no WooCommerce. O frontend deve fazer dupla
   * confirmação antes de chamar.
   */
  async syncStockFromErp(productId: number) {
    const detail = await this.getById(productId);

    if (detail.type !== 'variable') {
      throw new BadRequestException(
        'Esse produto não é do tipo variável. A sincronização só roda em produtos com variações.',
      );
    }

    const variations: any[] = (detail as any).variations ?? [];
    if (!variations.length) {
      throw new BadRequestException('Produto sem variações para sincronizar.');
    }

    // Separa em 3 baldes:
    //  - toUpdate:   tem SKU, tem ERP, e o valor é DIFERENTE do WC → PUT
    //  - unchanged:  tem SKU, tem ERP, mas WC === ERP → NÃO toca (sync incremental)
    //  - skipped:    sem SKU OU sem ref no ERP → pula
    const hasErpRef = (v: any) =>
      v.sku && v.erpStock !== null && v.erpStock !== undefined;

    const toUpdate = variations.filter(
      (v) => hasErpRef(v) && (Number(v.stockQuantity) || 0) !== Number(v.erpStock),
    );
    const unchanged = variations.filter(
      (v) => hasErpRef(v) && (Number(v.stockQuantity) || 0) === Number(v.erpStock),
    );
    const skipped = variations.filter((v) => !hasErpRef(v));

    const details: Array<{
      variationId: number;
      sku: string | null;
      attributes: any[];
      before: number | null;
      after: number | null;
      success: boolean;
      skipped?: boolean;
      unchanged?: boolean;
      reason?: string;
      error?: string;
    }> = [];

    // Registra as que já estavam iguais — aparecem no relatório como "inalteradas"
    for (const v of unchanged) {
      details.push({
        variationId: v.id,
        sku: v.sku,
        attributes: v.attributes,
        before: v.stockQuantity ?? 0,
        after: v.stockQuantity ?? 0,
        success: true,
        unchanged: true,
      });
    }

    // PUT em paralelo (concurrency = 5) pra não atropelar o WC
    const queue = [...toUpdate];
    const CONCURRENCY = 5;
    const workers: Promise<void>[] = [];

    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push(
        (async () => {
          while (queue.length) {
            const v = queue.shift();
            if (!v) break;
            const before = v.stockQuantity ?? null;
            const after = Number(v.erpStock) || 0;
            try {
              await firstValueFrom(
                this.http.put(
                  `${this.baseUrl}/products/${productId}/variations/${v.id}`,
                  {
                    stock_quantity: after,
                    manage_stock: true,
                    stock_status: after > 0 ? 'instock' : 'outofstock',
                  },
                  { auth: this.auth },
                ),
              );
              details.push({
                variationId: v.id,
                sku: v.sku,
                attributes: v.attributes,
                before,
                after,
                success: true,
              });
            } catch (e) {
              const msg = (e as any)?.response?.data?.message ?? (e as Error).message;
              this.logger.error(
                `Falha ao atualizar variação ${v.id} (SKU ${v.sku}): ${msg}`,
              );
              details.push({
                variationId: v.id,
                sku: v.sku,
                attributes: v.attributes,
                before,
                after,
                success: false,
                error: msg,
              });
            }
          }
        })(),
      );
    }
    await Promise.all(workers);

    // Adiciona as puladas no relatório (pra transparência)
    for (const v of skipped) {
      details.push({
        variationId: v.id,
        sku: v.sku,
        attributes: v.attributes,
        before: v.stockQuantity ?? null,
        after: v.stockQuantity ?? null,
        success: false,
        skipped: true,
        reason: !v.sku ? 'sem-sku' : 'sem-referencia-no-erp',
      });
    }

    // Soma final pro produto pai: ERP das que deram certo + WC das puladas/falhas
    // (mantém o estoque WC atual pras que não conseguiu tocar)
    const okDetails = details.filter((d) => d.success);
    const notOkVariations = variations.filter(
      (v) => !okDetails.some((d) => d.variationId === v.id),
    );
    const sumFromErp = okDetails.reduce((s, d) => s + (Number(d.after) || 0), 0);
    const sumKeptFromWc = notOkVariations.reduce(
      (s, v) => s + (Number(v.stockQuantity) || 0),
      0,
    );
    const parentAfter = sumFromErp + sumKeptFromWc;

    // PUT no pai acontece se:
    //   (a) alguma variação foi atualizada agora, OU
    //   (b) o estoque ATUAL do pai no WC não bate com a soma das variações
    //       (caso clássico de pai dessincronizado com filhas).
    // Só pula o PUT se já estiver tudo alinhado — economiza 1 request por produto.
    const variationsActuallyChanged = details.filter(
      (d) => d.success && !d.unchanged,
    ).length;
    const currentParentStock = Number((detail as any).stockQuantity) || 0;
    const parentOutOfSync = currentParentStock !== parentAfter;
    const parentNeedsUpdate = variationsActuallyChanged > 0 || parentOutOfSync;

    let parentUpdated = !parentNeedsUpdate; // se não precisou, considera "ok"
    let parentError: string | null = null;
    if (parentNeedsUpdate) {
      try {
        await firstValueFrom(
          this.http.put(
            `${this.baseUrl}/products/${productId}`,
            {
              stock_quantity: parentAfter,
              manage_stock: true,
              stock_status: parentAfter > 0 ? 'instock' : 'outofstock',
            },
            { auth: this.auth },
          ),
        );
        parentUpdated = true;
        if (parentOutOfSync && variationsActuallyChanged === 0) {
          this.logger.log(
            `🔧 Produto pai ${productId} dessincronizado corrigido: ${currentParentStock} → ${parentAfter}`,
          );
        }
      } catch (e) {
        parentUpdated = false;
        parentError = (e as any)?.response?.data?.message ?? (e as Error).message;
        this.logger.error(
          `Falha ao atualizar estoque do produto pai ${productId}: ${parentError}`,
        );
      }
    }

    const totalBefore = variations.reduce(
      (s, v) => s + (Number(v.stockQuantity) || 0),
      0,
    );

    const report = {
      productId,
      productName: detail.name,
      productSku: detail.sku,
      totalVariations: variations.length,
      // "Atualizadas" agora conta só as que REALMENTE tocaram no WC
      variationsUpdated: details.filter((d) => d.success && !d.unchanged).length,
      variationsUnchanged: unchanged.length,
      variationsFailed: details.filter((d) => !d.success && !d.skipped).length,
      variationsSkipped: skipped.length,
      parentBefore: currentParentStock,
      totalBefore,
      totalAfter: parentAfter,
      parentUpdated,
      parentNeedsUpdate,
      // Flag: pai foi corrigido SEM nenhuma variação ter sido alterada
      // (sintoma clássico de dessincronismo histórico)
      parentOnlyFix: parentOutOfSync && variationsActuallyChanged === 0,
      parentError,
      details,
      finishedAt: new Date().toISOString(),
    };

    // Auditoria
    try {
      await this.prisma.integrationLog.create({
        data: {
          source: 'erp->woocommerce',
          direction: 'out',
          event: 'product.sync-stock-from-erp',
          payload: JSON.stringify(report).slice(0, 60000),
          status: parentUpdated && report.variationsFailed === 0 ? 200 : 207,
        },
      });
    } catch (e) {
      this.logger.warn(
        `Falha ao gravar integration_log de sync stock: ${(e as Error).message}`,
      );
    }

    return report;
  }

  // ═══════════════════════════════════════════════════════════════
  // SYNC EM MASSA — ERP → WooCommerce (todos produtos variáveis)
  // ═══════════════════════════════════════════════════════════════

  getBulkSyncState(): BulkSyncState {
    return this.bulkSync;
  }

  /**
   * Inicia o sync em massa (fire-and-forget).
   * Se já estiver rodando, rejeita com BadRequest.
   */
  startBulkSync(): BulkSyncState {
    if (this.bulkSync.running) {
      throw new BadRequestException('Sync em massa já está em execução.');
    }

    this.bulkSync = {
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      prescanRunning: true,
      prescanFinished: false,
      prescanTotalProducts: 0,
      prescanProcessed: 0,
      productsAlreadySynced: 0,
      lowStockDraftRunning: false,
      lowStockDraftFinished: false,
      lowStockThreshold: 5,
      lowStockCandidates: 0,
      productsMarkedDraft: 0,
      lowStockDraftFailed: 0,
      totalProducts: 0,
      processed: 0,
      currentProductId: null,
      currentProductName: null,
      variationsUpdated: 0,
      variationsUnchanged: 0,
      variationsFailed: 0,
      variationsSkipped: 0,
      productsFailed: 0,
      parentsFixedStandalone: 0,
      lastError: null,
      backupFilename: null,
      backupVariationsCount: 0,
      recentLog: [],
    };
    this.bulkBackupRows = [];

    // Fire and forget — não aguarda
    this.runBulkSync().catch((e) => {
      this.logger.error(`Bulk sync crashou: ${(e as Error).message}`);
      this.bulkSync.running = false;
      this.bulkSync.finishedAt = new Date().toISOString();
      this.bulkSync.lastError = (e as Error).message;
    });

    return this.bulkSync;
  }

  /**
   * Loop principal do sync em massa.
   * - FASE 1 (pre-scan): lista variáveis + estoque WC leve, consulta ERP em lote
   *                      e descarta produtos já alinhados (sem divergência).
   * - FASE 2: pra cada produto divergente, chama syncStockFromErp(id) — que
   *           faz fetch full + PUTs.
   * - Tolera erros individuais
   * - Atualiza state em memória
   */
  private async runBulkSync() {
    const perPage = 100;
    let page = 1;
    const catalog: Array<{ id: number; name: string; parentStock: number }> = [];

    // PASSO 1: pega lista completa de produtos variáveis (com parent stock já)
    this.logger.log('🔄 Bulk sync: coletando lista de produtos variáveis...');
    while (true) {
      try {
        const res = await firstValueFrom(
          this.http.get(`${this.baseUrl}/products`, {
            auth: this.auth,
            params: {
              per_page: perPage,
              page,
              status: 'any',
              type: 'variable',
              orderby: 'id',
              order: 'asc',
              _fields: 'id,name,stock_quantity',
            },
          }),
        );
        const list: any[] = res.data ?? [];
        if (list.length === 0) break;
        for (const p of list) {
          catalog.push({
            id: p.id,
            name: p.name,
            parentStock: Number(p.stock_quantity) || 0,
          });
        }

        const totalPages = Number(res.headers['x-wp-totalpages'] ?? 1);
        this.logger.log(
          `   página ${page}/${totalPages} — ${list.length} produtos`,
        );
        if (page >= totalPages) break;
        page += 1;
      } catch (e) {
        this.bulkSync.lastError = `Falha ao listar produtos: ${(e as Error).message}`;
        this.logger.error(this.bulkSync.lastError);
        break;
      }
    }

    this.bulkSync.prescanTotalProducts = catalog.length;
    this.logger.log(
      `🔄 Bulk sync: ${catalog.length} produtos variáveis no catálogo — pre-scan iniciando`,
    );

    // PASSO 2 (PRE-SCAN): busca variações light de cada produto em paralelo,
    // monta lista global de SKUs, consulta ERP em lote único e decide o que processar.
    const variationsCache = new Map<
      number,
      Array<{ id: number; sku: string | null; stock_quantity: number | null }>
    >();

    const queue1 = [...catalog];
    const PRESCAN_CONCURRENCY = 15;
    const workers1: Promise<void>[] = [];
    for (let w = 0; w < PRESCAN_CONCURRENCY; w++) {
      workers1.push(
        (async () => {
          while (queue1.length) {
            const p = queue1.shift();
            if (!p) break;
            try {
              const vars = await this.fetchVariationsLite(p.id);
              variationsCache.set(
                p.id,
                vars.map((v) => ({
                  id: v.id,
                  sku: v.sku,
                  stock_quantity: v.stock_quantity,
                })),
              );
            } catch (e) {
              this.logger.warn(
                `Pre-scan: falha ao buscar variações de ${p.id}: ${(e as Error).message}`,
              );
              // Marca com null pra processar no loop principal (por segurança)
              variationsCache.set(p.id, []);
            }
            this.bulkSync.prescanProcessed += 1;
          }
        })(),
      );
    }
    await Promise.all(workers1);

    // Coleta todos os SKUs únicos
    const allSkus = new Set<string>();
    for (const [, vars] of variationsCache) {
      for (const v of vars) if (v.sku) allSkus.add(v.sku);
    }
    this.logger.log(
      `🔄 Pre-scan: ${allSkus.size} SKUs únicos — consultando ERP em lote`,
    );

    // ERP em lote (o MySQL processa 10k+ SKUs num SELECT IN sem drama)
    let erpStockMap: Record<string, number> = {};
    try {
      erpStockMap = await this.erp.getStockTotalBySkus(Array.from(allSkus));
    } catch (e) {
      this.logger.error(
        `Pre-scan: falha no ERP batch: ${(e as Error).message}. Processando todos produtos por segurança.`,
      );
    }

    // Decide quais produtos processar.
    // Critério: PRECISA sync se...
    //   a) Alguma variação tem SKU com ref no ERP e WC != ERP, OU
    //   b) Alguma variação tem SKU com ref no ERP e não estava no WC (stock null)
    //      → tratado como precisa sync (0 vs algum número ≠ 0 ou vice-versa),
    //   c) Soma(wcStock de variações) != parentStock (desalinhamento do pai),
    //   d) Pre-scan falhou em buscar variações (variationsCache vazio),
    //      pra não deixar buraco — segurança.
    const toProcess: Array<{ id: number; name: string }> = [];
    let alreadySynced = 0;
    for (const p of catalog) {
      const vars = variationsCache.get(p.id);
      if (!vars || vars.length === 0) {
        // Sem dados de variação → processa por segurança (pode ser produto raro
        // ou erro de fetch). Número deve ser baixo; não polui a lógica.
        toProcess.push({ id: p.id, name: p.name });
        continue;
      }

      let needs = false;
      for (const v of vars) {
        if (!v.sku) continue;
        const erpVal = erpStockMap[v.sku];
        if (erpVal === undefined || erpVal === null) continue; // sem ref → pula (não atualiza)
        const wcVal = Number(v.stock_quantity) || 0;
        if (wcVal !== Number(erpVal)) {
          needs = true;
          break;
        }
      }

      if (!needs) {
        // Checa desalinhamento do pai
        const sumWc = vars.reduce(
          (s, v) => s + (Number(v.stock_quantity) || 0),
          0,
        );
        if (sumWc !== p.parentStock) needs = true;
      }

      if (needs) {
        toProcess.push({ id: p.id, name: p.name });
      } else {
        alreadySynced += 1;
      }
    }

    this.bulkSync.productsAlreadySynced = alreadySynced;
    this.bulkSync.totalProducts = toProcess.length;
    this.bulkSync.prescanRunning = false;
    this.bulkSync.prescanFinished = true;
    this.logger.log(
      `✅ Pre-scan concluído: ${alreadySynced} já alinhados, ${toProcess.length} pra processar ` +
        `(redução de ${Math.round((alreadySynced / catalog.length) * 100)}%)`,
    );

    // PASSO 3: processa um por vez (sequencial no nível de produto,
    // mas syncStockFromErp já usa concurrency=5 nas variações)
    // Delay pequeno entre produtos pra não estressar o WC.
    for (const p of toProcess) {
      this.bulkSync.currentProductId = p.id;
      this.bulkSync.currentProductName = p.name;

      try {
        const report = await this.syncStockFromErp(p.id);
        this.bulkSync.variationsUpdated += report.variationsUpdated;
        this.bulkSync.variationsUnchanged += report.variationsUnchanged ?? 0;
        this.bulkSync.variationsFailed += report.variationsFailed;
        this.bulkSync.variationsSkipped += report.variationsSkipped;
        if (report.parentOnlyFix) {
          this.bulkSync.parentsFixedStandalone += 1;
        }

        // BACKUP INLINE: só salva no backup as variações que FORAM ALTERADAS.
        // Inalteradas não precisam de restore (ninguém mexeu no valor).
        for (const d of report.details) {
          if (
            d.sku &&
            !d.unchanged &&
            d.success &&
            d.before !== null &&
            d.before !== undefined
          ) {
            this.bulkBackupRows.push({
              sku: d.sku,
              stock_quantity: Number(d.before) || 0,
            });
            this.bulkSync.backupVariationsCount += 1;
          }
        }

        // Se o pai foi alterado (mudou variação OU correção standalone),
        // salva o SKU do pai no backup com o estoque ANTERIOR dele.
        if (report.parentUpdated && report.productSku && report.parentNeedsUpdate) {
          this.bulkBackupRows.push({
            sku: report.productSku,
            stock_quantity: Number(report.parentBefore) || 0,
          });
          this.bulkSync.backupVariationsCount += 1;
        }

        this.pushRecentLog({
          productId: p.id,
          name: p.name,
          updated: report.variationsUpdated,
          failed: report.variationsFailed,
          skipped: report.variationsSkipped,
          success: report.parentUpdated && report.variationsFailed === 0,
          error: report.parentError ?? undefined,
        });
      } catch (e) {
        this.bulkSync.productsFailed += 1;
        const msg = (e as Error).message;
        this.logger.error(`Bulk sync falhou no produto ${p.id} (${p.name}): ${msg}`);
        this.pushRecentLog({
          productId: p.id,
          name: p.name,
          updated: 0,
          failed: 0,
          skipped: 0,
          success: false,
          error: msg,
        });
      }

      this.bulkSync.processed += 1;
      // Delay entre produtos (200ms) — protege o WordPress/WC
      await new Promise((r) => setTimeout(r, 200));
    }

    // Gera o XLSX de backup (estado ANTES do sync) e salva em disco.
    // Isso roda mesmo que tenha dado erro em alguns produtos — preserva o que deu pra capturar.
    if (this.bulkBackupRows.length > 0) {
      try {
        const backupFilename = await this.writeBulkBackupXlsx(this.bulkBackupRows);
        this.bulkSync.backupFilename = backupFilename;
        this.logger.log(
          `📦 Backup inline gerado: ${backupFilename} (${this.bulkBackupRows.length} SKUs).`,
        );
      } catch (e) {
        this.logger.error(`Falha ao salvar backup inline: ${(e as Error).message}`);
      }
    }

    // ─── FASE 3: AUTO-RASCUNHO POR ESTOQUE BAIXO ───
    // Varre o catálogo INTEIRO de produtos publicados (não só os processados),
    // pega quem ficou com soma de estoque (parent.stock_quantity) abaixo do threshold,
    // e baixa pra rascunho. Importante: usa o stock_quantity DO PAI (que já reflete
    // a soma das variações, atualizada pelo sync acima OU já correta se foi pulado
    // no pre-scan).
    try {
      this.bulkSync.lowStockDraftRunning = true;
      const drafted = await this.draftLowStockProducts(
        this.bulkSync.lowStockThreshold,
      );
      this.bulkSync.lowStockCandidates = drafted.candidates;
      this.bulkSync.productsMarkedDraft = drafted.success;
      this.bulkSync.lowStockDraftFailed = drafted.failed;
      this.logger.log(
        `📝 Auto-rascunho: ${drafted.success}/${drafted.candidates} produtos marcados como rascunho ` +
          `(threshold: ${this.bulkSync.lowStockThreshold}).`,
      );
    } catch (e) {
      this.logger.error(
        `Falha na fase auto-rascunho: ${(e as Error).message}`,
      );
    } finally {
      this.bulkSync.lowStockDraftRunning = false;
      this.bulkSync.lowStockDraftFinished = true;
    }

    // FINALIZA
    this.bulkSync.running = false;
    this.bulkSync.finishedAt = new Date().toISOString();
    this.bulkSync.currentProductId = null;
    this.bulkSync.currentProductName = null;

    this.logger.log(
      `✅ Bulk sync concluído: ${this.bulkSync.processed} produtos, ` +
        `${this.bulkSync.variationsUpdated} variações atualizadas, ` +
        `${this.bulkSync.variationsFailed} falhas, ` +
        `${this.bulkSync.productsFailed} produtos com erro.`,
    );

    // Grava log consolidado
    try {
      await this.prisma.integrationLog.create({
        data: {
          source: 'erp->woocommerce',
          direction: 'out',
          event: 'product.sync-all-stock-from-erp',
          payload: JSON.stringify({
            totalProducts: this.bulkSync.totalProducts,
            processed: this.bulkSync.processed,
            variationsUpdated: this.bulkSync.variationsUpdated,
            variationsFailed: this.bulkSync.variationsFailed,
            variationsSkipped: this.bulkSync.variationsSkipped,
            productsFailed: this.bulkSync.productsFailed,
            startedAt: this.bulkSync.startedAt,
            finishedAt: this.bulkSync.finishedAt,
          }).slice(0, 60000),
          status: this.bulkSync.productsFailed === 0 ? 200 : 207,
        },
      });
    } catch (e) {
      this.logger.warn(`Falha ao gravar log consolidado de bulk sync: ${(e as Error).message}`);
    }
  }

  private pushRecentLog(entry: BulkSyncState['recentLog'][number]) {
    this.bulkSync.recentLog.unshift(entry);
    if (this.bulkSync.recentLog.length > 50) {
      this.bulkSync.recentLog.pop();
    }
  }

  /**
   * Escreve o XLSX de backup (2 colunas: sku | stock_quantity) usando as linhas
   * coletadas durante o sync. Ordena por SKU, salva em backend/backups/ e retorna o filename.
   * Se houver SKUs duplicados (ex: mesmo SKU em produtos diferentes no WC), preserva só
   * o PRIMEIRO valor visto — é o estado pré-sync mais antigo.
   */
  private async writeBulkBackupXlsx(
    rows: Array<{ sku: string; stock_quantity: number }>,
  ): Promise<string> {
    // Dedup por SKU (fica com o primeiro — estado mais próximo do "antes")
    const seen = new Map<string, number>();
    for (const r of rows) {
      if (!seen.has(r.sku)) seen.set(r.sku, r.stock_quantity);
    }
    const dedup = Array.from(seen.entries()).map(([sku, stock_quantity]) => ({
      sku,
      stock_quantity,
    }));
    dedup.sort((a, b) => a.sku.localeCompare(b.sku));

    const wb = new ExcelJS.Workbook();
    wb.creator = 'FlowOps Lite';
    wb.created = new Date();

    const ws = wb.addWorksheet('Backup Estoque WC', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = [
      { header: 'sku', key: 'sku', width: 22 },
      { header: 'stock_quantity', key: 'stock_quantity', width: 16 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE5E7EB' },
    };
    ws.addRows(dedup);

    const backupsDir = path.resolve(process.cwd(), 'backups');
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T.]/g, '')
      .slice(0, 14);
    const filename = `stock-backup-${stamp}.xlsx`;
    const savedPath = path.join(backupsDir, filename);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    fs.writeFileSync(savedPath, buffer);

    // Auditoria
    try {
      await this.prisma.integrationLog.create({
        data: {
          source: 'woocommerce->flowops',
          direction: 'in',
          event: 'stock-backup.inline-bulk-sync',
          payload: JSON.stringify({
            filename,
            savedPath,
            skusCount: dedup.length,
          }),
          status: 200,
        },
      });
    } catch {}

    return filename;
  }

  // ═══════════════════════════════════════════════════════════════
  // BACKUP E RESTORE DE ESTOQUE (XLSX)
  // ═══════════════════════════════════════════════════════════════

  getBackupState() {
    return this.backupState;
  }

  /**
   * Inicia a geração do backup de forma assíncrona (fire-and-forget).
   * Frontend faz polling em /stock-backup/status.
   */
  startBackupAsync() {
    if (this.backupState.running) {
      throw new BadRequestException('Backup já está em execução.');
    }
    this.backupState = {
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      totalProducts: 0,
      processed: 0,
      currentProductName: null,
      variationsCount: 0,
      filename: null,
      savedPath: null,
      error: null,
    };

    this.generateStockBackup().catch((e) => {
      this.backupState.running = false;
      this.backupState.finishedAt = new Date().toISOString();
      this.backupState.error = (e as Error).message;
      this.logger.error(`Backup async crashou: ${(e as Error).message}`);
    });

    return this.backupState;
  }

  /**
   * Lê o arquivo XLSX do backup pelo nome (pra download).
   */
  readBackupFile(filename: string): Buffer {
    // Sanitiza: só permite nomes tipo stock-backup-YYYYMMDDHHMMSS.xlsx
    if (!/^stock-backup-\d{14}\.xlsx$/.test(filename)) {
      throw new BadRequestException('Nome de arquivo inválido.');
    }
    const backupsDir = path.resolve(process.cwd(), 'backups');
    const fullPath = path.join(backupsDir, filename);
    if (!fs.existsSync(fullPath)) {
      throw new BadRequestException('Arquivo de backup não encontrado.');
    }
    return fs.readFileSync(fullPath);
  }

  /**
   * Gera um snapshot XLSX do estoque ATUAL do WooCommerce de TODOS os produtos
   * variáveis (e suas variações). Salva em backend/backups/ e atualiza backupState.
   *
   * Colunas:
   *   product_id | product_name | product_sku | product_stock_before |
   *   variation_id | variation_sku | variation_attrs | variation_stock_before
   *
   * O restore usa essas mesmas colunas pra reverter.
   */
  async generateStockBackup(): Promise<{
    buffer: Buffer;
    filename: string;
    savedPath: string;
    productsCount: number;
    variationsCount: number;
  }> {
    this.logger.log('📦 Gerando backup de estoque WC...');

    // Pega TODOS os produtos variáveis paginando
    const products: any[] = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const res = await firstValueFrom(
        this.http.get(`${this.baseUrl}/products`, {
          auth: this.auth,
          params: {
            per_page: perPage,
            page,
            status: 'any',
            type: 'variable',
            orderby: 'id',
            order: 'asc',
          },
        }),
      );
      const list: any[] = res.data ?? [];
      if (list.length === 0) break;
      products.push(...list);
      const totalPages = Number(res.headers['x-wp-totalpages'] ?? 1);
      if (page >= totalPages) break;
      page += 1;
    }

    // Workbook XLSX
    const wb = new ExcelJS.Workbook();
    wb.creator = 'FlowOps Lite';
    wb.created = new Date();

    const ws = wb.addWorksheet('Backup Estoque WC', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    // Só 2 colunas: SKU e quantidade (simplificado por pedido do usuário).
    // Restore resolve o SKU → produto/variação via GET /products?sku=X no WC.
    ws.columns = [
      { header: 'sku', key: 'sku', width: 22 },
      { header: 'stock_quantity', key: 'stock_quantity', width: 16 },
    ];

    // Header em negrito
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE5E7EB' },
    };

    let variationsCount = 0;

    // Atualiza state pro frontend acompanhar
    this.backupState.totalProducts = products.length;
    this.backupState.processed = 0;

    // Concurrency agressiva — backup é read-only, sem risco pro WC
    const CONCURRENCY = 15;
    const queue = [...products];
    const workers: Promise<void>[] = [];

    // Rows buffer: { sku, stock_quantity }
    const rows: Array<{ sku: string; stock_quantity: number }> = [];

    for (let w = 0; w < CONCURRENCY; w++) {
      workers.push(
        (async () => {
          while (queue.length) {
            const p = queue.shift();
            if (!p) break;
            this.backupState.currentProductName = p.name;
            try {
              const vars = await this.fetchVariationsLite(p.id);
              for (const v of vars) {
                if (!v.sku) continue; // sem SKU não dá pra restaurar
                rows.push({
                  sku: v.sku,
                  stock_quantity: Number(v.stock_quantity ?? 0),
                });
                variationsCount += 1;
              }
            } catch (e) {
              this.logger.warn(
                `Falha ao buscar variações do produto ${p.id} no backup: ${(e as Error).message}`,
              );
            }
            this.backupState.processed += 1;
            this.backupState.variationsCount = variationsCount;
          }
        })(),
      );
    }
    await Promise.all(workers);

    // Ordena alfabeticamente por SKU (fica organizado pra conferência manual)
    rows.sort((a, b) => a.sku.localeCompare(b.sku));
    ws.addRows(rows);

    // Salva em disco (pasta backups/)
    const backupsDir = path.resolve(process.cwd(), 'backups');
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T.]/g, '')
      .slice(0, 14); // YYYYMMDDHHMMSS
    const filename = `stock-backup-${stamp}.xlsx`;
    const savedPath = path.join(backupsDir, filename);

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    fs.writeFileSync(savedPath, buffer);

    this.logger.log(
      `✅ Backup gerado: ${filename} (${products.length} produtos, ${variationsCount} variações) — ${savedPath}`,
    );

    // Atualiza state final
    this.backupState.running = false;
    this.backupState.finishedAt = new Date().toISOString();
    this.backupState.filename = filename;
    this.backupState.savedPath = savedPath;
    this.backupState.currentProductName = null;
    this.backupState.variationsCount = variationsCount;

    // Log de auditoria
    try {
      await this.prisma.integrationLog.create({
        data: {
          source: 'woocommerce->flowops',
          direction: 'in',
          event: 'stock-backup.generated',
          payload: JSON.stringify({
            filename,
            savedPath,
            productsCount: products.length,
            variationsCount,
          }),
          status: 200,
        },
      });
    } catch {}

    return {
      buffer,
      filename,
      savedPath,
      productsCount: products.length,
      variationsCount,
    };
  }

  /**
   * Versão enxuta de fetchAllVariations — só traz o necessário pro backup
   * (id, sku, stock_quantity, attrs). Sem ordenação extra.
   */
  private async fetchVariationsLite(
    productId: number,
  ): Promise<Array<{ id: number; sku: string | null; stock_quantity: number | null; attrs: string }>> {
    const all: Array<{ id: number; sku: string | null; stock_quantity: number | null; attrs: string }> = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const res = await firstValueFrom(
        this.http.get(`${this.baseUrl}/products/${productId}/variations`, {
          auth: this.auth,
          params: { per_page: perPage, page, _fields: 'id,sku,stock_quantity,attributes' },
        }),
      );
      const list: any[] = res.data ?? [];
      if (list.length === 0) break;
      for (const v of list) {
        all.push({
          id: v.id,
          sku: v.sku || null,
          stock_quantity: v.stock_quantity ?? null,
          attrs: (v.attributes ?? [])
            .map((a: any) => `${a.name}:${a.option}`)
            .join(' | '),
        });
      }
      const totalPages = Number(res.headers['x-wp-totalpages'] ?? 1);
      if (page >= totalPages) break;
      page += 1;
    }
    return all;
  }

  /**
   * Restaura o estoque do WooCommerce a partir de um arquivo XLSX de backup.
   * Arquivo precisa ter 2 colunas: sku | stock_quantity.
   *
   * Pra cada linha:
   *   1) Resolve SKU → product_id/variation_id via GET /products?sku=X (WC retorna match exato)
   *   2) Faz PUT no item encontrado
   *   3) Se for variação, soma o estoque do pai no final
   *
   * IMPORTANTE: isso sobrescreve o estoque do WC.
   */
  async restoreStockFromBackup(xlsxBuffer: Buffer): Promise<{
    variationsRestored: number;
    variationsFailed: number;
    productsUpdated: number;
    details: Array<{
      sku: string;
      productId: number | null;
      variationId: number | null;
      restoredTo: number | null;
      success: boolean;
      error?: string;
    }>;
  }> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsxBuffer as any);
    const ws = wb.worksheets[0];
    if (!ws) {
      throw new BadRequestException('Arquivo XLSX inválido — sem planilhas.');
    }

    // Lê rows { sku, stock_quantity } pulando header
    const rows: Array<{ sku: string; stock_quantity: number }> = [];
    ws.eachRow((row, idx) => {
      if (idx === 1) return; // header
      const sku = row.getCell(1).value ? String(row.getCell(1).value).trim() : '';
      const qtyRaw = row.getCell(2).value;
      if (!sku) return;
      rows.push({
        sku,
        stock_quantity: qtyRaw === null || qtyRaw === '' ? 0 : Number(qtyRaw),
      });
    });

    if (!rows.length) {
      throw new BadRequestException('Arquivo sem linhas válidas (esperado: sku | stock_quantity).');
    }

    const details: Array<{
      sku: string;
      productId: number | null;
      variationId: number | null;
      restoredTo: number | null;
      success: boolean;
      error?: string;
    }> = [];

    // Agrupa variações por produto pai pra recalcular a soma depois
    const parentStockAccumulator = new Map<number, number>();

    // Processa em paralelo (concurrency=5)
    const queue = [...rows];
    const CONCURRENCY = 5;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < CONCURRENCY; w++) {
      workers.push(
        (async () => {
          while (queue.length) {
            const r = queue.shift();
            if (!r) break;
            try {
              const resolved = await this.resolveSkuToIds(r.sku);
              if (!resolved) {
                details.push({
                  sku: r.sku,
                  productId: null,
                  variationId: null,
                  restoredTo: null,
                  success: false,
                  error: 'SKU não encontrado no WC',
                });
                continue;
              }

              const endpoint = resolved.variationId
                ? `${this.baseUrl}/products/${resolved.productId}/variations/${resolved.variationId}`
                : `${this.baseUrl}/products/${resolved.productId}`;

              await firstValueFrom(
                this.http.put(
                  endpoint,
                  {
                    stock_quantity: r.stock_quantity,
                    manage_stock: true,
                    stock_status: r.stock_quantity > 0 ? 'instock' : 'outofstock',
                  },
                  { auth: this.auth },
                ),
              );

              // Acumula pra atualizar o pai
              if (resolved.variationId) {
                parentStockAccumulator.set(
                  resolved.productId,
                  (parentStockAccumulator.get(resolved.productId) ?? 0) + r.stock_quantity,
                );
              }

              details.push({
                sku: r.sku,
                productId: resolved.productId,
                variationId: resolved.variationId,
                restoredTo: r.stock_quantity,
                success: true,
              });
            } catch (e) {
              const msg = (e as any)?.response?.data?.message ?? (e as Error).message;
              details.push({
                sku: r.sku,
                productId: null,
                variationId: null,
                restoredTo: r.stock_quantity,
                success: false,
                error: msg,
              });
            }
          }
        })(),
      );
    }
    await Promise.all(workers);

    // Atualiza produtos pais com a soma
    let productsUpdated = 0;
    for (const [productId, sum] of parentStockAccumulator) {
      try {
        await firstValueFrom(
          this.http.put(
            `${this.baseUrl}/products/${productId}`,
            {
              stock_quantity: sum,
              manage_stock: true,
              stock_status: sum > 0 ? 'instock' : 'outofstock',
            },
            { auth: this.auth },
          ),
        );
        productsUpdated += 1;
      } catch (e) {
        this.logger.warn(
          `Falha ao restaurar produto pai ${productId}: ${(e as Error).message}`,
        );
      }
    }

    const variationsRestored = details.filter((d) => d.success).length;
    const variationsFailed = details.filter((d) => !d.success).length;

    try {
      await this.prisma.integrationLog.create({
        data: {
          source: 'flowops->woocommerce',
          direction: 'out',
          event: 'stock-backup.restored',
          payload: JSON.stringify({
            variationsRestored,
            variationsFailed,
            productsUpdated,
          }),
          status: variationsFailed === 0 ? 200 : 207,
        },
      });
    } catch {}

    this.logger.log(
      `↩️  Restore concluído: ${variationsRestored} SKUs restaurados, ${variationsFailed} falhas, ${productsUpdated} produtos pais atualizados.`,
    );

    return { variationsRestored, variationsFailed, productsUpdated, details };
  }

  /**
   * Resolve SKU → { productId, variationId? }.
   * Usa o endpoint /products?sku=X do WC que retorna match exato por SKU.
   * Se o SKU for de uma variação, primeiro acha o produto pai depois busca a variação.
   */
  private async resolveSkuToIds(
    sku: string,
  ): Promise<{ productId: number; variationId: number | null } | null> {
    // 1) tenta produto simples ou pai com esse SKU
    const res = await firstValueFrom(
      this.http.get(`${this.baseUrl}/products`, {
        auth: this.auth,
        params: { sku, per_page: 1, _fields: 'id,type' },
      }),
    );
    const list: any[] = res.data ?? [];
    if (list.length > 0) {
      // SKU direto no produto (simples ou no pai)
      return { productId: Number(list[0].id), variationId: null };
    }

    // 2) Não achou em produtos — pode ser SKU de variação.
    // O WC expõe endpoint global de busca: GET /wc/v3/products/variations?sku=X
    // Mas nem sempre está disponível dependendo da versão.
    // Estratégia alternativa: percorre produtos variáveis do cache local? Não temos.
    // Vamos tentar o endpoint de variations:
    try {
      const r2 = await firstValueFrom(
        this.http.get(`${this.baseUrl}/products/variations`, {
          auth: this.auth,
          params: { sku, per_page: 1, _fields: 'id,parent_id' },
        }),
      );
      const l2: any[] = r2.data ?? [];
      if (l2.length > 0) {
        return {
          productId: Number(l2[0].parent_id),
          variationId: Number(l2[0].id),
        };
      }
    } catch {
      // endpoint global pode não existir — ignora
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // DIAGNÓSTICO ERP — descobrir schema da tabela produtos
  // ═══════════════════════════════════════════════════════════════

  describeErpProductsTable() {
    return this.erp.describeProductsTable();
  }

  describeErpSalesTable() {
    return this.erp.describeSalesTable();
  }

  searchErpProductsLike(q: string) {
    return this.erp.searchProductsLike(q || '');
  }

  async testErpStock(skus: string[]): Promise<{
    input: string[];
    result: Record<string, number>;
    found: number;
    missing: string[];
  }> {
    const result = await this.erp.getStockTotalBySkus(skus);
    const missing = skus.filter((s) => !(s in result));
    return {
      input: skus,
      result,
      found: Object.keys(result).length,
      missing,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // AUTO-RASCUNHO POR ESTOQUE BAIXO
  // ═══════════════════════════════════════════════════════════════
  //
  // Regra: produtos publicados cujo estoque total (stock_quantity do pai,
  // que já é a soma das variações quando é produto variável) estiver
  // ABAIXO do threshold (default: 5) são marcados como rascunho.
  //
  // IMPORTANTE: o critério é a SOMA das variações, não variação individual.
  // Ex: se um produto tem 3 variações com estoque 2/2/1, a soma é 5 — NÃO
  // cai em rascunho. Se tem 2 variações com 1/3, soma é 4 — CAI em rascunho.
  //
  // Ignora:
  //  - produtos que não gerenciam estoque (manage_stock=false, stock=null)
  //    porque não temos como avaliar
  //  - produtos já em rascunho (nada a fazer)
  //  - produtos com estoque >= threshold
  //
  // Retorna: { candidates, success, failed, items[] }.
  // Faz PUT concurrent=5.

  /**
   * Escaneia produtos publicados e retorna os que caem na regra do threshold.
   * Se apply=false, só devolve a lista (preview, sem tocar no WC).
   * Se apply=true, faz PUT status=draft em todos.
   */
  async draftLowStockScan(
    threshold: number,
    apply: boolean,
  ): Promise<{
    threshold: number;
    scannedProducts: number;
    candidates: number;
    success: number;
    failed: number;
    items: Array<{
      productId: number;
      name: string;
      stockQuantity: number | null;
      type: string;
      applied: boolean;
      error?: string;
    }>;
  }> {
    if (!Number.isInteger(threshold) || threshold < 0) {
      throw new BadRequestException(
        `Threshold inválido: ${threshold} (esperado inteiro >= 0).`,
      );
    }

    // 1) Pagina todos produtos publicados (qualquer tipo)
    const publishedProducts: Array<{
      id: number;
      name: string;
      type: string;
      stockQuantity: number | null;
      manageStock: boolean;
    }> = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      try {
        const res = await firstValueFrom(
          this.http.get(`${this.baseUrl}/products`, {
            auth: this.auth,
            params: {
              per_page: perPage,
              page,
              status: 'publish',
              orderby: 'id',
              order: 'asc',
              _fields: 'id,name,type,stock_quantity,manage_stock',
            },
          }),
        );
        const list: any[] = res.data ?? [];
        if (list.length === 0) break;
        for (const p of list) {
          publishedProducts.push({
            id: p.id,
            name: p.name,
            type: p.type,
            stockQuantity:
              p.stock_quantity === null || p.stock_quantity === undefined
                ? null
                : Number(p.stock_quantity),
            manageStock: Boolean(p.manage_stock),
          });
        }
        const totalPages = Number(res.headers['x-wp-totalpages'] ?? 1);
        if (page >= totalPages) break;
        page += 1;
      } catch (e) {
        this.logger.error(
          `draftLowStockScan: falha paginando /products: ${(e as Error).message}`,
        );
        break;
      }
    }

    // 2) Filtra candidatos
    const candidates = publishedProducts.filter(
      (p) =>
        p.manageStock &&
        p.stockQuantity !== null &&
        p.stockQuantity < threshold,
    );

    const items: Array<{
      productId: number;
      name: string;
      stockQuantity: number | null;
      type: string;
      applied: boolean;
      error?: string;
    }> = candidates.map((c) => ({
      productId: c.id,
      name: c.name,
      stockQuantity: c.stockQuantity,
      type: c.type,
      applied: false,
    }));

    // 3) Se for só preview, retorna
    if (!apply) {
      return {
        threshold,
        scannedProducts: publishedProducts.length,
        candidates: candidates.length,
        success: 0,
        failed: 0,
        items,
      };
    }

    // 4) Aplica: PUT status=draft concurrent=5
    const queue = [...items];
    const CONCURRENCY = 5;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < CONCURRENCY; w++) {
      workers.push(
        (async () => {
          while (queue.length) {
            const it = queue.shift();
            if (!it) break;
            try {
              await firstValueFrom(
                this.http.put(
                  `${this.baseUrl}/products/${it.productId}`,
                  { status: 'draft' },
                  { auth: this.auth },
                ),
              );
              it.applied = true;
            } catch (e) {
              const msg =
                (e as any)?.response?.data?.message ?? (e as Error).message;
              it.applied = false;
              it.error = msg;
              this.logger.error(
                `draftLowStockScan: falha ao draftear ${it.productId} (${it.name}): ${msg}`,
              );
            }
          }
        })(),
      );
    }
    await Promise.all(workers);

    const success = items.filter((i) => i.applied).length;
    const failed = items.filter((i) => !i.applied).length;

    // Log consolidado
    try {
      await this.prisma.integrationLog.create({
        data: {
          source: 'flowops->woocommerce',
          direction: 'out',
          event: 'draft-low-stock',
          payload: JSON.stringify({
            threshold,
            scannedProducts: publishedProducts.length,
            candidates: candidates.length,
            success,
            failed,
            // só amostra — não polui
            sampleCandidates: items.slice(0, 20).map((i) => ({
              id: i.productId,
              name: i.name,
              stock: i.stockQuantity,
            })),
          }).slice(0, 60000),
          status: failed === 0 ? 200 : 207,
        },
      });
    } catch {}

    return {
      threshold,
      scannedProducts: publishedProducts.length,
      candidates: candidates.length,
      success,
      failed,
      items,
    };
  }

  /**
   * Atalho interno usado pela fase 3 do bulk sync: aplica o draft.
   */
  private async draftLowStockProducts(threshold: number): Promise<{
    candidates: number;
    success: number;
    failed: number;
  }> {
    const r = await this.draftLowStockScan(threshold, true);
    return {
      candidates: r.candidates,
      success: r.success,
      failed: r.failed,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // CORREÇÃO DE SKU COM SUFIXO -N (artefato do WooCommerce)
  // ═══════════════════════════════════════════════════════════════
  //
  // Muitas variações antigas ficaram com SKU tipo "11328001-1" porque o WC
  // colide com duplicatas na importação e anexa -1 / -2 automaticamente.
  // A SKU "original" (11328001) existe no Gigasistemas, mas por causa do
  // sufixo o match não acontece.
  //
  // Esse bloco implementa o fluxo:
  //   1) PREVIEW  — lista candidatos e classifica
  //        - corrigivel            → base existe no ERP e não tem conflito
  //        - conflito              → base existe, mas OUTRA variação do mesmo
  //                                   produto já está usando o base (raro)
  //        - base-nao-existe-erp   → tirar o sufixo não resolve (descatalogado)
  //
  //   2) APPLY    — aplica a correção nas variações marcadas como 'corrigivel'
  //                 (ou explicitamente passadas pelo front), PUT /variations/:id
  //                 com a nova SKU. Depois roda bulk sync normal.

  /**
   * Regex do sufixo: hífen + 1 a 3 dígitos no final (ex: "-1", "-2", "-12").
   * Não pega padrões tipo "VSM-021" porque o usuário pediu pra ignorar
   * (8 casos VSM-021 são de outra natureza — loja/coleção antiga).
   * Regra explícita: sufixo DEVE ser numérico de 1 a 2 dígitos apenas.
   */
  private readonly DASH_SUFFIX_RE = /^(.+?)-(\d{1,2})$/;

  /**
   * Preview: identifica variações com sufixo -N corrigível.
   * Usa skuAuditEntries em memória (precisa rodar /sku-audit/start antes).
   */
  async previewSkuDashFix(): Promise<{
    generatedAt: string;
    totalAuditEntries: number;
    candidates: Array<{
      productId: number;
      productName: string;
      productSku: string | null;
      variationId: number;
      variationAttrs: string;
      oldSku: string;
      baseSku: string;
      currentWcStock: number | null;
      erpStockAtBase: number | null;
      status: 'corrigivel' | 'conflito' | 'base-nao-existe-erp';
      conflictWithVariationId: number | null;
      conflictWithVariationSku: string | null;
    }>;
    summary: {
      corrigivel: number;
      conflito: number;
      baseNaoExisteErp: number;
    };
  }> {
    if (this.skuAuditEntries.length === 0) {
      throw new BadRequestException(
        'Rode a auditoria de SKU primeiro (/sku-audit/start).',
      );
    }

    // 1) Filtra entries com sufixo -N (só as "não encontrado no ERP")
    const rawCandidates: Array<{
      entry: SkuAuditEntry;
      baseSku: string;
    }> = [];
    for (const e of this.skuAuditEntries) {
      if (e.reason !== 'nao-encontrado' || !e.variationSku) continue;
      const m = e.variationSku.match(this.DASH_SUFFIX_RE);
      if (!m) continue;
      rawCandidates.push({ entry: e, baseSku: m[1] });
    }

    if (rawCandidates.length === 0) {
      return {
        generatedAt: new Date().toISOString(),
        totalAuditEntries: this.skuAuditEntries.length,
        candidates: [],
        summary: { corrigivel: 0, conflito: 0, baseNaoExisteErp: 0 },
      };
    }

    // 2) Consulta TODOS os base SKUs no ERP de uma vez
    const uniqueBases = Array.from(new Set(rawCandidates.map((c) => c.baseSku)));
    const erpStockMap = await this.erp.getStockTotalBySkus(uniqueBases);

    // 3) Pra detectar conflito: agrupa candidatos por productId e pega as
    //    variações do produto via WC (uma chamada por produto).
    //    Conflito = OUTRA variação do mesmo produto já usa o baseSku como SKU.
    const byProduct = new Map<number, typeof rawCandidates>();
    for (const c of rawCandidates) {
      const pid = c.entry.productId;
      if (!byProduct.has(pid)) byProduct.set(pid, []);
      byProduct.get(pid)!.push(c);
    }

    // Mapa: productId -> variações (id, sku)
    const productVariations = new Map<
      number,
      Array<{ id: number; sku: string | null }>
    >();
    // Fetch concurrency=5 pra não martelar o WC
    const productIds = Array.from(byProduct.keys());
    const queue = [...productIds];
    const CONCURRENCY = 5;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < CONCURRENCY; w++) {
      workers.push(
        (async () => {
          while (queue.length) {
            const pid = queue.shift();
            if (pid === undefined) break;
            try {
              const vars = await this.fetchVariationsLite(pid);
              productVariations.set(
                pid,
                vars.map((v) => ({ id: v.id, sku: v.sku })),
              );
            } catch (e) {
              this.logger.warn(
                `previewSkuDashFix: falha ao buscar variações do produto ${pid}: ${(e as Error).message}`,
              );
              productVariations.set(pid, []);
            }
          }
        })(),
      );
    }
    await Promise.all(workers);

    // 4) Classifica cada candidato
    const candidates: Array<{
      productId: number;
      productName: string;
      productSku: string | null;
      variationId: number;
      variationAttrs: string;
      oldSku: string;
      baseSku: string;
      currentWcStock: number | null;
      erpStockAtBase: number | null;
      status: 'corrigivel' | 'conflito' | 'base-nao-existe-erp';
      conflictWithVariationId: number | null;
      conflictWithVariationSku: string | null;
    }> = [];

    for (const c of rawCandidates) {
      const e = c.entry;
      const baseExistsInErp = c.baseSku in erpStockMap;
      const erpVal = baseExistsInErp ? erpStockMap[c.baseSku] : null;

      // Checa conflito no MESMO produto
      const siblings = productVariations.get(e.productId) ?? [];
      const conflict = siblings.find(
        (s) => s.id !== e.variationId && s.sku === c.baseSku,
      );

      let status: 'corrigivel' | 'conflito' | 'base-nao-existe-erp';
      if (!baseExistsInErp) {
        status = 'base-nao-existe-erp';
      } else if (conflict) {
        status = 'conflito';
      } else {
        status = 'corrigivel';
      }

      candidates.push({
        productId: e.productId,
        productName: e.productName,
        productSku: e.productSku,
        variationId: e.variationId,
        variationAttrs: e.variationAttrs,
        oldSku: e.variationSku!,
        baseSku: c.baseSku,
        currentWcStock: e.variationStock,
        erpStockAtBase: erpVal,
        status,
        conflictWithVariationId: conflict ? conflict.id : null,
        conflictWithVariationSku: conflict ? conflict.sku : null,
      });
    }

    const summary = {
      corrigivel: candidates.filter((c) => c.status === 'corrigivel').length,
      conflito: candidates.filter((c) => c.status === 'conflito').length,
      baseNaoExisteErp: candidates.filter(
        (c) => c.status === 'base-nao-existe-erp',
      ).length,
    };

    return {
      generatedAt: new Date().toISOString(),
      totalAuditEntries: this.skuAuditEntries.length,
      candidates,
      summary,
    };
  }

  /**
   * Aplica a correção nas variações passadas. Formato do input:
   *   [{ productId, variationId, oldSku, newSku }]
   * Faz PUT /products/:pid/variations/:vid com { sku: newSku }.
   *
   * IMPORTANTE: não valida conflito aqui (confia no preview). Mas o WC
   * pode rejeitar se já existe SKU igual em outro lugar — captura erro
   * por item e retorna detalhado.
   */
  async applySkuDashFix(
    items: Array<{
      productId: number;
      variationId: number;
      oldSku: string;
      newSku: string;
    }>,
  ): Promise<{
    total: number;
    success: number;
    failed: number;
    details: Array<{
      productId: number;
      variationId: number;
      oldSku: string;
      newSku: string;
      success: boolean;
      error?: string;
    }>;
  }> {
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('Lista de correções vazia.');
    }

    // Valida shape
    for (const it of items) {
      if (!it.productId || !it.variationId || !it.oldSku || !it.newSku) {
        throw new BadRequestException(
          `Item inválido: ${JSON.stringify(it)}`,
        );
      }
      if (it.oldSku === it.newSku) {
        throw new BadRequestException(
          `oldSku === newSku para variação ${it.variationId}.`,
        );
      }
    }

    const details: Array<{
      productId: number;
      variationId: number;
      oldSku: string;
      newSku: string;
      success: boolean;
      error?: string;
    }> = [];

    const queue = [...items];
    const CONCURRENCY = 5;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < CONCURRENCY; w++) {
      workers.push(
        (async () => {
          while (queue.length) {
            const it = queue.shift();
            if (!it) break;
            try {
              await firstValueFrom(
                this.http.put(
                  `${this.baseUrl}/products/${it.productId}/variations/${it.variationId}`,
                  { sku: it.newSku },
                  { auth: this.auth },
                ),
              );
              details.push({ ...it, success: true });
            } catch (e) {
              const msg =
                (e as any)?.response?.data?.message ?? (e as Error).message;
              this.logger.error(
                `applySkuDashFix falhou em var=${it.variationId}: ${msg}`,
              );
              details.push({ ...it, success: false, error: msg });
            }
          }
        })(),
      );
    }
    await Promise.all(workers);

    const success = details.filter((d) => d.success).length;
    const failed = details.length - success;

    // Log consolidado
    try {
      await this.prisma.integrationLog.create({
        data: {
          source: 'flowops->woocommerce',
          direction: 'out',
          event: 'sku-fix.dash-suffix',
          payload: JSON.stringify({
            total: items.length,
            success,
            failed,
            // só um resumo — não joga tudo no payload
            sampleFailures: details.filter((d) => !d.success).slice(0, 10),
          }).slice(0, 60000),
          status: failed === 0 ? 200 : 207,
        },
      });
    } catch {}

    // Invalida a auditoria em memória — os SKUs mudaram, auditoria antiga
    // não reflete mais a realidade. Força o user a rodar de novo.
    if (success > 0) {
      this.skuAuditEntries = [];
      this.skuAuditLastFinishedAt = null;
    }

    return { total: items.length, success, failed, details };
  }

  // ═══════════════════════════════════════════════════════════════
  // AUDITORIA DE SKU — lista variações puladas (read-only, sem PUT)
  // ═══════════════════════════════════════════════════════════════

  getSkuAuditState(): SkuAuditState & { lastFinishedAt: string | null; hasResult: boolean } {
    return {
      ...this.skuAuditState,
      lastFinishedAt: this.skuAuditLastFinishedAt,
      hasResult: this.skuAuditEntries.length > 0,
    };
  }

  getSkuAuditResult(): {
    state: SkuAuditState & { lastFinishedAt: string | null };
    entries: SkuAuditEntry[];
  } {
    return {
      state: { ...this.skuAuditState, lastFinishedAt: this.skuAuditLastFinishedAt },
      entries: this.skuAuditEntries,
    };
  }

  startSkuAudit(): SkuAuditState {
    if (this.skuAuditState.running) {
      throw new BadRequestException('Auditoria de SKU já está em execução.');
    }
    this.skuAuditState = {
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      totalProducts: 0,
      processed: 0,
      currentProductId: null,
      currentProductName: null,
      entriesFound: 0,
      missingSkuCount: 0,
      notInErpCount: 0,
      productsFailed: 0,
      lastError: null,
    };
    this.skuAuditEntries = [];

    // Fire-and-forget
    this.runSkuAudit().catch((e) => {
      this.logger.error(`SKU audit crashou: ${(e as Error).message}`);
      this.skuAuditState.running = false;
      this.skuAuditState.finishedAt = new Date().toISOString();
      this.skuAuditState.lastError = (e as Error).message;
    });

    return this.skuAuditState;
  }

  /**
   * Scan READ-ONLY de todos produtos variáveis.
   * Pra cada variação: se sem SKU → bucket 'sem-sku'.
   *                    se SKU não existe no ERP → bucket 'nao-encontrado'.
   * Nenhum PUT é disparado. Muito mais rápido que o bulk sync.
   */
  private async runSkuAudit() {
    const perPage = 100;
    let page = 1;
    const allProducts: Array<{ id: number; name: string; sku: string | null; categories: string[] }> = [];

    // 1) Coleta lista de produtos variáveis
    this.logger.log('🔎 SKU audit: coletando lista de produtos variáveis...');
    while (true) {
      try {
        const res = await firstValueFrom(
          this.http.get(`${this.baseUrl}/products`, {
            auth: this.auth,
            params: {
              per_page: perPage,
              page,
              status: 'any',
              type: 'variable',
              orderby: 'id',
              order: 'asc',
              _fields: 'id,name,sku,categories',
            },
          }),
        );
        const list: any[] = res.data ?? [];
        if (list.length === 0) break;
        for (const p of list) {
          allProducts.push({
            id: p.id,
            name: p.name,
            sku: p.sku || null,
            categories: (p.categories ?? []).map((c: any) => c.name),
          });
        }
        const totalPages = Number(res.headers['x-wp-totalpages'] ?? 1);
        if (page >= totalPages) break;
        page += 1;
      } catch (e) {
        this.skuAuditState.lastError = `Falha ao listar produtos: ${(e as Error).message}`;
        this.logger.error(this.skuAuditState.lastError);
        break;
      }
    }

    this.skuAuditState.totalProducts = allProducts.length;
    this.logger.log(`🔎 SKU audit: ${allProducts.length} produtos variáveis pra varrer`);

    // 2) Pra cada produto, pega variações + consulta ERP em lote por produto
    for (const p of allProducts) {
      this.skuAuditState.currentProductId = p.id;
      this.skuAuditState.currentProductName = p.name;

      try {
        const variations = await this.fetchAllVariations(p.id);

        // Consulta ERP em lote só com os SKUs não vazios
        const skusToCheck = variations
          .map((v) => v.sku)
          .filter((s): s is string => !!s);
        const erpMap =
          skusToCheck.length > 0
            ? await this.erp.getStockTotalBySkus(skusToCheck)
            : {};

        for (const v of variations) {
          const attrs =
            (v.attributes ?? [])
              .map((a: any) => `${a.name} ${a.option}`)
              .join(' · ') || '';

          if (!v.sku) {
            this.skuAuditEntries.push({
              productId: p.id,
              productName: p.name,
              productSku: p.sku,
              categories: p.categories,
              variationId: v.id,
              variationSku: null,
              variationAttrs: attrs,
              variationStock: v.stockQuantity ?? null,
              image: v.image ?? null,
              reason: 'sem-sku',
            });
            this.skuAuditState.missingSkuCount += 1;
            this.skuAuditState.entriesFound += 1;
          } else {
            const erpVal = erpMap[v.sku];
            if (erpVal === undefined || erpVal === null) {
              this.skuAuditEntries.push({
                productId: p.id,
                productName: p.name,
                productSku: p.sku,
                categories: p.categories,
                variationId: v.id,
                variationSku: v.sku,
                variationAttrs: attrs,
                variationStock: v.stockQuantity ?? null,
                image: v.image ?? null,
                reason: 'nao-encontrado',
              });
              this.skuAuditState.notInErpCount += 1;
              this.skuAuditState.entriesFound += 1;
            }
          }
        }
      } catch (e) {
        this.skuAuditState.productsFailed += 1;
        this.logger.error(
          `SKU audit falhou no produto ${p.id} (${p.name}): ${(e as Error).message}`,
        );
      }

      this.skuAuditState.processed += 1;
      // Pequeno delay pra não estressar o WC
      await new Promise((r) => setTimeout(r, 100));
    }

    this.skuAuditState.running = false;
    this.skuAuditState.finishedAt = new Date().toISOString();
    this.skuAuditState.currentProductId = null;
    this.skuAuditState.currentProductName = null;
    this.skuAuditLastFinishedAt = this.skuAuditState.finishedAt;

    this.logger.log(
      `✅ SKU audit concluída: ${this.skuAuditState.entriesFound} variações pendentes ` +
        `(${this.skuAuditState.missingSkuCount} sem SKU + ${this.skuAuditState.notInErpCount} não encontradas no ERP).`,
    );

    // Log consolidado
    try {
      await this.prisma.integrationLog.create({
        data: {
          source: 'woocommerce+erp',
          direction: 'in',
          event: 'sku-audit.completed',
          payload: JSON.stringify({
            totalProducts: this.skuAuditState.totalProducts,
            entriesFound: this.skuAuditState.entriesFound,
            missingSkuCount: this.skuAuditState.missingSkuCount,
            notInErpCount: this.skuAuditState.notInErpCount,
            productsFailed: this.skuAuditState.productsFailed,
            startedAt: this.skuAuditState.startedAt,
            finishedAt: this.skuAuditState.finishedAt,
          }).slice(0, 60000),
          status: this.skuAuditState.productsFailed === 0 ? 200 : 207,
        },
      });
    } catch (e) {
      this.logger.warn(`Falha ao gravar log de sku-audit: ${(e as Error).message}`);
    }
  }

  /**
   * Exporta o resultado da auditoria de SKU em XLSX.
   * Uma aba só, colunas principais pra auditoria em lote.
   */
  async exportSkuAuditXlsx(): Promise<{ filename: string; buffer: Buffer }> {
    if (this.skuAuditEntries.length === 0) {
      throw new BadRequestException(
        'Nenhuma auditoria gerada ainda. Rode a auditoria primeiro.',
      );
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'FlowOps Lite';
    wb.created = new Date();
    const ws = wb.addWorksheet('Auditoria SKU', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = [
      { header: 'motivo', key: 'reason', width: 18 },
      { header: 'product_id', key: 'productId', width: 12 },
      { header: 'produto', key: 'productName', width: 48 },
      { header: 'sku_produto_pai', key: 'productSku', width: 20 },
      { header: 'variation_id', key: 'variationId', width: 14 },
      { header: 'sku_site', key: 'variationSku', width: 20 },
      { header: 'sku_gigasistemas', key: 'erpSkuSuggest', width: 20 },
      { header: 'atributos', key: 'variationAttrs', width: 28 },
      { header: 'estoque_wc', key: 'variationStock', width: 12 },
      { header: 'categorias', key: 'categories', width: 36 },
      { header: 'admin_wc', key: 'adminUrl', width: 48 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE5E7EB' },
    };

    const wcUrl = (this.config.get<string>('WC_URL') ?? '').replace(/\/$/, '');
    for (const e of this.skuAuditEntries) {
      ws.addRow({
        reason: e.reason === 'sem-sku' ? 'sem SKU site' : 'não encontrado no ERP',
        productId: e.productId,
        productName: e.productName,
        productSku: e.productSku ?? '',
        variationId: e.variationId,
        variationSku: e.variationSku ?? '',
        erpSkuSuggest: '', // coluna pra operador preencher ao auditar
        variationAttrs: e.variationAttrs,
        variationStock: e.variationStock ?? '',
        categories: e.categories.join(' · '),
        adminUrl: `${wcUrl}/wp-admin/post.php?post=${e.productId}&action=edit`,
      });
    }

    const stamp = new Date()
      .toISOString()
      .replace(/[-:T.]/g, '')
      .slice(0, 14);
    const filename = `sku-audit-${stamp}.xlsx`;
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { filename, buffer };
  }

  // ═══════════════════════════════════════════════════════════════
  // BUSCA RÁPIDA DE PRODUTO NA FILIAL (/minha-loja/consultar)
  // ═══════════════════════════════════════════════════════════════
  //
  // Objetivo: vendedora digita/bipa QUALQUER termo num campo único.
  // O sistema decide sozinho se é EAN (bipador), código Giga, ref ou
  // trecho de descrição e retorna:
  //   1. Produtos que bateram (agrupados por REF)
  //   2. Cada produto com variações (tamanho/cor) e estoque na MINHA LOJA
  //   3. Outras lojas que têm a mesma REF e quais tamanhos (pra transfer)
  //
  // REGRAS DE DETECÇÃO:
  //   - só dígitos, 8 a 14 chars → tenta EAN primeiro
  //   - se resolveu, usa o CODIGO como termo de busca; senão cai no LIKE
  //   - qualquer outro input → LIKE em CODIGO/REF/DESCRICAOCOMPLETA
  //
  // IMPORTANTE: limite 20 resultados (evita travar a tela). Se vendedora
  // precisa mais específico, digita melhor.
  async storeProductSearch(
    q: string,
    myStoreId: string,
    mode: 'ref' | 'desc' | 'sku' = 'ref',
  ): Promise<{
    query: string;
    mode: 'ref' | 'desc' | 'sku';
    detectedAs: 'ean' | 'text';
    myStore: { id: string; code: string; name: string };
    /** Em modo desc, vem uma lista de REFs agrupadas pra vendedora escolher. */
    refMatches?: Array<{ ref: string; name: string; variantCount: number }>;
    results: Array<{
      ref: string;
      name: string;
      variants: Array<{
        sku: string;
        cor: string;
        tamanho: string;
        myStoreQty: number;
      }>;
      myStoreTotal: number;
      /** Só no modo sku — marca qual variação bateu exata com o código bipado. */
      matchedSku?: string | null;
      otherStores: Array<{
        code: string;
        name: string;
        whatsapp: string | null;
        qty: number;            // total somado das variações da ref nessa loja
        variants: Array<{ sku: string; cor: string; tamanho: string; qty: number }>;
      }>;
    }>;
  }> {
    const term = String(q || '').trim();
    if (term.length < 2) {
      throw new BadRequestException('Digite pelo menos 2 caracteres.');
    }

    // Resolve a loja atual do vendedor
    const myStore = await this.prisma.store.findUnique({ where: { id: myStoreId } });
    if (!myStore) {
      throw new BadRequestException('Loja não encontrada para o usuário logado.');
    }

    const isLikelyEan = /^\d{8,14}$/.test(term);
    let detectedAs: 'ean' | 'text' = 'text';
    let matchedSkuForResult: string | null = null;

    // Modo DESC — retorna LISTA de REFs pra vendedora escolher (não expande tudo).
    if (mode === 'desc') {
      const grouped = await this.erp.searchByDescriptionGrouped(term);
      return {
        query: term,
        mode,
        detectedAs,
        myStore: { id: myStore.id, code: myStore.code, name: myStore.name },
        refMatches: grouped.map((g) => ({
          ref: String(g.REF),
          name: String(g.DESCRICAOCOMPLETA ?? g.REF),
          variantCount: Number(g.VARIANT_COUNT ?? 0),
        })),
        results: [],
      };
    }

    // Modo SKU/COD — acha a linha, pega a REF, expande TODA a REF.
    // Também dispara quando parece EAN puro no modo ref (fallback inteligente).
    let rawRows: any[] = [];
    if (mode === 'sku' || (mode === 'ref' && isLikelyEan)) {
      if (isLikelyEan) detectedAs = 'ean';
      // Guarda o código exato que a vendedora passou — marca a variante no resultado
      matchedSkuForResult = term;
      rawRows = await this.erp.searchByCodeAndExpandRef(term);
      // Fallback: se não achou pelo código, tenta como REF direto
      if (!rawRows.length) {
        rawRows = await this.erp.searchByRef(term);
      }
    } else {
      // Modo REF — busca exata + prefixo
      rawRows = await this.erp.searchByRef(term);
    }
    if (!rawRows.length) {
      return {
        query: term,
        mode,
        detectedAs,
        myStore: { id: myStore.id, code: myStore.code, name: myStore.name },
        results: [],
      };
    }
    if (!rawRows.length) {
      return {
        query: term,
        mode,
        detectedAs,
        myStore: { id: myStore.id, code: myStore.code, name: myStore.name },
        results: [],
      };
    }

    // 3. Coleta SKUs únicos e agrupa por REF
    const skus = Array.from(new Set(rawRows.map((r) => String(r.CODIGO)).filter(Boolean)));
    const skuToMeta = new Map<string, { ref: string; descricao: string; cor: string; tamanho: string }>();
    for (const r of rawRows) {
      const sku = String(r.CODIGO);
      if (!sku || skuToMeta.has(sku)) continue;
      skuToMeta.set(sku, {
        ref: String(r.REF ?? sku),
        descricao: String(r.DESCRICAOCOMPLETA ?? ''),
        cor: String(r.COR ?? ''),
        tamanho: String(r.TAMANHO ?? ''),
      });
    }

    /**
     * Normaliza a REF pra "base REF" — strippa sufixo tipo " P", " M", " VN"
     * (código curto de cor depois de espaço) pra colapsar:
     *   VMS-223 P + VMS-223 M + VMS-223 V + VMS-223 N → VMS-223
     *
     * Caso o usuário tenha buscado a REF JÁ com o sufixo (ex: "VMS-223 P"),
     * preserva a REF original — ele quer só aquela cor específica.
     */
    const queryUpper = term.trim().toUpperCase();
    const queryHasColorSuffix = /\s[A-Z]{1,3}$/.test(queryUpper);
    const normalizeBaseRef = (ref: string): string => {
      const s = String(ref).trim();
      if (queryHasColorSuffix) return s; // user pediu a cor específica — não colapsa
      if (s.toUpperCase() === queryUpper) return s;
      const stripped = s.replace(/\s[A-Za-z]{1,3}$/, '').trim();
      return stripped || s;
    };

    /**
     * Remove nome de cor da descrição do produto pra virar um nome "genérico".
     * Ex: "VESTIDO MID VMS-223 PRETO 46 MARRIE" → "VESTIDO MID VMS-223 MARRIE".
     * Heurística simples — cobre as cores mais comuns da loja.
     */
    const KNOWN_COLORS = [
      'PRETO', 'BRANCO', 'VERMELHO', 'ROSA', 'AZUL', 'MARINHO', 'MARROM',
      'VINHO', 'VERDE', 'AMARELO', 'LARANJA', 'BEGE', 'CINZA', 'UVA',
      'PINK', 'NUDE', 'CREME', 'CAQUI', 'CARAMELO', 'OFF', 'MOSTARDA',
      'TERRACOTA', 'TIFANNY', 'SALMAO', 'SALMÃO', 'GRAFITE', 'PERVINCA',
    ];
    const cleanProductName = (name: string): string => {
      let n = String(name || '').trim();
      for (const c of KNOWN_COLORS) {
        n = n.replace(new RegExp(`\\s+${c}\\b`, 'gi'), '');
      }
      // tira tamanho numérico isolado (40-80)
      n = n.replace(/\s+\b(3[6-9]|[4-7]\d|80)\b/g, '');
      return n.replace(/\s{2,}/g, ' ').trim();
    };

    // 4. Pega estoque detalhado por loja pra todos os SKUs
    const detailed = await this.erp.getStockBySkusDetailed(skus);

    // 5. Carrega todas as lojas ativas uma vez (pra pegar whatsapp e nome)
    const allStores = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true, whatsapp: true },
    });
    const storeInfo = new Map(allStores.map((s) => [s.code, s]));

    // 6. Monta o agrupamento por REF
    const byRef = new Map<string, {
      ref: string;
      name: string;
      variants: Map<string, { sku: string; cor: string; tamanho: string; myStoreQty: number }>;
      otherStoresMap: Map<string, {
        code: string;
        name: string;
        whatsapp: string | null;
        qty: number;
        variants: Array<{ sku: string; cor: string; tamanho: string; qty: number }>;
      }>;
    }>();

    for (const sku of skus) {
      const meta = skuToMeta.get(sku)!;
      const ref = normalizeBaseRef(meta.ref);
      if (!byRef.has(ref)) {
        byRef.set(ref, {
          ref,
          name: cleanProductName(meta.descricao) || ref,
          variants: new Map(),
          otherStoresMap: new Map(),
        });
      }
      const bucket = byRef.get(ref)!;

      // cria/atualiza variant da minha loja (qty = 0 se não tiver estoque)
      if (!bucket.variants.has(sku)) {
        bucket.variants.set(sku, {
          sku,
          cor: meta.cor,
          tamanho: meta.tamanho,
          myStoreQty: 0,
        });
      }

      const stockList = detailed[sku] ?? [];
      for (const entry of stockList) {
        if (entry.storeCode === myStore.code) {
          bucket.variants.get(sku)!.myStoreQty = entry.qty;
        } else if (entry.qty > 0) {
          const info = storeInfo.get(entry.storeCode);
          if (!info) continue; // loja inativa ou desconhecida — ignora
          if (!bucket.otherStoresMap.has(entry.storeCode)) {
            bucket.otherStoresMap.set(entry.storeCode, {
              code: entry.storeCode,
              name: info.name,
              whatsapp: info.whatsapp ?? null,
              qty: 0,
              variants: [],
            });
          }
          const ob = bucket.otherStoresMap.get(entry.storeCode)!;
          ob.qty += entry.qty;
          ob.variants.push({ sku, cor: meta.cor, tamanho: meta.tamanho, qty: entry.qty });
        }
      }
    }

    // 7. Serializa saída — ordena refs pela soma na minha loja (quem tem + estoque aqui vai no topo)
    const results = Array.from(byRef.values()).map((b) => {
      const variants = Array.from(b.variants.values()).sort((x, y) => {
        // primeiro por tamanho numérico, depois alfabético
        const nx = Number(x.tamanho); const ny = Number(y.tamanho);
        if (!isNaN(nx) && !isNaN(ny)) return nx - ny;
        return String(x.tamanho).localeCompare(String(y.tamanho));
      });
      const myStoreTotal = variants.reduce((s, v) => s + v.myStoreQty, 0);
      const otherStores = Array.from(b.otherStoresMap.values()).sort((a, c) => c.qty - a.qty);
      // No modo sku, marca qual variante bateu exatamente com o código buscado
      const matchedSku =
        matchedSkuForResult && variants.some((v) => v.sku === matchedSkuForResult)
          ? matchedSkuForResult
          : null;
      return { ref: b.ref, name: b.name, variants, myStoreTotal, matchedSku, otherStores };
    }).sort((a, b) => b.myStoreTotal - a.myStoreTotal);

    return {
      query: term,
      mode,
      detectedAs,
      myStore: { id: myStore.id, code: myStore.code, name: myStore.name },
      results,
    };
  }

  // ============================================================
  // TRANSFER ORDERS — Histórico de pedidos de transferência
  // ============================================================
  // Cada clique em "Pedir" na tela /minha-loja/consultar grava um registro
  // ANTES de abrir o WhatsApp. Depois dá pra listar o histórico na tela
  // /minha-loja/historico (loja vê os próprios) ou no painel matriz.

  async createTransferOrder(
    userId: string | null,
    userStoreId: string,
    body: {
      tipo: 'REPOSICAO' | 'VENDA_CERTA';
      refCode: string;
      cor?: string | null;
      tamanho?: string | null;
      qtyOrigem: number;
      lojaOrigemCode: string;
      solicitanteNome: string;
      clienteNome?: string | null;
      mensagem: string;
    },
  ) {
    // Valida e resolve lojas (origem por code, destino = loja do user)
    const [origem, destino] = await Promise.all([
      this.prisma.store.findUnique({ where: { code: body.lojaOrigemCode } }),
      this.prisma.store.findUnique({ where: { id: userStoreId } }),
    ]);
    if (!origem) throw new Error(`Loja origem ${body.lojaOrigemCode} não encontrada.`);
    if (!destino) throw new Error('Loja destino (sua loja) não encontrada.');

    const tipo = body.tipo === 'VENDA_CERTA' ? 'VENDA_CERTA' : 'REPOSICAO';
    const clienteNome =
      tipo === 'VENDA_CERTA' ? (body.clienteNome ?? '').trim() || null : null;
    if (tipo === 'VENDA_CERTA' && !clienteNome) {
      throw new Error('Nome da cliente obrigatório em VENDA_CERTA.');
    }
    if (!body.solicitanteNome || body.solicitanteNome.trim().length < 2) {
      throw new Error('Nome do solicitante obrigatório.');
    }
    if (!body.refCode || body.refCode.trim().length < 2) {
      throw new Error('refCode inválido.');
    }

    // VENDA_CERTA abre como PENDING com prazo default de 7 dias.
    // REPOSICAO não tem prazo/status de venda (fica null).
    const saleStatus = tipo === 'VENDA_CERTA' ? 'pending' : null;
    const saleDeadline =
      tipo === 'VENDA_CERTA'
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        : null;

    const created = await (this.prisma as any).transferOrder.create({
      data: {
        tipo,
        refCode: body.refCode.trim().toUpperCase(),
        cor: body.cor?.trim() || null,
        tamanho: body.tamanho?.trim() || null,
        qtyOrigem: Number(body.qtyOrigem) || 0,
        lojaOrigemCode: origem.code,
        lojaOrigemName: origem.name,
        lojaDestinoCode: destino.code,
        lojaDestinoName: destino.name,
        solicitanteNome: body.solicitanteNome.trim(),
        clienteNome,
        mensagem: body.mensagem || '',
        createdByUserId: userId || null,
        saleStatus,
        saleDeadline,
      },
    });
    return created;
  }

  async listTransferOrders(params: {
    userStoreId?: string | null; // se passado, filtra por loja destino OU origem
    scope?: 'mine' | 'all';       // 'mine' = só da loja do usuário; 'all' = rede toda
    limit?: number;
    onlyVendaCertaPending?: boolean; // filtro especial pra dashboard matriz
  }) {
    const limit = Math.min(Math.max(params.limit || 100, 1), 500);
    const where: any = {};
    let userStoreCode: string | null = null;
    if (params.userStoreId) {
      const store = await this.prisma.store.findUnique({
        where: { id: params.userStoreId },
      });
      userStoreCode = store?.code ?? null;
    }
    if (params.scope !== 'all') {
      if (!userStoreCode) return { items: [], myStoreCode: null };
      where.OR = [
        { lojaDestinoCode: userStoreCode },
        { lojaOrigemCode: userStoreCode },
      ];
    }
    if (params.onlyVendaCertaPending) {
      where.tipo = 'VENDA_CERTA';
      where.saleStatus = 'pending';
    }
    const rows = await (this.prisma as any).transferOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    // Decora cada item com direction ('out' = EU PEDI, 'in' = ME PEDIRAM)
    // baseado no code da loja do user. Pra admin scope=all, direction=null.
    const items = rows.map((r: any) => {
      let direction: 'out' | 'in' | null = null;
      if (userStoreCode) {
        if (r.lojaDestinoCode === userStoreCode) direction = 'out';
        else if (r.lojaOrigemCode === userStoreCode) direction = 'in';
      }
      return { ...r, direction };
    });
    return { items, myStoreCode: userStoreCode };
  }

  /**
   * Atualiza status de venda de um TransferOrder tipo VENDA_CERTA.
   * Loja destino (quem pediu) confirma/cancela. Matriz também pode intervir.
   *
   * status: 'confirmed' | 'cancelled'
   */
  async updateSaleStatus(
    id: string,
    user: { userId: string; role: string; storeId: string | null },
    body: { status: 'confirmed' | 'cancelled'; reason?: string; saleNote?: string },
  ) {
    const order = await (this.prisma as any).transferOrder.findUnique({
      where: { id },
    });
    if (!order) throw new Error('Pedido não encontrado.');
    if (order.tipo !== 'VENDA_CERTA') {
      throw new Error('Só VENDA_CERTA tem controle de status de venda.');
    }
    if (order.saleStatus && order.saleStatus !== 'pending') {
      throw new Error(
        `Pedido já está ${order.saleStatus === 'confirmed' ? 'confirmado' : 'cancelado'}.`,
      );
    }

    // Permissão: loja destino (quem pediu) OU admin/operator
    const isAdmin = user.role === 'admin' || user.role === 'operator';
    if (!isAdmin) {
      if (!user.storeId) throw new Error('Sem permissão.');
      const store = await this.prisma.store.findUnique({ where: { id: user.storeId } });
      if (!store || store.code !== order.lojaDestinoCode) {
        throw new Error('Apenas a loja que pediu pode confirmar/cancelar a venda.');
      }
    }

    const status = body.status === 'cancelled' ? 'cancelled' : 'confirmed';
    return (this.prisma as any).transferOrder.update({
      where: { id },
      data: {
        saleStatus: status,
        saleConfirmedAt: status === 'confirmed' ? new Date() : null,
        saleConfirmedByUserId: status === 'confirmed' ? user.userId : null,
        saleCancelReason: status === 'cancelled' ? (body.reason?.trim() || null) : null,
        saleNote: body.saleNote?.trim() || null,
      },
    });
  }
}
