import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';
import { StockEntry } from '../routing/types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Cliente para o MySQL do ERP gigasistemas21 (WinCred).
 *
 * LEITURA: sempre habilitada.
 * ESCRITA (baixa de estoque): controlada pelo env var ERP_WRITE_ENABLED='true'.
 *   Quando OFF (default), qualquer chamada a `decreaseStock` retorna erro
 *   sem tocar no MySQL â€” sistema fica em SHADOW MODE.
 *   Quando ON, o UPDATE acontece em transaÃ§Ã£o ACID com rollback em falha.
 *
 * Schema real (confirmado via inspect-erp):
 *   tabela `estoque`  (266k registros â€” estoque consolidado)
 *     CODIGO   varchar(14)   SKU do produto
 *     ESTOQUE  int(11)       quantidade disponÃ­vel
 *     LOJA     char(2)       cÃ³digo da loja (01..20)
 */
@Injectable()
export class ErpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ErpService.name);
  private pool: mysql.Pool;

  constructor(
    private readonly config: ConfigService,
    private readonly prismaFlow: PrismaService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // LEITURAS PELO ESPELHO — GIGA_MIRROR_READS=1 (pacote 1 da migração 13/07)
  //
  // Intercepta as consultas de ESTOQUE (giga_estoque) e de FATURAMENTO BRUTO
  // (giga_caixa_diario) DENTRO do ErpService: todos os consumidores (products,
  // stock, catalog, live, routing, intelligence, financeiro, faturamento)
  // trocam de fonte de uma vez, sem tocar em tela nenhuma.
  //
  // Segurança: qualquer erro OU espelho vazio (nunca sincronizado) → cai pro
  // Giga ao vivo, query original intocada. Kill-switch: remover a env.
  // ═══════════════════════════════════════════════════════════════════════

  private get mirrorReadsEnabled(): boolean {
    return String(process.env.GIGA_MIRROR_READS ?? '').trim() === '1' && !!this.prismaFlow;
  }

  /** Cache 60s: espelho de estoque tem dados? (vazio = nunca sincronizou → Giga) */
  private mirrorStockReadyCache: { ok: boolean; at: number } | null = null;
  private async mirrorStockReady(): Promise<boolean> {
    const now = Date.now();
    if (this.mirrorStockReadyCache && now - this.mirrorStockReadyCache.at < 60_000) {
      return this.mirrorStockReadyCache.ok;
    }
    const n = await (this.prismaFlow as any).gigaEstoque.count().catch(() => 0);
    const ok = Number(n) > 1000;
    this.mirrorStockReadyCache = { ok, at: now };
    return ok;
  }

  private mirrorCaixaReadyCache: { ok: boolean; at: number } | null = null;
  private async mirrorCaixaReady(): Promise<boolean> {
    const now = Date.now();
    if (this.mirrorCaixaReadyCache && now - this.mirrorCaixaReadyCache.at < 60_000) {
      return this.mirrorCaixaReadyCache.ok;
    }
    const n = await (this.prismaFlow as any).gigaCaixaDiario.count().catch(() => 0);
    const ok = Number(n) > 10;
    this.mirrorCaixaReadyCache = { ok, at: now };
    return ok;
  }

  /**
   * COBERTURA DE PERÍODO (fix 13/07): o espelho giga_caixa_diario só guarda o
   * histórico recente. Consulta que começa ANTES da data mais antiga do
   * espelho (ex.: comparação "ano anterior" do faturamento) tem que ir pro
   * Giga ao vivo — senão volta vazio e o gráfico compara com R$ 0,00.
   */
  private mirrorCaixaMinCache: { min: Date | null; at: number } | null = null;
  private async mirrorCaixaCovers(inicio: Date): Promise<boolean> {
    const now = Date.now();
    if (!this.mirrorCaixaMinCache || now - this.mirrorCaixaMinCache.at > 60_000) {
      const row = await (this.prismaFlow as any).gigaCaixaDiario
        .findFirst({ orderBy: { data: 'asc' }, select: { data: true } })
        .catch(() => null);
      this.mirrorCaixaMinCache = { min: row?.data ? new Date(row.data) : null, at: now };
    }
    const min = this.mirrorCaixaMinCache.min;
    if (!min) return false;
    return inicio.getTime() >= min.getTime();
  }

  /** getStock (roteamento) pelo espelho — replica a resolução anti-colisão. */
  private async getStockFromMirror(skus: string[], storeCodes: string[]): Promise<StockEntry[]> {
    const uniqueOriginals = Array.from(
      new Set(skus.map((s) => String(s || '').trim()).filter(Boolean)),
    );
    if (!uniqueOriginals.length) return [];
    const { allVariants, variantToOriginal } = this.expandSkus(uniqueOriginals);
    if (!allVariants.length) return [];

    // PASSO 1 — resolve o CODIGO real no cadastro (espelho giga_produto), com a
    // mesma regra anti-colisão do caminho ao vivo (prioriza padding mais longo).
    const prodRows: any[] = await (this.prismaFlow as any).gigaProduto.findMany({
      where: { codigo: { in: allVariants } },
      select: { codigo: true },
    });
    const codigoGigaToOriginal = new Map<string, string>();
    for (const r of prodRows) {
      const codigoGiga = String(r.codigo).trim();
      const originalSku = variantToOriginal.get(codigoGiga);
      if (!originalSku) continue;
      const previous = Array.from(codigoGigaToOriginal.entries()).find(([, o]) => o === originalSku)?.[0];
      if (!previous) codigoGigaToOriginal.set(codigoGiga, originalSku);
      else if (codigoGiga.length > previous.length) {
        codigoGigaToOriginal.delete(previous);
        codigoGigaToOriginal.set(codigoGiga, originalSku);
      }
    }
    // EAN prefixo 8 (gerado pelo Flow): namespace próprio, sem colisão de
    // padding — não precisa (nem pode) esperar aparecer no espelho de
    // cadastro giga_produto (~6h). Entra direto na resolução de estoque.
    const jaResolvidos = new Set(codigoGigaToOriginal.values());
    for (const s of uniqueOriginals) {
      if (/^8\d{12}$/.test(s) && !jaResolvidos.has(s)) codigoGigaToOriginal.set(s, s);
    }
    if (!codigoGigaToOriginal.size) return [];

    // PASSO 2 — estoque de TODAS as variantes de padding dos códigos reais.
    const codigoVariantToOriginal = new Map<string, string>();
    const codigosVariants: string[] = [];
    for (const [codigoGiga, originalSku] of codigoGigaToOriginal.entries()) {
      for (const v of this.skuVariants(codigoGiga)) {
        codigosVariants.push(v);
        if (!codigoVariantToOriginal.has(v)) codigoVariantToOriginal.set(v, originalSku);
      }
    }

    // Lojas com e sem zero à esquerda (mesma tolerância do caminho ao vivo).
    const lojaToStoreCode = new Map<string, string>();
    for (const sc of storeCodes) {
      const s = String(sc ?? '').trim();
      if (!s) continue;
      if (!lojaToStoreCode.has(s)) lojaToStoreCode.set(s, s);
      if (/^\d{1,2}$/.test(s)) {
        const padded = s.padStart(2, '0');
        if (!lojaToStoreCode.has(padded)) lojaToStoreCode.set(padded, s);
        const stripped = s.replace(/^0+/, '') || s;
        if (!lojaToStoreCode.has(stripped)) lojaToStoreCode.set(stripped, s);
      }
    }

    const rows: any[] = await (this.prismaFlow as any).gigaEstoque.findMany({
      where: {
        codigo: { in: codigosVariants },
        loja: { in: Array.from(lojaToStoreCode.keys()) },
        estoque: { gt: 0 },
      },
      select: { codigo: true, loja: true, estoque: true },
    });
    const agg = new Map<string, number>();
    for (const r of rows) {
      const storeCode = lojaToStoreCode.get(String(r.loja).trim()) ?? String(r.loja).trim();
      const originalSku = codigoVariantToOriginal.get(String(r.codigo).trim());
      if (!originalSku) continue;
      const key = `${storeCode}::${originalSku}`;
      agg.set(key, (agg.get(key) || 0) + (Number(r.estoque) || 0));
    }
    const out: StockEntry[] = [];
    for (const [key, qty] of agg.entries()) {
      const [storeCode, originalSku] = key.split('::');
      out.push({ storeCode, sku: originalSku, availableQty: qty });
    }
    return out;
  }

  /**
   * WRITE-THROUGH de estoque nos espelhos (giga_estoque + wincred_estoque).
   * Entrada/baixa no Giga refletem NA HORA no Flow — sem esperar o full de
   * hora em hora. Incidente VOGUE VINHO 14/07: entrada de 1un pela tela de
   * pedidos gravou no Giga, a grade da live (que esconde estoque 0) só veria
   * o saldo na virada da hora. Best effort: falha aqui NUNCA quebra a
   * operação principal (o cron continua sendo a fonte de reconciliação).
   */
  private async mirrorStockWriteThrough(
    applied: Array<{ sku: string; storeCode: string; newStock: number }>,
  ): Promise<void> {
    for (const a of applied) {
      try {
        const lojaRaw = String(a.storeCode || '').trim();
        const loja2 = /^\d{1}$/.test(lojaRaw) ? lojaRaw.padStart(2, '0') : lojaRaw;
        const lojas = Array.from(new Set([lojaRaw, loja2, lojaRaw.replace(/^0+/, '') || lojaRaw]));
        const novo = Math.max(0, Number(a.newStock) || 0);
        const variants = this.skuVariants(String(a.sku || '').trim());
        if (!variants.length || !lojas.length) continue;

        const upd = await (this.prismaFlow as any).gigaEstoque.updateMany({
          where: { codigo: { in: variants }, loja: { in: lojas } },
          data: { estoque: novo, syncedAt: new Date() },
        });
        if (!upd.count) {
          await (this.prismaFlow as any).gigaEstoque.create({
            data: { codigo: String(a.sku).trim(), loja: loja2, estoque: novo },
          });
        }

        const codNorm = this.wincredCodigo(String(a.sku).trim());
        await (this.prismaFlow as any).wincredEstoque.upsert({
          where: { codigo_loja: { codigo: codNorm, loja: loja2 } },
          create: { codigo: codNorm, loja: loja2, estoque: novo },
          update: { estoque: novo, syncedAt: new Date() },
        });
      } catch (e) {
        this.logger.warn(
          `[mirror-writethrough] estoque ${a.sku}/${a.storeCode}: ${(e as Error).message}`,
        );
      }
    }
  }

  /** getStockTotalBySkus pelo espelho — inclui a regra "existe no cadastro = 0". */
  private async getStockTotalBySkusFromMirror(skus: string[]): Promise<Record<string, number>> {
    const unique = Array.from(new Set(skus.filter((s) => s && s.trim()))).map((s) => s.trim());
    if (!unique.length) return {};
    const { allVariants, variantToOriginal } = this.expandSkus(unique);
    if (!allVariants.length) return {};

    const existsInProducts = new Set<string>();
    const prodRows: any[] = await (this.prismaFlow as any).gigaProduto.findMany({
      where: { codigo: { in: allVariants } },
      select: { codigo: true },
    });
    for (const r of prodRows) {
      const codigoGiga = String(r.codigo).trim();
      existsInProducts.add(variantToOriginal.get(codigoGiga) || codigoGiga);
    }

    const rows: any[] = await (this.prismaFlow as any).gigaEstoque.findMany({
      where: { codigo: { in: allVariants } },
      select: { codigo: true, estoque: true },
    });
    const result: Record<string, number> = {};
    for (const r of rows) {
      const original = variantToOriginal.get(String(r.codigo).trim()) || String(r.codigo).trim();
      result[original] = (result[original] || 0) + (Number(r.estoque) || 0);
    }
    for (const sku of existsInProducts) {
      if (!(sku in result)) result[sku] = 0;
    }
    return result;
  }

  /** getStockBySkusDetailed pelo espelho (por loja, só positivos). */
  private async getStockBySkusDetailedFromMirror(
    skus: string[],
  ): Promise<Record<string, Array<{ storeCode: string; qty: number }>>> {
    const unique = Array.from(new Set(skus.filter((s) => s && s.trim()))).map((s) => s.trim());
    if (!unique.length) return {};
    const { allVariants, variantToOriginal } = this.expandSkus(unique);
    if (!allVariants.length) return {};
    const rows: any[] = await (this.prismaFlow as any).gigaEstoque.findMany({
      where: { codigo: { in: allVariants }, estoque: { gt: 0 } },
      select: { codigo: true, loja: true, estoque: true },
    });
    const agg = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const original = variantToOriginal.get(String(r.codigo).trim()) || String(r.codigo).trim();
      const storeCode = String(r.loja).trim();
      const qty = Number(r.estoque) || 0;
      if (qty <= 0) continue;
      if (!agg.has(original)) agg.set(original, new Map());
      const lojaMap = agg.get(original)!;
      lojaMap.set(storeCode, (lojaMap.get(storeCode) || 0) + qty);
    }
    const map: Record<string, Array<{ storeCode: string; qty: number }>> = {};
    for (const [sku, lojaMap] of agg.entries()) {
      map[sku] = Array.from(lojaMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([storeCode, qty]) => ({ storeCode, qty }));
    }
    return map;
  }

  /** getStockBySkuAndStores pelo espelho (soma por loja das variantes do SKU). */
  private async getStockBySkuAndStoresFromMirror(
    sku: string,
    storeCodes: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const variants = this.skuVariants(sku);
    if (!variants.length) return out;
    const lojaToStoreCode = new Map<string, string>();
    for (const sc of storeCodes) {
      const s = String(sc ?? '').trim();
      if (!s) continue;
      if (!lojaToStoreCode.has(s)) lojaToStoreCode.set(s, s);
      if (/^\d{1,2}$/.test(s)) {
        const padded = s.padStart(2, '0');
        if (!lojaToStoreCode.has(padded)) lojaToStoreCode.set(padded, s);
        const stripped = s.replace(/^0+/, '') || s;
        if (!lojaToStoreCode.has(stripped)) lojaToStoreCode.set(stripped, s);
      }
    }
    const rows: any[] = await (this.prismaFlow as any).gigaEstoque.findMany({
      where: { codigo: { in: variants }, loja: { in: Array.from(lojaToStoreCode.keys()) } },
      select: { loja: true, estoque: true },
    });
    for (const r of rows) {
      const storeCode = lojaToStoreCode.get(String(r.loja).trim()) ?? String(r.loja).trim();
      out.set(storeCode, (out.get(storeCode) || 0) + (Number(r.estoque) || 0));
    }
    return out;
  }

  /** Espelho de funcionarios pronto? (vazio = nunca sincronizou → Giga) */
  private mirrorFuncReadyCache: { ok: boolean; at: number } | null = null;
  private async mirrorFuncReady(): Promise<boolean> {
    const now = Date.now();
    if (this.mirrorFuncReadyCache && now - this.mirrorFuncReadyCache.at < 60_000) {
      return this.mirrorFuncReadyCache.ok;
    }
    const n = await (this.prismaFlow as any).wincredFuncionario.count().catch(() => 0);
    const ok = Number(n) > 5;
    this.mirrorFuncReadyCache = { ok, at: now };
    return ok;
  }

  /** Espelho tem EANs preenchidos? (coluna nova — só usa depois do 1º sync) */
  private mirrorEanReadyCache: { ok: boolean; at: number } | null = null;
  private async mirrorEanReady(): Promise<boolean> {
    const now = Date.now();
    if (this.mirrorEanReadyCache && now - this.mirrorEanReadyCache.at < 300_000) {
      return this.mirrorEanReadyCache.ok;
    }
    const n = await (this.prismaFlow as any).wincredProduto
      .count({ where: { ean: { not: null } } })
      .catch(() => 0);
    const ok = Number(n) > 100;
    this.mirrorEanReadyCache = { ok, at: now };
    return ok;
  }

  /** normalização de codigo padrão wincred (sem zeros à esquerda). */
  private wincredCodigo(raw: string): string {
    const s = String(raw ?? '').trim();
    if (!s || !/^\d+$/.test(s)) return s;
    return s.replace(/^0+/, '') || '0';
  }

  private async getEansBySkusFromMirror(skus: string[]): Promise<Record<string, string>> {
    const originals = skus.map((s) => String(s || '').trim()).filter(Boolean);
    const normToOriginal = new Map<string, string>();
    for (const s of originals) {
      const n = this.wincredCodigo(s);
      if (!normToOriginal.has(n)) normToOriginal.set(n, s);
    }
    const rows: any[] = await (this.prismaFlow as any).wincredProduto.findMany({
      where: { codigo: { in: Array.from(normToOriginal.keys()) }, ean: { not: null } },
      select: { codigo: true, ean: true },
    });
    const map: Record<string, string> = {};
    for (const r of rows) {
      const original = normToOriginal.get(String(r.codigo).trim());
      const ean = r.ean ? String(r.ean).trim() : '';
      if (original && ean && ean.length >= 8 && !map[original]) map[original] = ean;
    }
    return map;
  }

  private async findSkuByAnyEanFromMirror(list: string[]): Promise<string | null> {
    // 1) codigo primeiro (mesma prioridade do caminho ao vivo: etiquetas da
    //    Lurd's carregam o CODIGO interno como barcode).
    const norms = Array.from(new Set(list.map((v) => this.wincredCodigo(v))));
    const byCodigo: any = await (this.prismaFlow as any).wincredProduto.findFirst({
      where: { codigo: { in: norms } },
      select: { codigo: true },
    });
    if (byCodigo?.codigo) return String(byCodigo.codigo).trim();
    // 2) colunas de EAN propriamente ditas.
    const byEan: any = await (this.prismaFlow as any).wincredProduto.findFirst({
      where: { ean: { in: list } },
      select: { codigo: true },
    });
    return byEan?.codigo ? String(byEan.codigo).trim() : null;
  }

  /** getSalesGrossByStores pelo espelho giga_caixa_diario (bruto por loja/dia). */
  private async getSalesGrossByStoresFromMirror(
    storeCodes: string[],
    inicio: Date,
    fim: Date,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const lojaToStoreCode = new Map<string, string>();
    for (const sc of storeCodes) {
      const s = String(sc ?? '').trim();
      if (!s) continue;
      lojaToStoreCode.set(s, s);
      if (/^\d{1,2}$/.test(s)) lojaToStoreCode.set(s.padStart(2, '0'), s);
    }
    const rows: any[] = await (this.prismaFlow as any).gigaCaixaDiario.findMany({
      where: {
        loja: { in: Array.from(lojaToStoreCode.keys()) },
        data: { gte: inicio, lte: fim },
      },
      select: { loja: true, bruto: true },
    });
    for (const r of rows) {
      const storeCode = lojaToStoreCode.get(String(r.loja).trim()) ?? String(r.loja).trim();
      out.set(storeCode, (out.get(storeCode) || 0) + (Number(r.bruto) || 0));
    }
    return out;
  }

  /** getFaturamentoTimeseries pelo espelho (bucket dia/semana/mês por loja). */
  private async getFaturamentoTimeseriesFromMirror(
    inicio: Date,
    fim: Date,
    granularity: 'day' | 'week' | 'month',
  ): Promise<Array<{ bucket: string; storeCode: string; faturamento: number }>> {
    const rows: any[] = await (this.prismaFlow as any).gigaCaixaDiario.findMany({
      where: { data: { gte: inicio, lte: fim } },
      select: { loja: true, data: true, bruto: true },
    });
    const bucketOf = (d: Date): string => {
      const ymd = new Date(d);
      if (granularity === 'month') {
        return `${ymd.getUTCFullYear()}-${String(ymd.getUTCMonth() + 1).padStart(2, '0')}-01`;
      }
      if (granularity === 'week') {
        // Bucket = segunda-feira da semana (aprox. do %x-%v do MySQL).
        const day = ymd.getUTCDay() || 7;
        const monday = new Date(ymd);
        monday.setUTCDate(ymd.getUTCDate() - (day - 1));
        return monday.toISOString().slice(0, 10);
      }
      return ymd.toISOString().slice(0, 10);
    };
    const agg = new Map<string, number>();
    for (const r of rows) {
      const key = `${bucketOf(new Date(r.data))}::${String(r.loja).trim()}`;
      agg.set(key, (agg.get(key) || 0) + (Number(r.bruto) || 0));
    }
    return Array.from(agg.entries())
      .map(([key, faturamento]) => {
        const [bucket, storeCode] = key.split('::');
        return { bucket, storeCode, faturamento: Number(faturamento.toFixed(2)) };
      })
      .sort((a, b) => a.bucket.localeCompare(b.bucket) || a.storeCode.localeCompare(b.storeCode));
  }

  // ── CAIXA DETALHADA (giga_caixa_mov) — Dia 2 da migração 14/07 ────────────
  // Versões-espelho dos relatórios de vendas. Mesmos filtros do Giga:
  // MARCADO<>'SIM', DATA em [inicio, fim), loja com/sem zero à esquerda.
  // JOIN com a tabela nativa `product` substitui o JOIN caixa×produtos
  // (ltrim(codigo,'0') = codigo normalizado do nativo).

  private mirrorCaixaMovReadyCache: { ok: boolean; at: number } | null = null;
  private async mirrorCaixaMovReady(): Promise<boolean> {
    const now = Date.now();
    if (this.mirrorCaixaMovReadyCache && now - this.mirrorCaixaMovReadyCache.at < 60_000) {
      return this.mirrorCaixaMovReadyCache.ok;
    }
    const n = await (this.prismaFlow as any).gigaCaixaMov.count().catch(() => 0);
    const ok = Number(n) > 1000;
    this.mirrorCaixaMovReadyCache = { ok, at: now };
    return ok;
  }

  private mirrorCaixaMovMinCache: { min: Date | null; at: number } | null = null;
  private async mirrorCaixaMovCovers(inicio: Date): Promise<boolean> {
    const now = Date.now();
    if (!this.mirrorCaixaMovMinCache || now - this.mirrorCaixaMovMinCache.at > 60_000) {
      const row = await (this.prismaFlow as any).gigaCaixaMov
        .findFirst({ orderBy: { data: 'asc' }, select: { data: true } })
        .catch(() => null);
      this.mirrorCaixaMovMinCache = { min: row?.data ? new Date(row.data) : null, at: now };
    }
    const min = this.mirrorCaixaMovMinCache.min;
    if (!min) return false;
    return inicio.getTime() >= min.getTime();
  }

  /** true quando o espelho detalhado pode responder o período pedido. */
  private async caixaMovUsable(inicio: Date): Promise<boolean> {
    if (!this.mirrorReadsEnabled) return false;
    return (await this.mirrorCaixaMovReady()) && (await this.mirrorCaixaMovCovers(inicio));
  }

  private lojaVariants2(loja?: string | null): string[] | null {
    if (!loja) return null;
    const s = String(loja).trim().toUpperCase();
    const set = new Set<string>([s]);
    if (/^\d{1,2}$/.test(s)) {
      set.add(s.padStart(2, '0'));
      set.add(s.replace(/^0+/, '') || s);
    }
    return Array.from(set);
  }

  private async salesByStoreLastDaysFromMirror(n: number) {
    const rows: any[] = await (this.prismaFlow as any).$queryRawUnsafe(
      `SELECT loja AS "storeCode",
              COALESCE(SUM(quantidade), 0)::float8 AS units,
              COUNT(DISTINCT numero)::int AS orders
         FROM giga_caixa_mov
        WHERE data >= CURRENT_DATE - $1::int
          AND (marcado IS NULL OR marcado <> 'SIM')
        GROUP BY loja`,
      n,
    );
    return rows.map((r) => ({
      storeCode: String(r.storeCode || '').trim(),
      units: Number(r.units) || 0,
      orders: Number(r.orders) || 0,
    }));
  }

  private async salesByStoresInRangeFromMirror(inicio: Date, fim: Date, plusSize: boolean) {
    const out = new Map<string, { pecas: number; valor: number }>();
    const join = plusSize
      ? `INNER JOIN product p ON p.codigo = ltrim(m.codigo, '0')
           AND (COALESCE(p."plusSize", 0) > 0 OR upper(COALESCE(p."descricaoCompleta", '')) LIKE '%PLUS SIZE%')`
      : '';
    const rows: any[] = await (this.prismaFlow as any).$queryRawUnsafe(
      `SELECT m.loja AS "storeCode",
              COALESCE(SUM(m.quantidade), 0)::float8 AS pecas,
              COALESCE(SUM(m.valor_total), 0)::float8 AS valor
         FROM giga_caixa_mov m
         ${join}
        WHERE m.data >= $1 AND m.data < $2
          AND (m.marcado IS NULL OR m.marcado <> 'SIM')
        GROUP BY m.loja`,
      inicio, fim,
    );
    for (const r of rows) {
      const code = String(r.storeCode || '').trim();
      if (!code) continue;
      out.set(code, { pecas: Number(r.pecas) || 0, valor: Number(r.valor) || 0 });
    }
    return out;
  }

  private async salesSummaryFromMirror(inicio: Date, fim: Date, storeCode?: string | null) {
    const lojas = this.lojaVariants2(storeCode);
    const lojaCond = lojas ? `AND loja = ANY($3)` : '';
    const rows: any[] = await (this.prismaFlow as any).$queryRawUnsafe(
      `SELECT COALESCE(SUM(quantidade), 0)::float8 AS pecas,
              COALESCE(SUM(valor_total), 0)::float8 AS valor,
              COUNT(DISTINCT loja || '-' || COALESCE(numero, ''))::int AS vendas
         FROM giga_caixa_mov
        WHERE data >= $1 AND data < $2
          AND (marcado IS NULL OR marcado <> 'SIM')
          ${lojaCond}`,
      ...(lojas ? [inicio, fim, lojas] : [inicio, fim]),
    );
    const r: any = rows[0] || {};
    const pecas = Number(r.pecas) || 0;
    const valor = Number(r.valor) || 0;
    const vendas = Number(r.vendas) || 0;
    return { pecas, valor, vendas, ticketMedio: vendas > 0 ? valor / vendas : 0 };
  }

  private async salesByDayFromMirror(inicio: Date, fim: Date, storeCode?: string | null) {
    const lojas = this.lojaVariants2(storeCode);
    const lojaCond = lojas ? `AND loja = ANY($3)` : '';
    const rows: any[] = await (this.prismaFlow as any).$queryRawUnsafe(
      `SELECT data AS d,
              COALESCE(SUM(quantidade), 0)::float8 AS pecas,
              COALESCE(SUM(valor_total), 0)::float8 AS valor
         FROM giga_caixa_mov
        WHERE data >= $1 AND data < $2
          AND (marcado IS NULL OR marcado <> 'SIM')
          ${lojaCond}
        GROUP BY data
        ORDER BY data ASC`,
      ...(lojas ? [inicio, fim, lojas] : [inicio, fim]),
    );
    return rows.map((r) => ({
      date: r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10),
      pecas: Number(r.pecas) || 0,
      valor: Number(r.valor) || 0,
    }));
  }

  private async salesMonthAggFromMirror(inicio: Date, fim: Date, storeCode?: string | null) {
    const lojas = this.lojaVariants2(storeCode);
    const lojaCond = lojas ? `AND loja = ANY($3)` : '';
    const rows: any[] = await (this.prismaFlow as any).$queryRawUnsafe(
      `SELECT EXTRACT(YEAR FROM data)::int AS y,
              EXTRACT(MONTH FROM data)::int AS m,
              COALESCE(SUM(quantidade), 0)::float8 AS pecas,
              COALESCE(SUM(valor_total), 0)::float8 AS valor
         FROM giga_caixa_mov
        WHERE data >= $1 AND data < $2
          AND (marcado IS NULL OR marcado <> 'SIM')
          ${lojaCond}
        GROUP BY 1, 2
        ORDER BY 1, 2`,
      ...(lojas ? [inicio, fim, lojas] : [inicio, fim]),
    );
    return rows.map((r) => ({
      y: Number(r.y), m: Number(r.m),
      pecas: Number(r.pecas) || 0, valor: Number(r.valor) || 0,
    }));
  }

  private async uniqueClientesFromMirror(inicio: Date, fim: Date, storeCode?: string | null) {
    const lojas = this.lojaVariants2(storeCode);
    const lojaCond = lojas ? `AND loja = ANY($3)` : '';
    const rows: any[] = await (this.prismaFlow as any).$queryRawUnsafe(
      `SELECT COUNT(DISTINCT cod_cliente)::int AS clientes
         FROM giga_caixa_mov
        WHERE data >= $1 AND data < $2
          AND (marcado IS NULL OR marcado <> 'SIM')
          AND NULLIF(trim(cod_cliente), '') IS NOT NULL
          AND trim(cod_cliente) <> '0'
          ${lojaCond}`,
      ...(lojas ? [inicio, fim, lojas] : [inicio, fim]),
    );
    return Number(rows[0]?.clientes) || 0;
  }

  private async topRefsFromMirror(input: {
    inicio: Date; fim: Date; storeCode?: string | null; plusSize?: boolean;
    orderBy: 'pecas' | 'valor'; limit: number;
  }) {
    const lojas = this.lojaVariants2(input.storeCode);
    const lojaCond = lojas ? `AND m.loja = ANY($3)` : '';
    const plusCond = input.plusSize
      ? `AND (COALESCE(p."plusSize", 0) > 0 OR upper(COALESCE(p."descricaoCompleta", '')) LIKE '%PLUS SIZE%')`
      : '';
    const rows: any[] = await (this.prismaFlow as any).$queryRawUnsafe(
      `SELECT p.ref AS "refCode",
              MAX(p."descricaoCompleta") AS descricao,
              COALESCE(SUM(agg.pecas), 0)::float8 AS pecas,
              COALESCE(SUM(agg.valor), 0)::float8 AS valor
         FROM (
           SELECT m.codigo,
                  SUM(m.quantidade) AS pecas,
                  SUM(m.valor_total) AS valor
             FROM giga_caixa_mov m
            WHERE m.data >= $1 AND m.data < $2
              AND (m.marcado IS NULL OR m.marcado <> 'SIM')
              ${lojaCond}
            GROUP BY m.codigo
         ) agg
         INNER JOIN product p ON p.codigo = ltrim(agg.codigo, '0')
        WHERE p.ref IS NOT NULL AND p.ref <> ''
          ${plusCond}
        GROUP BY p.ref
        ORDER BY ${input.orderBy === 'valor' ? 'valor' : 'pecas'} DESC
        LIMIT ${input.limit}`,
      ...(lojas ? [input.inicio, input.fim, lojas] : [input.inicio, input.fim]),
    );
    return rows.map((r) => ({
      refCode: String(r.refCode || '').trim(),
      descricao: r.descricao ? String(r.descricao).trim() : null,
      pecas: Number(r.pecas) || 0,
      valor: Number(r.valor) || 0,
    }));
  }

  private async topVendedorasFromMirror(input: {
    inicio: Date; fim: Date; storeCode?: string | null; limit: number;
  }) {
    const lojas = this.lojaVariants2(input.storeCode);
    const lojaCond = lojas ? `AND m.loja = ANY($3)` : '';
    const rows: any[] = await (this.prismaFlow as any).$queryRawUnsafe(
      `SELECT trim(m.vendedor) AS codigo,
              MAX(COALESCE(f.nome, '')) AS nome,
              COALESCE(SUM(m.quantidade), 0)::float8 AS pecas,
              COALESCE(SUM(m.valor_total), 0)::float8 AS valor,
              COUNT(DISTINCT m.loja || '-' || COALESCE(m.numero, ''))::int AS vendas
         FROM giga_caixa_mov m
         LEFT JOIN wincred_funcionarios f ON trim(f.codigo) = trim(m.vendedor)
        WHERE m.data >= $1 AND m.data < $2
          AND (m.marcado IS NULL OR m.marcado <> 'SIM')
          AND m.vendedor IS NOT NULL
          ${lojaCond}
        GROUP BY trim(m.vendedor)
        ORDER BY valor DESC
        LIMIT ${input.limit}`,
      ...(lojas ? [input.inicio, input.fim, lojas] : [input.inicio, input.fim]),
    );
    return rows.map((r) => ({
      codigo: String(r.codigo || '').trim(),
      nome: String(r.nome || '').trim(),
      pecas: Number(r.pecas) || 0,
      valor: Number(r.valor) || 0,
      vendas: Number(r.vendas) || 0,
    }));
  }

  private async topMarcasFromMirror(input: {
    inicio: Date; fim: Date; storeCode?: string | null; limit: number;
  }) {
    const lojas = this.lojaVariants2(input.storeCode);
    const lojaCond = lojas ? `AND m.loja = ANY($3)` : '';
    const rows: any[] = await (this.prismaFlow as any).$queryRawUnsafe(
      `SELECT upper(trim(p.marca)) AS marca,
              COALESCE(SUM(agg.pecas), 0)::float8 AS pecas,
              COALESCE(SUM(agg.valor), 0)::float8 AS valor
         FROM (
           SELECT m.codigo,
                  SUM(m.quantidade) AS pecas,
                  SUM(m.valor_total) AS valor
             FROM giga_caixa_mov m
            WHERE m.data >= $1 AND m.data < $2
              AND (m.marcado IS NULL OR m.marcado <> 'SIM')
              ${lojaCond}
            GROUP BY m.codigo
         ) agg
         INNER JOIN product p ON p.codigo = ltrim(agg.codigo, '0')
        WHERE p.marca IS NOT NULL AND trim(p.marca) <> ''
        GROUP BY upper(trim(p.marca))
        ORDER BY valor DESC
        LIMIT ${input.limit}`,
      ...(lojas ? [input.inicio, input.fim, lojas] : [input.inicio, input.fim]),
    );
    return rows.map((r) => ({
      marca: String(r.marca || '').trim(),
      pecas: Number(r.pecas) || 0,
      valor: Number(r.valor) || 0,
    }));
  }

  private async lookupSaleHistoryFromMirror(storeCode: string, sku: string, dias: number) {
    const lojaClean = String(storeCode).trim().toUpperCase();
    const lojas = this.lojaVariants2(lojaClean)!;
    const variants = this.skuVariants(String(sku).trim());
    // Produto/preço atual: tabela nativa (codigo normalizado)
    const norms = Array.from(new Set(variants.map((v) => this.wincredCodigo(v))));
    const prod: any = await (this.prismaFlow as any).product.findFirst({
      where: { codigo: { in: norms } },
      select: { codigo: true, descricaoCompleta: true, cor: true, tamanho: true, vendaUn: true },
    });
    const produto = prod
      ? {
          codigo: String(prod.codigo).trim(),
          descricao: String(prod.descricaoCompleta || '').trim(),
          cor: prod.cor ? String(prod.cor).trim() : null,
          tamanho: prod.tamanho ? String(prod.tamanho).trim() : null,
          preco: prod.vendaUn != null ? Math.round(Number(prod.vendaUn) * 100) / 100 : 0,
        }
      : null;
    const rows: any[] = await (this.prismaFlow as any).gigaCaixaMov.findMany({
      where: {
        loja: { in: lojas },
        codigo: { in: variants },
        data: { gte: new Date(Date.now() - dias * 86400_000) },
        OR: [{ marcado: null }, { marcado: { not: 'SIM' } }],
        quantidade: { gt: 0 },
      },
      orderBy: { data: 'desc' },
      take: 20,
      select: { data: true, numero: true, quantidade: true, valorTotal: true },
    });
    const vendas = rows.map((r) => ({
      data: r.data ? new Date(r.data).toISOString().slice(0, 10) : '',
      numero: String(r.numero || ''),
      quantidade: Number(r.quantidade) || 0,
      valor: Number(r.valorTotal) || 0,
    }));
    return { found: vendas.length > 0, salesCount: vendas.length, vendas, produto };
  }

  private async vendasCaixaFromMirror(loja: string, from: string, toExclusive: string) {
    const lojas = this.lojaVariants2(loja)!;
    const rows: any[] = await (this.prismaFlow as any).$queryRawUnsafe(
      `SELECT numero AS "NUMERO",
              data_fec AS "DATAFEC",
              data AS "DATA",
              loja AS "LOJA",
              MAX(nome_cliente) AS "NOME_CLIENTE",
              MAX(cpf) AS "CPFCNPJ",
              MAX(vendedora) AS "VENDEDORA",
              MAX(fpag) AS "FPAG",
              MAX(vendedora_code) AS "CODFUNCIONARIO",
              MAX(obs_pedido) AS "OBS_PEDIDO",
              ROUND(SUM(COALESCE(valor_unitario, 0) * COALESCE(quantidade, 0))::numeric, 2)::float8 AS "VALOR_TOTAL",
              COALESCE(SUM(quantidade), 0)::float8 AS "QTD_ITENS"
         FROM giga_caixa_mov
        WHERE loja = ANY($1)
          AND data_fec >= $2::date
          AND data_fec < $3::date
          AND (marcado IS NULL OR marcado <> 'SIM')
        GROUP BY numero, data_fec, data, loja
        ORDER BY data_fec DESC, numero DESC
        LIMIT 500`,
      lojas, from, toExclusive,
    );
    return rows.map((r) => ({
      numero: r.NUMERO,
      data: r.DATAFEC || r.DATA,
      loja: r.LOJA,
      cliente: r.NOME_CLIENTE,
      cpf: r.CPFCNPJ,
      vendedora: r.VENDEDORA,
      fpag: r.FPAG,
      codFuncionario: r.CODFUNCIONARIO,
      obsPedido: r.OBS_PEDIDO,
      total: Number(r.VALOR_TOTAL) || 0,
      qtdItens: Number(r.QTD_ITENS) || 0,
    }));
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // HELPERS DE NORMALIZAÃ‡ÃƒO DE SKU
  //
  // O Giga armazena CODIGO com zeros Ã  esquerda (ex: "0005383498"). Outros
  // sistemas (WC, scanner, frontend) enviam sem padding (ex: "5383498").
  // Esses helpers expandem variantes pra que queries casem em qualquer formato.
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Gera todas as variantes de um SKU (com padding zero de 3 a 14 dÃ­gitos
   * + versÃ£o sem zeros Ã  esquerda + original).
   */
  // Public (era private) â€” usado tambem pelo returns.service.ts pra lookup
  // de troca tolerar zeros a esquerda (5210367 vs 0005210367 batem).
  //
  // Gera variantes do SKU com/sem zeros a esquerda em TODOS os tamanhos
  // entre 3 e 14 caracteres. Garante que o lookup ache mesmo se o item
  // foi salvo com padding intermediario (ex: bipe '0000011298861' bate em
  // '011298861', '0011298861', etc).
  skuVariants(sku: string): string[] {
    const trimmed = String(sku || '').trim();
    if (!trimmed) return [];
    const out = new Set<string>([trimmed]);
    const stripped = trimmed.replace(/^0+/, '');
    if (stripped) out.add(stripped);
    // Pra SKUs numericos: gera TODOS paddings entre 3 e 14 a partir do
    // numero limpo (stripped). Cobre todos os formatos possiveis no banco.
    const base = stripped || trimmed;
    if (/^\d+$/.test(base)) {
      for (let len = Math.max(3, base.length); len <= 14; len++) {
        out.add(base.padStart(len, '0'));
      }
    }
    return Array.from(out);
  }

  /**
   * Pra uma lista de SKUs, gera o set de variantes + um mapa
   * varianteâ†’original (pra mapear retorno do Giga de volta pro
   * formato que o caller passou).
   */
  private expandSkus(skus: string[]): {
    allVariants: string[];
    variantToOriginal: Map<string, string>;
  } {
    const variantToOriginal = new Map<string, string>();
    const allVariants = new Set<string>();
    for (const original of skus) {
      const orig = String(original || '').trim();
      if (!orig) continue;
      for (const v of this.skuVariants(orig)) {
        allVariants.add(v);
        if (!variantToOriginal.has(v)) variantToOriginal.set(v, orig);
      }
    }
    return { allVariants: Array.from(allVariants), variantToOriginal };
  }

  async onModuleInit() {
    this.pool = mysql.createPool({
      host: this.config.get<string>('ERP_HOST'),
      port: Number(this.config.get<string>('ERP_PORT') ?? 3306),
      user: this.config.get<string>('ERP_USER'),
      password: this.config.get<string>('ERP_PASSWORD'),
      database: this.config.get<string>('ERP_DATABASE'),
      waitForConnections: true,
      // Aumentado de 5 â†’ 15 (2025-05) pra suportar batch concorrente de baixa
      // em transferencias + PDV + crediario sem fila. Wincred MySQL aguenta.
      connectionLimit: 15,
      // FILA FINITA (02/07): era 0 (ilimitada) — quando o Giga pendurava, os
      // requests empilhavam sem teto atrás de conexões que nunca voltavam e o
      // app inteiro congelava (live de 01/07). Com 30, quem chegar com a fila
      // cheia recebe erro imediato ("Queue limit reached") em vez de travar.
      queueLimit: 30,
      // REGRESSÃO (23/06): isto tinha sido cortado pra 4s. Mas um fix anterior
      // JÁ tinha subido pra 15s justamente porque <5s causava ETIMEDOUT em pico
      // de uso / latência. Com 4s, qualquer lentidão do Giga estoura o connect,
      // e 3 estouros seguidos ABREM o circuit-breaker por 20s → blackout TOTAL
      // do Giga (ruptura, esgotado, 0 variações). Voltamos a um valor tolerante:
      // o circuit-breaker (abaixo) já cobre o "falhar rápido" em QUEDA REAL, então
      // não precisa de timeout minúsculo. 12s tolera latência sem falso-positivo.
      connectTimeout: 12000,
      // Keep-alive evita que conexÃ£o ociosa do pool seja derrubada.
      enableKeepAlive: true,
      keepAliveInitialDelay: 30000,
    });

    // (Removido 24/06) Circuit-breaker do Giga/WP: foi adicionado pra "falhar
    // rápido" quando o servidor ficasse inacessível, mas o Giga é dedicado e
    // aberto pra qualquer IP — o cenário não se aplica. Ele só introduziu um
    // modo de falha novo (blackout global de 20s ao disparar). O pool + o
    // connectTimeout já limitam o dano. Mantido o comportamento simples.

    // ── TIMEOUT POR QUERY (02/07) — proteção contra PENDURA ─────────────────
    // O Giga não dá erro quando o firewall da KingHost derruba a conexão: a
    // query fica esperando PRA SEMPRE, segurando uma das 15 vagas do pool até
    // congelar tudo (live de 01/07). Este wrapper embrulha o pool.query:
    //   - default 30s por query; chamadas de sync passam {sql, timeout: X}
    //     pra ter mais (o mysql2 ignora `timeout`, quem aplica somos nós);
    //   - runReadOnly NÃO passa por aqui (usa getConnection próprio + SET
    //     max_execution_time) — segue com o teto dele de até 120s;
    //   - transações via getConnection direto também não passam por aqui;
    //   - no estouro, a conexão é DESTRUÍDA (destroy), não devolvida — devolver
    //     um socket pendurado só espalharia o veneno pras próximas queries.
    // A mensagem contém "ETIMEDOUT" de propósito: os retries existentes
    // (wincred-mirror.withRetry etc) já tratam esse padrão.
    const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
    const ACQUIRE_TIMEOUT_MS = 15_000;
    const rawPool: any = this.pool;
    const guardLogger = this.logger;
    rawPool.query = async function guardedQuery(...args: any[]) {
      let timeoutMs = DEFAULT_QUERY_TIMEOUT_MS;
      if (args[0] && typeof args[0] === 'object' && (args[0] as any).sql) {
        const t = Number((args[0] as any).timeout);
        if (Number.isFinite(t) && t > 0) timeoutMs = t;
      }

      // Aquisição com teto: fila cheia/pool morto não segura o request.
      const acquirePromise: Promise<any> = (rawPool as any).getConnection();
      let conn: any;
      try {
        conn = await Promise.race([
          acquirePromise,
          new Promise((_, rej) =>
            setTimeout(
              () => rej(new Error(`GIGA_TIMEOUT ETIMEDOUT: fila de conexões do Giga não liberou em ${ACQUIRE_TIMEOUT_MS}ms`)),
              ACQUIRE_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (e) {
        // Se a aquisição resolver DEPOIS do timeout, devolve a vaga (senão vaza).
        acquirePromise.then((c: any) => { try { c.release(); } catch { /* noop */ } }).catch(() => { /* noop */ });
        throw e;
      }

      let timer: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          conn.query(...args),
          new Promise((_, rej) => {
            timer = setTimeout(
              () => rej(new Error(`GIGA_TIMEOUT ETIMEDOUT: query excedeu ${timeoutMs}ms no Giga`)),
              timeoutMs,
            );
          }),
        ]);
        conn.release();
        return result;
      } catch (e: any) {
        if (String(e?.message || '').includes('GIGA_TIMEOUT')) {
          guardLogger.warn(`[pool-guard] ${e.message} — conexão destruída pra liberar a vaga`);
          // PromisePoolConnection expõe destroy(); fallback pro raw por segurança.
          try {
            if (typeof conn.destroy === 'function') conn.destroy();
            else conn.connection?.destroy?.();
          } catch { /* noop */ }
        } else {
          try { conn.release(); } catch { /* noop */ }
        }
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    // IMPORTANTE: ping em background. NÃƒO bloquear o boot do Nest.
    // Se ERP_HOST nÃ£o estiver acessÃ­vel do Railway, o TCP fica pendurado
    // e trava o startup â†’ healthcheck falha.
    this.pool
      .getConnection()
      .then((conn) => {
        conn
          .ping()
          .then(() => {
            this.logger.log('âœ… ERP MySQL conectado (gigasistemas21)');
            conn.release();
          })
          .catch((e) => {
            this.logger.warn(`âš ï¸  ERP MySQL ping falhou: ${(e as Error).message}`);
            conn.release();
          });
      })
      .catch((e) => {
        this.logger.warn(`âš ï¸  ERP MySQL nÃ£o conectou: ${(e as Error).message}`);
      });
  }

  async onModuleDestroy() {
    if (this.pool) await this.pool.end();
  }

  /**
   * Transferências feitas NO GIGA — lê a tabela `transferencias` (item a item)
   * agregada por par de loja (LJ_ORIGEM → LJ_DESTINO) no período.
   *
   * Retorna o PREÇO de venda somado (PRECO × QUANTIDADE). O caller divide por
   * 2,5 pra obter o valor de custo. NUNCA usa a coluna CUSTO (regra do dono).
   * PRECO já vem em REAIS (ex: 49,90), sem ÷100.
   */
  async getGigaTransfersByPair(
    from: Date,
    to: Date,
  ): Promise<Array<{ origem: string; destino: string; qty: number; totalPreco: number }>> {
    if (!this.pool) return [];
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT LJ_ORIGEM AS origem, LJ_DESTINO AS destino,
                SUM(QUANTIDADE) AS qty, SUM(PRECO * QUANTIDADE) AS totalPreco
           FROM transferencias
          WHERE DATA >= ? AND DATA <= ?
          GROUP BY LJ_ORIGEM, LJ_DESTINO`,
        [fromStr, toStr],
      );
      return (rows as any[]).map((r) => ({
        origem: String(r.origem ?? '').trim(),
        destino: String(r.destino ?? '').trim(),
        qty: Number(r.qty) || 0,
        totalPreco: Number(r.totalPreco) || 0,
      }));
    } catch (e: any) {
      this.logger.warn(`getGigaTransfersByPair falhou: ${(e as Error)?.message || e}`);
      return [];
    }
  }

  /**
   * Igual ao getGigaTransfersByPair, mas DETALHADO por documento de transferência
   * (CONTROLE) — pra montar o nível mais fundo da cascata da conta corrente.
   * Uma linha por (origem, destino, CONTROLE, DATA): soma das peças e do preço
   * de venda daquele documento. DATA já vem como string 'YYYY-MM-DD'.
   */
  async getGigaTransfersDetailed(
    from: Date,
    to: Date,
  ): Promise<Array<{ origem: string; destino: string; controle: string; data: string; qty: number; totalPreco: number }>> {
    if (!this.pool) return [];
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);
    // RETRY: blip transitório não pode zerar a mercadoria. Tenta de novo antes
    // de PROPAGAR (quem chama precisa saber que falhou pra avisar, nunca mostrar
    // 0 como se a mercadoria fosse realmente zero).
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT LJ_ORIGEM AS origem, LJ_DESTINO AS destino, CONTROLE AS controle,
                  DATE_FORMAT(DATA, '%Y-%m-%d') AS data,
                  SUM(QUANTIDADE) AS qty, SUM(PRECO * QUANTIDADE) AS totalPreco
             FROM transferencias
            WHERE DATA >= ? AND DATA <= ?
            GROUP BY LJ_ORIGEM, LJ_DESTINO, CONTROLE, DATA`,
          [fromStr, toStr],
        );
        return (rows as any[]).map((r) => ({
          origem: String(r.origem ?? '').trim(),
          destino: String(r.destino ?? '').trim(),
          controle: String(r.controle ?? '').trim(),
          data: String(r.data ?? '').trim(),
          qty: Number(r.qty) || 0,
          totalPreco: Number(r.totalPreco) || 0,
        }));
      } catch (e: any) {
        lastErr = e;
        this.logger.warn(`getGigaTransfersDetailed tentativa ${attempt}/2 falhou: ${(e as Error)?.message || e}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 600));
      }
    }
    throw lastErr;
  }

  /**
   * Itens (peças/SKU) das transferências — alimenta `giga_transferencia_item`.
   * Grão: (origem, destino, CONTROLE, CODIGO, dia). É o nível mais fundo da
   * cascata da conta corrente. PROPAGA o erro (com retry) pro sync saber.
   */
  async getGigaTransferItems(
    from: Date,
    to: Date,
  ): Promise<
    Array<{ origem: string; destino: string; controle: string; codigo: string; descricao: string; data: string; qty: number; totalPreco: number }>
  > {
    if (!this.pool) return [];
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT LJ_ORIGEM AS origem, LJ_DESTINO AS destino, CONTROLE AS controle,
                  CODIGO AS codigo, MAX(DESCRICAO) AS descricao,
                  DATE_FORMAT(DATA, '%Y-%m-%d') AS data,
                  SUM(QUANTIDADE) AS qty, SUM(PRECO * QUANTIDADE) AS totalPreco
             FROM transferencias
            WHERE DATA >= ? AND DATA <= ?
            GROUP BY LJ_ORIGEM, LJ_DESTINO, CONTROLE, CODIGO, DATA`,
          [fromStr, toStr],
        );
        return (rows as any[]).map((r) => ({
          origem: String(r.origem ?? '').trim(),
          destino: String(r.destino ?? '').trim(),
          controle: String(r.controle ?? '').trim(),
          codigo: String(r.codigo ?? '').trim(),
          descricao: String(r.descricao ?? '').trim(),
          data: String(r.data ?? '').trim(),
          qty: Number(r.qty) || 0,
          totalPreco: Number(r.totalPreco) || 0,
        }));
      } catch (e: any) {
        lastErr = e;
        this.logger.warn(`getGigaTransferItems tentativa ${attempt}/2 falhou: ${(e as Error)?.message || e}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 600));
      }
    }
    throw lastErr;
  }

  /**
   * Catálogo de produtos do Giga (tabela `produtos`) — alimenta o espelho
   * `giga_produto`. Confere as colunas com SHOW COLUMNS e seleciona NULL pras
   * que não existirem (robusto a nomes diferentes). PROPAGA o erro (com retry).
   */
  /** Espelho de estoque do Giga: CODIGO x LOJA x ESTOQUE (só > 0) pro mirror. */
  async getGigaEstoque(): Promise<Array<{ codigo: string; loja: string; estoque: number }>> {
    if (!this.pool) return [];
    try {
      // Sync pesado (tabela inteira) — timeout estendido no pool-guard.
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>({
        sql: `SELECT CODIGO AS codigo, LOJA AS loja, SUM(ESTOQUE) AS estoque
           FROM estoque
          WHERE ESTOQUE > 0
          GROUP BY CODIGO, LOJA`,
        timeout: 300_000,
      } as any);
      return (rows as any[])
        .map((r) => ({
          codigo: String(r.codigo ?? '').trim(),
          loja: String(r.loja ?? '').trim(),
          estoque: Number(r.estoque) || 0,
        }))
        .filter((r) => r.codigo && r.loja && r.estoque > 0);
    } catch (e) {
      this.logger.error(`getGigaEstoque falhou: ${(e as Error).message}`);
      return [];
    }
  }

  async getGigaProdutos(): Promise<
    Array<{ codigo: string; ref: string; descricao: string; cor: string; tamanho: string; grupo: string; ncm: string; vendaUn: number }>
  > {
    if (!this.pool) return [];
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const [cols] = await this.pool.query<mysql.RowDataPacket[]>('SHOW COLUMNS FROM produtos');
        const have = new Set((cols as any[]).map((c) => String(c.Field).toUpperCase()));
        const col = (name: string, alias: string) => (have.has(name) ? `\`${name}\` AS ${alias}` : `NULL AS ${alias}`);
        const sql = `SELECT
            ${col('CODIGO', 'codigo')},
            ${col('REF', 'ref')},
            ${col('DESCRICAOCOMPLETA', 'descricao')},
            ${col('COR', 'cor')},
            ${col('TAMANHO', 'tamanho')},
            ${col('GRUPO', 'grupo')},
            ${col('NCM', 'ncm')},
            ${col('VENDAUN', 'vendaUn')}
          FROM produtos`;
        // Sync pesado (tabela inteira) — timeout estendido no pool-guard.
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>({ sql, timeout: 300_000 } as any);
        return (rows as any[])
          .map((r) => ({
            codigo: String(r.codigo ?? '').trim(),
            ref: String(r.ref ?? '').trim(),
            descricao: String(r.descricao ?? '').trim(),
            cor: String(r.cor ?? '').trim(),
            tamanho: String(r.tamanho ?? '').trim(),
            grupo: String(r.grupo ?? '').trim(),
            ncm: String(r.ncm ?? '').trim(),
            vendaUn: Number(r.vendaUn) || 0,
          }))
          .filter((p) => p.codigo);
      } catch (e: any) {
        lastErr = e;
        this.logger.warn(`getGigaProdutos tentativa ${attempt}/2 falhou: ${(e as Error)?.message || e}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 600));
      }
    }
    throw lastErr;
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // BAIXA DE ESTOQUE (WRITE) â€” controlado por env var ERP_WRITE_ENABLED.
  //
  // Kill-switch rÃ¡pido: setar ERP_WRITE_ENABLED=false no Railway e dar
  // redeploy (ou restart) volta o sistema pro shadow mode sem mudar cÃ³digo.
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /** Retorna true se o env var ERP_WRITE_ENABLED='true' (case-insensitive). */
  get isWriteEnabled(): boolean {
    const v = String(this.config.get('ERP_WRITE_ENABLED') ?? '').trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  }

  /**
   * Retorna true se o env var PDV_ERP_WRITE_ENABLED='true'. Controla a
   * gravaÃ§Ã£o de vendas do PDV flowops na tabela `caixa` do Wincred.
   * Independente de ERP_WRITE_ENABLED (decreaseStock) â€” pode-se baixar
   * estoque sem gravar venda, ou vice-versa.
   */
  get isPdvWriteEnabled(): boolean {
    const v = String(this.config.get('PDV_ERP_WRITE_ENABLED') ?? '').trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  }

  /**
   * Baixa estoque no Gigasistemas â€” executa UPDATE em `estoque` dentro de
   * uma transaÃ§Ã£o MySQL. Todos os itens caem ou nada cai (ACID).
   *
   * Regras:
   *  - ERP_WRITE_ENABLED precisa ser 'true'. SenÃ£o retorna erro sem tocar no DB.
   *  - Cada item: SELECT FOR UPDATE (pra travar linha durante a transaÃ§Ã£o)
   *    â†’ checa se existe â†’ checa se nÃ£o fica negativo â†’ UPDATE.
   *  - Se qualquer item falhar, rollback da transaÃ§Ã£o inteira.
   *  - Sempre retorna { success, applied, error? } â€” nunca lanÃ§a exception
   *    (pra quem chama poder logar e decidir sem try/catch).
   *
   * O `storeCode` deve estar padronizado no formato Giga: 2 dÃ­gitos (01..20).
   * A funÃ§Ã£o normaliza strings tipo "LJ01" â†’ "01" automaticamente.
   */
  async decreaseStock(
    items: Array<{ sku: string; qty: number; storeCode: string }>,
    opts?: { allowNegative?: boolean; skipNotFound?: boolean },
  ): Promise<{
    success: boolean;
    applied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }>;
    error?: string;
    attempts?: number;
  }> {
    if (!this.isWriteEnabled) {
      return { success: false, applied: [], error: 'ERP_WRITE_ENABLED nÃ£o habilitado' };
    }
    if (!this.pool) {
      return { success: false, applied: [], error: 'Pool ERP nÃ£o inicializado' };
    }
    if (!items.length) {
      return { success: true, applied: [] };
    }

    // RETRY em erros transientes (timeout de rede/conexÃ£o). AtÃ© 3 tentativas
    // com backoff 0 / 1s / 3s. Erros de regra de negÃ³cio (estoque insuficiente,
    // SKU nÃ£o encontrado, etc.) NÃƒO sÃ£o retry â€” falha na hora.
    const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ER_LOCK_WAIT_TIMEOUT']);
    const TRANSIENT_MSG_PATTERNS = [/read ETIMEDOUT/i, /connect ETIMEDOUT/i, /Connection lost/i, /closed state/i];
    const isTransient = (err: any): boolean => {
      const code = String(err?.code ?? '').toUpperCase();
      if (TRANSIENT_CODES.has(code)) return true;
      const msg = String(err?.message ?? err ?? '');
      return TRANSIENT_MSG_PATTERNS.some((rx) => rx.test(msg));
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const BACKOFF_MS = [0, 1000, 3000];

    let lastError: any = null;
    for (let attempt = 1; attempt <= BACKOFF_MS.length; attempt++) {
      if (BACKOFF_MS[attempt - 1] > 0) await sleep(BACKOFF_MS[attempt - 1]);
      const result = await this.decreaseStockOnce(items, opts);
      if (result.success) {
        return { ...result, attempts: attempt };
      }
      lastError = result.error;
      // SÃ³ faz retry se for transiente. Erro de regra de negÃ³cio â†’ sai na hora.
      if (!isTransient({ message: lastError })) {
        return { ...result, attempts: attempt };
      }
      this.logger.warn(`ERP baixa tentativa ${attempt}/${BACKOFF_MS.length} falhou (transient): ${lastError}`);
    }
    return { success: false, applied: [], error: `${lastError} (${BACKOFF_MS.length} tentativas)`, attempts: BACKOFF_MS.length };
  }

  /**
   * ExecuÃ§Ã£o ÃšNICA da baixa (sem retry) â€” extraÃ­da pra poder ser chamada N vezes
   * pelo wrapper de retry acima. Toda a lÃ³gica ACID fica aqui.
   *
   * opts.allowNegative: se true, deixa o estoque ficar negativo em vez de
   * abortar a transaÃ§Ã£o. Usado em realinhamento/triagem onde a peÃ§a jÃ¡
   * estÃ¡ fisicamente em mÃ£os (ignoramos divergÃªncia com Giga).
   */
  private async decreaseStockOnce(
    items: Array<{ sku: string; qty: number; storeCode: string }>,
    opts?: { allowNegative?: boolean; skipNotFound?: boolean },
  ): Promise<{
    success: boolean;
    applied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }>;
    error?: string;
  }> {
    // Normaliza storeCode: "LJ01" ou "1" â†’ "01"
    const normalizeStoreCode = (raw: string): string => {
      const s = String(raw || '').trim().toUpperCase().replace(/^LJ/i, '');
      const n = parseInt(s, 10);
      if (Number.isNaN(n) || n < 1 || n > 99) return s;
      return String(n).padStart(2, '0');
    };

    // â”€â”€ 1. NORMALIZA + AGREGA POR (SKU, LOJA) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Items duplicados (mesmo sku+loja) sao somados pra reduzir queries.
    const aggregated = new Map<string, { sku: string; qty: number; storeCode: string }>();
    for (const it of items) {
      const sku = String(it.sku || '').trim();
      const store = normalizeStoreCode(it.storeCode);
      const qty = Math.max(1, Number(it.qty) || 1);
      if (!sku || !store) {
        return { success: false, applied: [], error: `Item invalido: sku='${sku}' storeCode='${store}'` };
      }
      const key = `${sku}|${store}`;
      const ex = aggregated.get(key);
      if (ex) ex.qty += qty;
      else aggregated.set(key, { sku, qty, storeCode: store });
    }

    // â”€â”€ 2. AGRUPA POR LOJA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const byStore = new Map<string, Array<{ sku: string; qty: number }>>();
    for (const it of aggregated.values()) {
      if (!byStore.has(it.storeCode)) byStore.set(it.storeCode, []);
      byStore.get(it.storeCode)!.push({ sku: it.sku, qty: it.qty });
    }

    const conn = await this.pool.getConnection();
    const applied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }> = [];

    try {
      await conn.beginTransaction();

      // â”€â”€ 3. PROCESSA UMA LOJA POR VEZ (1 SELECT + 1 UPDATE por loja) â”€â”€
      for (const [storeCode, storeItems] of byStore) {
        // Coleta TODAS as variantes de TODOS os SKUs dessa loja
        const skuToVariants = new Map<string, string[]>();
        const allVariants = new Set<string>();
        for (const it of storeItems) {
          const vs = this.skuVariants(it.sku);
          skuToVariants.set(it.sku, vs);
          for (const v of vs) allVariants.add(v);
        }
        const variantArr = Array.from(allVariants);
        if (variantArr.length === 0) continue;

        // 1 SELECT FOR UPDATE pra essa loja inteira (trava todas as linhas)
        const [rows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO, ESTOQUE FROM estoque
            WHERE CODIGO IN (?) AND LOJA = ?
            FOR UPDATE`,
          [variantArr, storeCode],
        );

        // Mapa variante normalizada â†’ { codigo, estoque }
        const variantMap = new Map<string, { codigo: string; estoque: number }>();
        for (const row of rows as any[]) {
          const codigo = String(row.CODIGO).trim();
          variantMap.set(codigo, { codigo, estoque: Number(row.ESTOQUE) || 0 });
        }

        // Pra cada item: acha o melhor match (variante com maior estoque)
        type Update = { codigo: string; newStock: number; sku: string; previousStock: number; qty: number };
        const updates: Update[] = [];
        for (const it of storeItems) {
          const variants = skuToVariants.get(it.sku) || [];
          let bestMatch: { codigo: string; estoque: number } | null = null;
          for (const v of variants) {
            const m = variantMap.get(v);
            if (m && (!bestMatch || m.estoque > bestMatch.estoque)) bestMatch = m;
          }
          if (!bestMatch) {
            if (opts?.skipNotFound) {
              this.logger.warn(
                `Item sem registro em estoque â€” PULADO (skipNotFound): SKU=${it.sku} LOJA=${storeCode} qty=${it.qty}`,
              );
              continue;
            }
            throw new Error(`Registro nÃ£o encontrado em estoque: SKU=${it.sku} LOJA=${storeCode}`);
          }
          const previousStock = bestMatch.estoque;
          const newStock = previousStock - it.qty;
          if (newStock < 0) {
            if (opts?.allowNegative) {
              this.logger.warn(
                `Estoque negativo aceito (allowNegative): SKU=${it.sku} (giga=${bestMatch.codigo}) LOJA=${storeCode} tem ${previousStock}, pediu ${it.qty} â†’ newStock=${newStock}`,
              );
            } else {
              throw new Error(
                `Estoque insuficiente: SKU=${it.sku} (giga=${bestMatch.codigo}) LOJA=${storeCode} tem ${previousStock}, pediu ${it.qty}`,
              );
            }
          }
          updates.push({ codigo: bestMatch.codigo, newStock, sku: it.sku, previousStock, qty: it.qty });
          // Atualiza o variantMap pra refletir o novo estoque caso outro item
          // tente o mesmo CODIGO (defensivo â€” ja agregamos por sku+loja, mas
          // variantes diferentes podem apontar pro mesmo CODIGO Giga).
          bestMatch.estoque = newStock;
        }

        if (updates.length === 0) continue;

        // â”€â”€ 4. BATCH UPDATE com CASE WHEN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // 1 query atualiza N linhas. Reduz round-trips MySQL drasticamente.
        // Sintaxe: UPDATE estoque SET ESTOQUE = CASE CODIGO WHEN ? THEN ? ... END
        //          WHERE LOJA = ? AND CODIGO IN (?)
        const caseClauses = updates.map(() => 'WHEN ? THEN ?').join(' ');
        const caseParams: any[] = [];
        for (const u of updates) caseParams.push(u.codigo, u.newStock);
        const codigos = updates.map((u) => u.codigo);
        const sql = `UPDATE estoque SET ESTOQUE = CASE CODIGO ${caseClauses} END WHERE LOJA = ? AND CODIGO IN (?)`;
        const [result]: any = await conn.query(sql, [...caseParams, storeCode, codigos]);
        // affectedRows pode vir < updates.length se algum CODIGO ja tinha o
        // mesmo ESTOQUE (MySQL nao conta como modificado). Loga warning mas
        // nao aborta â€” o SET foi aplicado.
        const affected = result?.affectedRows ?? 0;
        if (affected < updates.length) {
          this.logger.warn(
            `Batch UPDATE: esperado ${updates.length}, affected ${affected} (loja ${storeCode}). ` +
            `Pode ser MySQL nao contando linhas inalteradas. Verificando...`,
          );
        }

        for (const u of updates) {
          applied.push({ sku: u.sku, storeCode, qty: u.qty, previousStock: u.previousStock, newStock: u.newStock });
        }
      }

      await conn.commit();
      this.logger.log(
        `ERP baixa BATCH OK: ${applied.length} item(ns) em ${byStore.size} loja(s). ` +
          applied.slice(0, 5).map((a) => `${a.sku}/${a.storeCode}: ${a.previousStock}â†’${a.newStock}`).join(', ') +
          (applied.length > 5 ? ` â€¦ (+${applied.length - 5} mais)` : ''),
      );
      void this.mirrorStockWriteThrough(applied);
      return { success: true, applied };
    } catch (e: any) {
      try { await conn.rollback(); } catch { /* ignore */ }
      const msg = String(e?.message || e);
      this.logger.error(`ERP baixa FALHOU (rollback): ${msg}`);
      return { success: false, applied: [], error: msg };
    } finally {
      conn.release();
    }
  }

  /**
   * INCREASE estoque no Gigasistemas â€” usado pela loja DESTINO ao "Dar Entrada"
   * em uma remessa de realinhamento recebida.
   *
   * Espelho exato de `decreaseStock`:
   *  - Mesmo kill-switch ERP_WRITE_ENABLED
   *  - Mesma transaÃ§Ã£o ACID com rollback
   *  - Mesmo retry/backoff em erro transiente
   *  - SELECT FOR UPDATE â†’ soma â†’ UPDATE
   *
   * DiferenÃ§as do decrease:
   *  - SOMA em vez de subtrair
   *  - NÃ£o tem checagem de "estoque negativo" (sempre Ã© seguro aumentar)
   *  - Se SKU nÃ£o existir na tabela `estoque` da loja destino, o registro Ã©
   *    INSERIDO (peÃ§a que nunca passou por essa loja antes â€” comum em
   *    realinhamento. SÃ³ o INSERT, sem mexer em produtos.)
   */
  async increaseStock(
    items: Array<{ sku: string; qty: number; storeCode: string }>,
  ): Promise<{
    success: boolean;
    applied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }>;
    error?: string;
    attempts?: number;
  }> {
    if (!this.isWriteEnabled) {
      return { success: false, applied: [], error: 'ERP_WRITE_ENABLED nÃ£o habilitado' };
    }
    if (!this.pool) {
      return { success: false, applied: [], error: 'Pool ERP nÃ£o inicializado' };
    }
    if (!items.length) {
      return { success: true, applied: [] };
    }

    const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ER_LOCK_WAIT_TIMEOUT']);
    const TRANSIENT_MSG_PATTERNS = [/read ETIMEDOUT/i, /connect ETIMEDOUT/i, /Connection lost/i, /closed state/i];
    const isTransient = (err: any): boolean => {
      const code = String(err?.code ?? '').toUpperCase();
      if (TRANSIENT_CODES.has(code)) return true;
      const msg = String(err?.message ?? err ?? '');
      return TRANSIENT_MSG_PATTERNS.some((rx) => rx.test(msg));
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const BACKOFF_MS = [0, 1000, 3000];

    let lastError: any = null;
    for (let attempt = 1; attempt <= BACKOFF_MS.length; attempt++) {
      if (BACKOFF_MS[attempt - 1] > 0) await sleep(BACKOFF_MS[attempt - 1]);
      const result = await this.increaseStockOnce(items);
      if (result.success) {
        return { ...result, attempts: attempt };
      }
      lastError = result.error;
      if (!isTransient({ message: lastError })) {
        return { ...result, attempts: attempt };
      }
      this.logger.warn(`ERP entrada tentativa ${attempt}/${BACKOFF_MS.length} falhou (transient): ${lastError}`);
    }
    return { success: false, applied: [], error: `${lastError} (${BACKOFF_MS.length} tentativas)`, attempts: BACKOFF_MS.length };
  }

  /** ExecuÃ§Ã£o Ãºnica do INCREASE â€” extraÃ­da pra retry. */
  private async increaseStockOnce(
    items: Array<{ sku: string; qty: number; storeCode: string }>,
  ): Promise<{
    success: boolean;
    applied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }>;
    error?: string;
  }> {
    const normalizeStoreCode = (raw: string): string => {
      const s = String(raw || '').trim().toUpperCase().replace(/^LJ/i, '');
      const n = parseInt(s, 10);
      if (Number.isNaN(n) || n < 1 || n > 99) return s;
      return String(n).padStart(2, '0');
    };

    // â”€â”€ 1. NORMALIZA + AGREGA POR (SKU, LOJA) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const aggregated = new Map<string, { sku: string; qty: number; storeCode: string }>();
    for (const it of items) {
      const sku = String(it.sku || '').trim();
      const store = normalizeStoreCode(it.storeCode);
      const qty = Number(it.qty);
      if (!sku || !store || !qty || qty <= 0) {
        return { success: false, applied: [], error: `Item invalido: sku=${sku} loja=${store} qty=${qty}` };
      }
      const key = `${sku}|${store}`;
      const ex = aggregated.get(key);
      if (ex) ex.qty += qty;
      else aggregated.set(key, { sku, qty, storeCode: store });
    }

    // â”€â”€ 2. AGRUPA POR LOJA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const byStore = new Map<string, Array<{ sku: string; qty: number }>>();
    for (const it of aggregated.values()) {
      if (!byStore.has(it.storeCode)) byStore.set(it.storeCode, []);
      byStore.get(it.storeCode)!.push({ sku: it.sku, qty: it.qty });
    }

    const conn = await this.pool.getConnection();
    const applied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }> = [];

    try {
      await conn.beginTransaction();

      // â”€â”€ 3. PROCESSA UMA LOJA POR VEZ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      for (const [storeCode, storeItems] of byStore) {
        // Coleta variantes de cada SKU
        const skuToVariants = new Map<string, string[]>();
        const allVariants = new Set<string>();
        for (const it of storeItems) {
          const vs = this.skuVariants(it.sku);
          skuToVariants.set(it.sku, vs);
          for (const v of vs) allVariants.add(v);
        }
        const variantArr = Array.from(allVariants);
        if (variantArr.length === 0) continue;

        // 1 SELECT FOR UPDATE pra trazer estoque atual + travar linhas
        const [rows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO, ESTOQUE FROM estoque
            WHERE CODIGO IN (?) AND LOJA = ?
            FOR UPDATE`,
          [variantArr, storeCode],
        );
        const variantMap = new Map<string, { codigo: string; estoque: number }>();
        for (const row of rows as any[]) {
          const codigo = String(row.CODIGO).trim();
          variantMap.set(codigo, { codigo, estoque: Number(row.ESTOQUE) || 0 });
        }

        // Pra cada item: existe â†’ vai pra UPDATE batch; nao existe â†’ vai pra INSERT
        type Update = { codigo: string; newStock: number; sku: string; previousStock: number; qty: number };
        type Insert = { codigo: string; sku: string; qty: number };
        const updates: Update[] = [];
        const inserts: Insert[] = [];
        const naoEncontradosVariantes: string[][] = []; // pra resolver via produtos

        for (const it of storeItems) {
          const variants = skuToVariants.get(it.sku) || [];
          let bestMatch: { codigo: string; estoque: number } | null = null;
          for (const v of variants) {
            const m = variantMap.get(v);
            if (m && (!bestMatch || m.estoque > bestMatch.estoque)) bestMatch = m;
          }
          if (bestMatch) {
            const previousStock = bestMatch.estoque;
            const newStock = previousStock + it.qty;
            updates.push({ codigo: bestMatch.codigo, newStock, sku: it.sku, previousStock, qty: it.qty });
            bestMatch.estoque = newStock; // se outro item bater no mesmo codigo
          } else {
            // Vai pra INSERT â€” antes resolve CODIGO real via produtos
            naoEncontradosVariantes.push(variants);
            inserts.push({ codigo: it.sku, sku: it.sku, qty: it.qty }); // codigo provisorio
          }
        }

        // Resolve CODIGOs dos inserts via batch lookup em produtos (1 query)
        if (inserts.length > 0) {
          const allInsertVariants = Array.from(new Set(naoEncontradosVariantes.flat()));
          let prodMap = new Map<string, string>();
          try {
            const [prodRows] = await conn.query<mysql.RowDataPacket[]>(
              `SELECT CODIGO FROM produtos WHERE CODIGO IN (?)`,
              [allInsertVariants],
            );
            for (const row of prodRows as any[]) {
              const codigo = String(row.CODIGO).trim();
              prodMap.set(codigo, codigo);
            }
          } catch { /* ignore â€” usa o sku original */ }
          // Atualiza codigo dos inserts pra usar o do cadastro quando achou
          for (let i = 0; i < inserts.length; i++) {
            const variants = naoEncontradosVariantes[i];
            for (const v of variants) {
              if (prodMap.has(v)) {
                inserts[i].codigo = v;
                break;
              }
            }
          }
        }

        // â”€â”€ 4a. BATCH UPDATE com CASE WHEN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (updates.length > 0) {
          const caseClauses = updates.map(() => 'WHEN ? THEN ?').join(' ');
          const caseParams: any[] = [];
          for (const u of updates) caseParams.push(u.codigo, u.newStock);
          const codigos = updates.map((u) => u.codigo);
          const sql = `UPDATE estoque SET ESTOQUE = CASE CODIGO ${caseClauses} END WHERE LOJA = ? AND CODIGO IN (?)`;
          const [result]: any = await conn.query(sql, [...caseParams, storeCode, codigos]);
          const affected = result?.affectedRows ?? 0;
          if (affected < updates.length) {
            // CRITICAL: UPDATE nÃ£o atingiu todas as linhas esperadas.
            // Antes sÃ³ fazia warn â†’ silenciava bug e devoluÃ§Ã£o ficava
            // "pendente" sem error registrado. Agora lanÃ§a erro â†’ catch
            // do try/catch principal faz rollback + retorna success:false
            // com mensagem clara pro caller (returns.service / retry).
            this.logger.error(
              `Batch INCREASE UPDATE: esperado ${updates.length}, affected ${affected} (loja ${storeCode}) â€” codigos: ${updates.map((u) => u.codigo).join(', ')}`,
            );
            throw new Error(
              `UPDATE estoque loja ${storeCode}: afetou ${affected}/${updates.length} linhas. ` +
              `CODIGO(s) nao casaram com o que existe em estoque: ${updates.map((u) => u.codigo).join(', ')}`,
            );
          }
          for (const u of updates) {
            applied.push({ sku: u.sku, storeCode, qty: u.qty, previousStock: u.previousStock, newStock: u.newStock });
          }
        }

        // â”€â”€ 4b. BATCH INSERT (linhas novas em loja destino) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (inserts.length > 0) {
          const placeholders = inserts.map(() => '(?, ?, ?)').join(', ');
          const values: any[] = [];
          for (const ins of inserts) values.push(ins.codigo, storeCode, ins.qty);
          await conn.query(
            `INSERT INTO estoque (CODIGO, LOJA, ESTOQUE) VALUES ${placeholders}`,
            values,
          );
          for (const ins of inserts) {
            applied.push({ sku: ins.sku, storeCode, qty: ins.qty, previousStock: 0, newStock: ins.qty });
          }
        }
      }

      await conn.commit();
      this.logger.log(
        `ERP entrada BATCH OK: ${applied.length} item(ns) em ${byStore.size} loja(s). ` +
          applied.slice(0, 5).map((a) => `${a.sku}/${a.storeCode}: ${a.previousStock}â†’${a.newStock}`).join(', ') +
          (applied.length > 5 ? ` â€¦ (+${applied.length - 5} mais)` : ''),
      );
      void this.mirrorStockWriteThrough(applied);
      return { success: true, applied };
    } catch (e: any) {
      try { await conn.rollback(); } catch { /* ignore */ }
      const msg = String(e?.message || e);
      this.logger.error(`ERP entrada FALHOU (rollback): ${msg}`);
      return { success: false, applied: [], error: msg };
    } finally {
      conn.release();
    }
  }

  /**
   * CREATE INDEX em uma tabela do Giga (DDL admin).
   * Usado pra criar Ã­ndice composto que acelera lookup de parcelas em aberto.
   *
   * Idempotente: verifica via SHOW INDEX antes â€” se jÃ¡ existe, retorna ok.
   * Em MySQL 5.6+ o CREATE INDEX Ã© ONLINE (nÃ£o bloqueia escrita).
   * Timeout estendido pra 10min (operaÃ§Ã£o lenta em tabelas grandes).
   */
  async createIndexIfNotExists(input: {
    table: string;
    indexName: string;
    columns: string[];
  }): Promise<{
    ok: boolean;
    alreadyExists?: boolean;
    durationMs?: number;
    error?: string;
    table: string;
    indexName: string;
    columns: string[];
  }> {
    if (!this.isWriteEnabled) {
      return {
        ok: false,
        error: 'ERP_WRITE_ENABLED precisa estar ligado',
        table: input.table,
        indexName: input.indexName,
        columns: input.columns,
      };
    }
    if (!this.pool) {
      return {
        ok: false,
        error: 'Pool ERP nÃ£o inicializado',
        table: input.table,
        indexName: input.indexName,
        columns: input.columns,
      };
    }

    // Sanitiza nomes (apenas letras/nÃºmeros/_ permitidos pra evitar injection)
    const safeRx = /^[a-zA-Z0-9_]+$/;
    if (!safeRx.test(input.table) || !safeRx.test(input.indexName)) {
      return {
        ok: false,
        error: 'Nome de tabela/Ã­ndice invÃ¡lido',
        table: input.table,
        indexName: input.indexName,
        columns: input.columns,
      };
    }
    for (const c of input.columns) {
      if (!safeRx.test(c)) {
        return {
          ok: false,
          error: `Nome de coluna invÃ¡lido: ${c}`,
          table: input.table,
          indexName: input.indexName,
          columns: input.columns,
        };
      }
    }

    const conn = await this.pool.getConnection();
    try {
      // 1. Verifica se jÃ¡ existe
      const checkSql = `SHOW INDEX FROM \`${input.table}\` WHERE Key_name = ?`;
      const [rows]: any = await conn.execute(checkSql, [input.indexName]);
      if (rows && rows.length > 0) {
        this.logger.log(
          `[createIndex] ${input.table}.${input.indexName} JÃ EXISTE (${rows.length} colunas)`,
        );
        return {
          ok: true,
          alreadyExists: true,
          table: input.table,
          indexName: input.indexName,
          columns: input.columns,
        };
      }

      // 2. Cria
      const colList = input.columns.map((c) => `\`${c}\``).join(', ');
      const createSql = `CREATE INDEX \`${input.indexName}\` ON \`${input.table}\` (${colList})`;
      this.logger.log(`[createIndex] Executando: ${createSql}`);
      const t0 = Date.now();
      await conn.execute(createSql);
      const durationMs = Date.now() - t0;
      this.logger.log(
        `[createIndex] ${input.table}.${input.indexName} CRIADO em ${durationMs}ms`,
      );
      return {
        ok: true,
        alreadyExists: false,
        durationMs,
        table: input.table,
        indexName: input.indexName,
        columns: input.columns,
      };
    } catch (e: any) {
      const msg = String(e?.message || e);
      this.logger.error(`[createIndex] FALHOU: ${msg}`);
      return {
        ok: false,
        error: msg,
        table: input.table,
        indexName: input.indexName,
        columns: input.columns,
      };
    } finally {
      conn.release();
    }
  }

  /**
   * CRIA PARCELAS DE CREDIÃRIO no Giga â€” INSERT direto na tabela `movimento`.
   *
   * Pega o Ãºltimo REGISTRO existente, incrementa pra cada nova parcela.
   * CONTROLE compartilhado entre as parcelas da mesma compra (= nÃºmero de
   * compra). Cria N linhas com vencimentos mensais a partir do primeiro.
   *
   * PadrÃ£o Wincred:
   *   - REGISTRO  = sequencial Ãºnico por linha
   *   - CONTROLE  = mesmo pra todas as parcelas da compra (numero da compra)
   *   - PARCELA   = 1, 2, 3, ..., N
   *   - VENCIMENTO = primeiro + (parcela âˆ’ 1) Ã— 30 dias (calendÃ¡rio mensal)
   *   - VALORPARCELA = ajustado pra fechar exato (Ãºltima absorve diferenÃ§a)
   *   - PAGO       = 'N'
   *
   * Retorna { success, registroInicial, controleUsado, parcelas[] } ou erro.
   */
  async createCrediarioParcelas(input: {
    codCliente: string;
    nomeCliente: string;
    valorTotal: number;          // valor financiado (jÃ¡ descontada entrada)
    parcelas: number;             // qtd N
    primeiroVencimento: Date;
    dataCompra: Date;
    loja: string;                 // cÃ³digo da loja onde foi feita a venda
    observacao?: string;
    columns: {
      registro: string | null;
      controle: string | null;
      numeroCompra: string | null;
      loja: string | null;
      codCliente: string | null;
      nome: string | null;
      dataCompra: string | null;
      valorCompra: string | null;
      parcela: string | null;
      totalParcelas: string | null;
      vencimento: string | null;
      valorParcela: string | null;
      pago: string | null;
      obs: string | null;
    };
  }): Promise<{
    success: boolean;
    error?: string;
    registroInicial?: number;
    controleUsado?: number;
    parcelas?: Array<{ parcela: number; vencimento: string; valor: number; registro: number }>;
  }> {
    if (!this.isWriteEnabled) {
      return { success: false, error: 'ERP_WRITE_ENABLED nÃ£o habilitado' };
    }
    if (!this.pool) return { success: false, error: 'Pool ERP nÃ£o inicializado' };

    const c = input.columns;
    if (!c.registro || !c.controle || !c.codCliente || !c.vencimento || !c.valorParcela || !c.parcela) {
      return {
        success: false,
        error: 'Colunas obrigatÃ³rias nÃ£o detectadas (registro/controle/codCliente/vencimento/valorParcela/parcela)',
      };
    }
    if (input.parcelas < 1 || input.parcelas > 24) {
      return { success: false, error: 'Parcelas deve estar entre 1 e 24' };
    }
    if (input.valorTotal <= 0) {
      return { success: false, error: 'Valor total deve ser maior que zero' };
    }

    // CÃ¡lculo das parcelas: iguais com ajuste na Ãºltima pra bater o total
    const valorIgual = Math.round((input.valorTotal / input.parcelas) * 100) / 100;
    const valorUltima = Math.round((input.valorTotal - valorIgual * (input.parcelas - 1)) * 100) / 100;

    const conn = await this.pool.getConnection();
    let txStarted = false;
    try {
      // TRANSAÃ‡ÃƒO: as N parcelas precisam entrar TODAS ou NENHUMA. Sem isso,
      // uma falha no meio (ex: parcela 4 de 6) deixava parcelas Ã³rfÃ£s no Giga,
      // que apareciam pro cliente como dÃ­vida parcial fantasma.
      await conn.beginTransaction();
      txStarted = true;

      // Pega Ãºltimo REGISTRO + Ãºltimo CONTROLE pra incrementar.
      // FOR UPDATE serializa contra outra venda criando crediÃ¡rio ao mesmo
      // tempo â€” evita 2 vendas pegarem o mesmo CONTROLE/REGISTRO.
      const [maxRows]: any = await conn.execute(
        `SELECT COALESCE(MAX(\`${c.registro}\`), 0) AS maxReg, COALESCE(MAX(\`${c.controle}\`), 0) AS maxCtl FROM \`movimento\` FOR UPDATE`,
      );
      const startRegistro = Number(maxRows[0]?.maxReg || 0) + 1;
      const novoControle = Number(maxRows[0]?.maxCtl || 0) + 1;

      const parcelasDetalhe: Array<{ parcela: number; vencimento: string; valor: number; registro: number }> = [];

      // Insere cada parcela
      for (let i = 0; i < input.parcelas; i++) {
        const numeroParcela = i + 1;
        const isUltima = numeroParcela === input.parcelas;
        const valor = isUltima ? valorUltima : valorIgual;
        const registro = startRegistro + i;

        // Vencimento: primeiro + N meses (preserva o dia)
        const venc = new Date(input.primeiroVencimento);
        venc.setMonth(venc.getMonth() + i);

        // Monta INSERT dinÃ¢mico (sÃ³ inclui colunas detectadas)
        const fields: string[] = [];
        const placeholders: string[] = [];
        const values: any[] = [];

        const add = (col: string | null, val: any) => {
          if (col == null) return;
          fields.push(`\`${col}\``);
          placeholders.push('?');
          values.push(val);
        };

        add(c.registro, registro);
        add(c.controle, novoControle);
        if (c.numeroCompra) add(c.numeroCompra, novoControle); // numeroCompra = controle (mesma sequÃªncia)
        add(c.codCliente, input.codCliente);
        if (c.nome) add(c.nome, input.nomeCliente);
        if (c.loja) add(c.loja, input.loja);
        if (c.dataCompra) add(c.dataCompra, input.dataCompra);
        if (c.valorCompra) add(c.valorCompra, input.valorTotal);
        add(c.parcela, numeroParcela);
        if (c.totalParcelas) add(c.totalParcelas, input.parcelas);
        add(c.vencimento, venc);
        add(c.valorParcela, valor);
        if (c.pago) add(c.pago, 'N');
        if (c.obs && input.observacao) add(c.obs, input.observacao.slice(0, 200));

        const sql = `INSERT INTO \`movimento\` (${fields.join(', ')}) VALUES (${placeholders.join(', ')})`;
        await conn.execute(sql, values);

        parcelasDetalhe.push({
          parcela: numeroParcela,
          vencimento: venc.toISOString().slice(0, 10),
          valor,
          registro,
        });
      }

      await conn.commit();
      txStarted = false;

      this.logger.log(
        `[crediario] Criou ${input.parcelas} parcelas no Giga: cliente=${input.codCliente} controle=${novoControle} total=R$${input.valorTotal.toFixed(2)}`,
      );

      return {
        success: true,
        registroInicial: startRegistro,
        controleUsado: novoControle,
        parcelas: parcelasDetalhe,
      };
    } catch (e: any) {
      const msg = String(e?.message || e);
      this.logger.error(`[crediario] INSERT em movimento FALHOU (rollback): ${msg}`);
      if (txStarted) {
        try {
          await conn.rollback();
        } catch (rbErr: any) {
          this.logger.error(`[crediario] rollback FALHOU: ${String(rbErr?.message || rbErr)}`);
        }
      }
      return { success: false, error: msg };
    } finally {
      conn.release();
    }
  }

  /**
   * BAIXA PARCELA DE CREDIÃRIO â€” UPDATE direto na tabela `movimento` do Giga.
   *
   * Marca a parcela como paga (PAGO='S' + DATA_PAGAMENTO=hoje + VALOR_PAGO=valorRecebido).
   * Os nomes reais das colunas variam por instalaÃ§Ã£o â€” recebemos via parÃ¢metro
   * (CrediariosService jÃ¡ detectou via `detectColumns`).
   *
   * IdentificaÃ§Ã£o da parcela: chave composta (REGISTRO + CONTROLE).
   *
   * Retorna { success, error? } â€” sem retry, sem transaÃ§Ã£o multi-row,
   * pra simplicidade. A baixa local (Postgres) Ã© a fonte da verdade pro
   * recibo; este UPDATE Ã© "espelho" pro Giga.
   */
  /**
   * INSERT mÃºltiplas linhas em `caixa` com MARCADO='SIM'.
   * Usado pelo sistema MARCADOS quando vendedora cria marcado pelo PDV.
   *
   * Cada item vira 1 linha em `caixa`. Todas compartilham o mesmo CONTROLE
   * (gerado pegando MAX(CONTROLE)+1) â€” assim agrupa o marcado pra o cliente
   * conseguir ver junto na consulta.
   *
   * Retorna { success, controle, error? } â€” caller pode logar o controle
   * e mostrar pra vendedora como comprovante.
   */
  async insertCaixaMarcado(input: {
    items: Array<{
      codigo: string;
      descricao: string;
      quantidade: number;
      valor: number;
      valorTotal: number;
      vendedor?: number;
      operador?: number;
    }>;
    cliente: number;
    loja: string;
  }): Promise<{ success: boolean; controle?: number; error?: string }> {
    if (!this.isWriteEnabled) {
      return { success: false, error: 'ERP_WRITE_ENABLED nÃ£o habilitado' };
    }
    if (!this.pool) {
      return { success: false, error: 'Pool ERP nÃ£o inicializado' };
    }
    if (!input.items?.length) {
      return { success: false, error: 'Sem items pra marcar' };
    }
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      // PrÃ³ximo CONTROLE â€” agrupa todos os items desse marcado
      const [maxRows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT COALESCE(MAX(NUMERO), 0) + 1 AS proxNumero FROM caixa`,
      );
      const proxNumero = Number((maxRows[0] as any).proxNumero) || 1;

      const lojaCode = String(input.loja || '').trim().toUpperCase().replace(/^LJ/i, '').padStart(2, '0');
      const today = new Date();
      const dataStr = today.toISOString().slice(0, 10); // YYYY-MM-DD
      const horaStr = today.toTimeString().slice(0, 8); // HH:MM:SS

      // INSERT cada item
      for (const it of input.items) {
        await conn.query(
          `INSERT INTO caixa
            (NUMERO, CODIGO, DATA, CLIENTE, DESCRICAO, QUANTIDADE, VALOR, VALORTOTAL,
             OPERADOR, VENDEDOR, MARCADO, LOJA, HORA)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SIM', ?, ?)`,
          [
            proxNumero,
            it.codigo,
            dataStr,
            input.cliente,
            it.descricao,
            it.quantidade,
            it.valor,
            it.valorTotal,
            it.operador || 0,
            it.vendedor || 0,
            lojaCode,
            horaStr,
          ],
        );
      }

      await conn.commit();
      this.logger.log(
        `[caixa-marcado] INSERT OK: cliente=${input.cliente} ` +
        `controle=${proxNumero} items=${input.items.length} loja=${lojaCode}`,
      );
      return { success: true, controle: proxNumero };
    } catch (e: any) {
      try { await conn.rollback(); } catch { /* ignore */ }
      const msg = String(e?.message || e);
      this.logger.error(`[caixa-marcado] INSERT FALHOU: ${msg}`);
      return { success: false, error: msg };
    } finally {
      conn.release();
    }
  }

  async markCrediarioParcelaPaid(input: {
    registro: string | number;
    controle: string | number;
    valorPago: number;
    dataPagamento?: Date;
    /** Opcional: valor de juros calculado (vai pra coluna JUROS se detectada) */
    juros?: number;
    /** Opcional: valor de multa calculado (vai pra coluna MULTA se detectada) */
    multa?: number;
    columns: {
      registro: string | null;
      controle: string | null;
      pago: string | null;
      dataPagamento: string | null;
      valorPago: string | null;
      juros?: string | null;
      multa?: string | null;
    };
  }): Promise<{ success: boolean; error?: string; affectedRows?: number }> {
    if (!this.isWriteEnabled) {
      return { success: false, error: 'ERP_WRITE_ENABLED nÃ£o habilitado' };
    }
    if (!this.pool) {
      return { success: false, error: 'Pool ERP nÃ£o inicializado' };
    }
    const { columns } = input;
    if (!columns.registro || !columns.controle) {
      return { success: false, error: 'Colunas REGISTRO/CONTROLE nÃ£o detectadas' };
    }

    // Monta SET dinamicamente â€” sÃ³ inclui colunas que existem no Giga local.
    const sets: string[] = [];
    const params: any[] = [];

    // CRÃTICO: PAGO Ã© o campo que o WinCred consulta pra exibir no relatÃ³rio
    // de recebidos. Se ficar nulo, a baixa nÃ£o aparece NA UI do WinCred mesmo
    // com data preenchida. Sempre tentamos atualizar â€” usa nome detectado se
    // existir, senÃ£o tenta literal "PAGO" como fallback (WinCred padrÃ£o).
    //
    // VALOR: Lurd's confirmou que WinCred grava "S" (nÃ£o "SIM" como pensei).
    // O REAL problema era a coluna PAGAMENTO ficar em branco â€” corrigido em
    // detectColumns. Override por env var ERP_PAGO_VALOR_SIM se outra loja
    // precisar de outro valor.
    const pagoCol = columns.pago || 'PAGO';
    const pagoValor = String(this.config.get('ERP_PAGO_VALOR_SIM') ?? 'S').trim();
    sets.push(`\`${pagoCol}\` = ?`);
    params.push(pagoValor);
    if (!columns.pago) {
      this.logger.warn(
        `[crediario] coluna PAGO nÃ£o detectada â€” usando fallback hardcoded "PAGO". ` +
        `Se a tabela tem outro nome, ajuste detectColumns() ou o UPDATE pode falhar.`,
      );
    }

    if (columns.dataPagamento) {
      sets.push(`\`${columns.dataPagamento}\` = ?`);
      params.push(input.dataPagamento || new Date());
    }
    if (columns.valorPago) {
      sets.push(`\`${columns.valorPago}\` = ?`);
      params.push(input.valorPago);
    }
    // Juros e multa: sÃ³ atualiza se a coluna foi detectada E o valor foi passado.
    // Sem isso, na baixa retroativa o WinCred mostra "Juros: vazio".
    if (columns.juros && input.juros !== undefined) {
      sets.push(`\`${columns.juros}\` = ?`);
      params.push(Math.round(input.juros * 100) / 100);
    }
    if (columns.multa && input.multa !== undefined) {
      sets.push(`\`${columns.multa}\` = ?`);
      params.push(Math.round(input.multa * 100) / 100);
    }

    if (sets.length === 0) {
      return { success: false, error: 'Nenhuma coluna pra atualizar' };
    }

    // WHERE chave composta
    const sql = `UPDATE \`movimento\` SET ${sets.join(', ')} WHERE \`${columns.registro}\` = ? AND \`${columns.controle}\` = ? LIMIT 1`;
    params.push(input.registro, input.controle);

    const conn = await this.pool.getConnection();
    try {
      const [result]: any = await conn.execute(sql, params);
      const affected = result?.affectedRows ?? 0;
      if (affected === 0) {
        return {
          success: false,
          error: `UPDATE nÃ£o afetou linha (REGISTRO=${input.registro} CONTROLE=${input.controle}). JÃ¡ paga ou inexistente.`,
          affectedRows: 0,
        };
      }
      this.logger.log(
        `[crediario] baixa Giga OK: REGISTRO=${input.registro} CONTROLE=${input.controle} valor=R$${input.valorPago.toFixed(2)}`,
      );
      return { success: true, affectedRows: affected };
    } catch (e: any) {
      const msg = String(e?.message || e);
      this.logger.error(`[crediario] UPDATE movimento FALHOU: ${msg}`);
      return { success: false, error: msg };
    } finally {
      conn.release();
    }
  }

  /**
   * REVERTE a baixa de uma parcela no Giga (estorno).
   * Coloca PAGO='N', limpa DATA_PAGAMENTO, VALOR_PAGO, JUROS, MULTA.
   * Usado quando o usuÃ¡rio precisa desfazer uma baixa feita por engano.
   */
  /**
   * Deleta uma linha da tabela `caixa` no Wincred â€” usado quando uma peÃ§a MARCADA
   * Ã© devolvida ao estoque (cliente trouxe de volta). Remove a "reserva" que
   * estava no nome do cliente.
   *
   * Por seguranÃ§a, SÃ“ deleta se a linha tiver MARCADO='SIM' â€” evita apagar
   * vendas reais por engano.
   */
  async deleteCaixaMarcadoRow(input: {
    registro: number | string;
  }): Promise<{ success: boolean; error?: string; affectedRows?: number }> {
    if (!this.isWriteEnabled) {
      return { success: false, error: 'ERP_WRITE_ENABLED nÃ£o habilitado' };
    }
    if (!this.pool) {
      return { success: false, error: 'Pool ERP nÃ£o inicializado' };
    }
    const reg = Number(input.registro);
    if (!reg || isNaN(reg)) {
      return { success: false, error: 'REGISTRO invÃ¡lido' };
    }
    try {
      // SQL defensivo: sÃ³ deleta se for marcado mesmo (MARCADO='SIM' UPPER).
      // Tradeoff aceito: se a coluna MARCADO nÃ£o existir (improvÃ¡vel em
      // schema Wincred), o WHERE explode com error de coluna desconhecida.
      const [result] = await this.pool.query<mysql.OkPacket>(
        `DELETE FROM caixa WHERE REGISTRO = ? AND UPPER(COALESCE(MARCADO, '')) = 'SIM' LIMIT 1`,
        [reg],
      );
      const affected = (result as any)?.affectedRows ?? 0;
      this.logger.log(`[deleteCaixaMarcado] REGISTRO=${reg} affected=${affected}`);
      if (affected === 0) {
        return { success: false, error: `Nenhuma linha caixa encontrada com REGISTRO=${reg} e MARCADO='SIM'`, affectedRows: 0 };
      }
      return { success: true, affectedRows: affected };
    } catch (e: any) {
      this.logger.error(`[deleteCaixaMarcado] falhou REGISTRO=${reg}: ${e?.message || e}`);
      return { success: false, error: e?.message || String(e) };
    }
  }

  async markCrediarioParcelaUnpaid(input: {
    registro: string | number;
    controle: string | number;
    columns: {
      registro: string | null;
      controle: string | null;
      pago: string | null;
      dataPagamento: string | null;
      valorPago: string | null;
      juros?: string | null;
      multa?: string | null;
    };
  }): Promise<{ success: boolean; error?: string; affectedRows?: number }> {
    if (!this.isWriteEnabled) {
      return { success: false, error: 'ERP_WRITE_ENABLED nao habilitado' };
    }
    if (!this.pool) {
      return { success: false, error: 'Pool ERP nao inicializado' };
    }
    const { columns } = input;
    if (!columns.registro || !columns.controle) {
      return { success: false, error: 'Colunas REGISTRO/CONTROLE nao detectadas' };
    }

    const sets: string[] = [];
    const params: any[] = [];

    const pagoCol = columns.pago || 'PAGO';
    const pagoValor = String(this.config.get('ERP_PAGO_VALOR_NAO') ?? 'N').trim();
    sets.push(`\`${pagoCol}\` = ?`);
    params.push(pagoValor);

    if (columns.dataPagamento) {
      sets.push(`\`${columns.dataPagamento}\` = NULL`);
    }
    if (columns.valorPago) {
      sets.push(`\`${columns.valorPago}\` = 0`);
    }
    if (columns.juros) {
      sets.push(`\`${columns.juros}\` = 0`);
    }
    if (columns.multa) {
      sets.push(`\`${columns.multa}\` = 0`);
    }

    const sql = `UPDATE \`movimento\` SET ${sets.join(', ')} WHERE \`${columns.registro}\` = ? AND \`${columns.controle}\` = ? LIMIT 1`;
    params.push(input.registro, input.controle);

    const conn = await this.pool.getConnection();
    try {
      const [result]: any = await conn.execute(sql, params);
      const affected = result?.affectedRows ?? 0;
      if (affected === 0) {
        return {
          success: false,
          error: `UPDATE de estorno nao afetou linha (REGISTRO=${input.registro} CONTROLE=${input.controle}).`,
          affectedRows: 0,
        };
      }
      this.logger.log(
        `[crediario] estorno Giga OK: REGISTRO=${input.registro} CONTROLE=${input.controle}`,
      );
      return { success: true, affectedRows: affected };
    } catch (e: any) {
      const msg = String(e?.message || e);
      this.logger.error(`[crediario] UPDATE estorno FALHOU: ${msg}`);
      return { success: false, error: msg };
    } finally {
      conn.release();
    }
  }

  /**
   * Consulta estoque por SKU Ã— loja na tabela `estoque` do WinCred.
   * Retorna sÃ³ registros com ESTOQUE > 0.
   *
   * TOLERANTE A ZEROS Ã€ ESQUERDA: o WooCommerce pode enviar SKU "5383498"
   * mas no Giga o CODIGO estÃ¡ cadastrado como "0005383498". Sem essa
   * tolerÃ¢ncia, o roteamento nÃ£o acha estoque e divide pedidos errado.
   *
   * EstratÃ©gia:
   *   1. Pra cada SKU recebido, gera variantes com padding 3-14 dÃ­gitos
   *   2. Consulta no Giga com a uniÃ£o de todas as variantes
   *   3. No retorno, mapeia o CODIGO do Giga DE VOLTA pro SKU original
   *      do caller (pra que o resto do sistema continue trabalhando com
   *      o formato que enviou)
   */
  async getStock(skus: string[], storeCodes: string[]): Promise<StockEntry[]> {
    if (!skus.length || !storeCodes.length) return [];
    if (this.mirrorReadsEnabled) {
      try {
        if (await this.mirrorStockReady()) return await this.getStockFromMirror(skus, storeCodes);
      } catch (e) {
        this.logger.warn(`[mirror-reads] getStock: ${(e as Error).message} → Giga ao vivo`);
      }
    }
    if (!this.pool) return [];

    // Normaliza SKUs originais (sem duplicatas, sem strings vazias)
    const uniqueOriginals = Array.from(
      new Set(skus.map((s) => String(s || '').trim()).filter(Boolean)),
    );
    if (!uniqueOriginals.length) return [];

    // PASSO 1 â€” Resolve CODIGO REAL de cada SKU consultando o cadastro `produtos`.
    //
    // Por que NÃƒO basta expandir e buscar direto em `estoque`:
    //   - SKU "5383498" pode existir no Giga como peÃ§a A (CODIGO="5383498")
    //     E peÃ§a B totalmente diferente (CODIGO="0005383498").
    //   - Se buscamos `WHERE CODIGO IN (variantes)` direto em estoque,
    //     misturamos peÃ§as e o roteamento envia pedido pra loja que tem
    //     o produto ERRADO. Bug observado em prod: pedido roteado pra Pira
    //     porque "5383498" sem zeros existe lÃ¡ como outra peÃ§a.
    //
    // SoluÃ§Ã£o: descobrir, no cadastro, qual CODIGO especÃ­fico Ã© o "5383498"
    // que o caller passou. Ele sÃ³ pode ser UM (cadastro tem PK em CODIGO).
    // AÃ­ buscamos estoque SÃ“ desse CODIGO real.

    const { allVariants, variantToOriginal } = this.expandSkus(uniqueOriginals);
    if (!allVariants.length) return [];

    // codigoGiga â†’ sku original do caller
    const codigoGigaToOriginal = new Map<string, string>();
    try {
      const [prodRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO FROM produtos WHERE CODIGO IN (?)`,
        [allVariants],
      );
      for (const r of prodRows as any[]) {
        const codigoGiga = String(r.CODIGO).trim();
        const originalSku = variantToOriginal.get(codigoGiga);
        if (!originalSku) continue;
        // Se 2+ variantes do mesmo SKU original existem como produtos diferentes
        // (caso patolÃ³gico), prioriza a versÃ£o MAIS LONGA (com mais zeros Ã 
        // esquerda), que Ã© o padrÃ£o real do Giga (CODIGO sempre tem padding).
        const existing = codigoGigaToOriginal.get(originalSku);
        if (!existing) {
          // Primeira ocorrÃªncia: mapeia 1:1 (sku original â†’ codigoGiga)
          codigoGigaToOriginal.set(codigoGiga, originalSku);
        } else {
          // JÃ¡ tem um codigoGiga mapeado pra esse original.
          // DecisÃ£o: se o NOVO codigoGiga Ã© mais longo (mais padding),
          // troca; senÃ£o mantÃ©m o anterior.
          const previous = Array.from(codigoGigaToOriginal.entries()).find(
            ([, orig]) => orig === originalSku,
          )?.[0];
          if (previous && codigoGiga.length > previous.length) {
            codigoGigaToOriginal.delete(previous);
            codigoGigaToOriginal.set(codigoGiga, originalSku);
          }
        }
      }
    } catch (e) {
      this.logger.warn(
        `getStock: lookup em produtos falhou, caindo no modo legado (sujeito a colisÃ£o): ${(e as Error).message}`,
      );
      // Fallback degradado: usa todas variantes (comportamento antigo).
      // Pelo menos a chamada nÃ£o morre â€” operaÃ§Ã£o continua, ainda que
      // possa rotear errado em casos de colisÃ£o.
      for (const v of allVariants) {
        const original = variantToOriginal.get(v);
        if (original) codigoGigaToOriginal.set(v, original);
      }
    }

    if (!codigoGigaToOriginal.size) {
      // Nenhum SKU foi achado no cadastro â†’ nÃ£o tem estoque pra rotear
      return [];
    }

    // PASSO 2 â€” Estoque dos CODIGOs reais resolvidos.
    //
    // BUG anterior: buscava sÃ³ pelo CODIGO literal encontrado em `produtos`.
    // Mas a tabela `estoque` pode armazenar o MESMO produto com padding de
    // zeros DIFERENTE (ex: produtos="5383641", estoque="00005383641"). Como o
    // IN da query Ã© literal, perdia essas linhas â†’ routing dizia ruptura
    // mesmo com 1 un fÃ­sico real (caso real do pedido WC #191547 da Lurd's).
    //
    // SoluÃ§Ã£o: pra cada codigoGiga resolvido em produtos, expandir TODAS as
    // variantes de padding e procurar em estoque pelo set inteiro. MantÃ©m o
    // mapeamento variant â†’ originalSku pra agregar de volta corretamente.
    const codigosVariants: string[] = [];
    const codigoVariantToOriginal = new Map<string, string>();
    for (const [codigoGiga, originalSku] of codigoGigaToOriginal.entries()) {
      for (const v of this.skuVariants(codigoGiga)) {
        codigosVariants.push(v);
        if (!codigoVariantToOriginal.has(v)) {
          codigoVariantToOriginal.set(v, originalSku);
        }
      }
    }
    if (codigosVariants.length === 0) return [];

    // estoque.LOJA é char(2) ZERO-PADDED no Giga ("01","06","10"). Se o code da
    // loja no FlowOps vier sem o zero ("1","6"), o `LOJA IN (...)` NÃO casa e dá
    // ruptura mesmo com estoque físico. Expandimos cada storeCode pras 2 formas
    // (com e sem zero) e guardamos um mapa LOJA→codeOriginal pra devolver o
    // storeCode no formato que o caller (routing) espera.
    const lojaVariants: string[] = [];
    const lojaToStoreCode = new Map<string, string>();
    for (const sc of storeCodes) {
      const s = String(sc ?? '').trim();
      if (!s) continue;
      if (!lojaToStoreCode.has(s)) { lojaVariants.push(s); lojaToStoreCode.set(s, s); }
      if (/^\d{1,2}$/.test(s)) {
        const padded = s.padStart(2, '0');
        if (!lojaToStoreCode.has(padded)) { lojaVariants.push(padded); lojaToStoreCode.set(padded, s); }
        const stripped = s.replace(/^0+/, '') || s;
        if (!lojaToStoreCode.has(stripped)) { lojaVariants.push(stripped); lojaToStoreCode.set(stripped, s); }
      }
    }

    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO AS sku,
                LOJA   AS storeCode,
                ESTOQUE AS availableQty
           FROM estoque
          WHERE CODIGO IN (?)
            AND LOJA IN (?)
            AND ESTOQUE > 0`,
        [codigosVariants, lojaVariants],
      );
      // Agrega por (originalSku, storeCode). MÃºltiplas variantes de padding
      // podem casar â€” somamos tudo, mas logamos pra detectar caso patolÃ³gico.
      const agg = new Map<string, number>();
      for (const r of rows as any[]) {
        const codigoEstoque = String(r.sku).trim();
        const lojaEstoque = String(r.storeCode).trim();
        // Devolve no formato do code do FlowOps (mapeia "06"→"6" se for o caso).
        const storeCode = lojaToStoreCode.get(lojaEstoque) ?? lojaEstoque;
        const originalSku = codigoVariantToOriginal.get(codigoEstoque);
        if (!originalSku) continue;
        const key = `${storeCode}::${originalSku}`;
        agg.set(key, (agg.get(key) || 0) + (Number(r.availableQty) || 0));
      }
      const out: StockEntry[] = [];
      for (const [key, qty] of agg.entries()) {
        const [storeCode, originalSku] = key.split('::');
        out.push({ storeCode, sku: originalSku, availableQty: qty });
      }
      return out;
    } catch (e) {
      this.logger.error(`Falha ao consultar estoque ERP: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Lista REFs Ãºnicas cadastradas no intervalo de datas (formato YYYY-MM-DD),
   * filtrando opcionalmente por substring na descriÃ§Ã£o.
   *
   * Uso: "puxa REFs PLUS SIZE cadastradas em janeiro/2026" â†’ vendedora insere
   * no buscador de realinhamento.
   *
   * Detecta automaticamente a coluna de data cadastro. Se nenhuma existir,
   * retorna [] e loga o problema.
   *
   * Retorna atÃ© 500 REFs distintas com descriÃ§Ã£o + contagem de variaÃ§Ãµes.
   *
   * NOTA: usa strings YYYY-MM-DD direto (nÃ£o Date object) pra evitar
   * confusÃ£o de timezone â€” driver mysql2 Ã s vezes converte Date pra
   * timestamp UTC e a coluna do Giga geralmente tÃ¡ em horÃ¡rio local.
   */
  async searchRefsByDateRange(input: {
    inicio: string; // YYYY-MM-DD
    fim: string;    // YYYY-MM-DD (exclusive â€” passe o dia SEGUINTE ao Ãºltimo dia desejado)
    descricaoContains?: string;
  }): Promise<Array<{ ref: string; descricao: string; variantCount: number; dataCadastro: string | null }>> {
    if (!this.pool) return [];

    const candidatas = [
      'DATAALT', 'DATA_ALT', 'DT_ALT', 'DATAALTERACAO', 'DATA_ALTERACAO',
      'DATACADASTRO', 'DATA_CADASTRO', 'DT_CADASTRO',
      'DATACRIACAO', 'DT_CRIACAO',
      'DATA_INC', 'DATAINC', 'DT_INC', 'DATA_INCLUSAO', 'DATAINCLUSAO', 'DT_INCLUSAO',
      'DATA_ENT', 'DATAENT', 'DT_ENT', 'DATA_ENTRADA', 'DATAENTRADA', 'DT_ENTRADA',
      'CREATED_AT', 'CRIADO_EM', 'DATA',
    ];
    const dataCol = await this.pickCol(candidatas);
    if (!dataCol) {
      this.logger.warn(
        `[erp] searchRefsByDateRange: nenhuma coluna de data detectada. Tentei: ${candidatas.join(', ')}`,
      );
      return [];
    }

    const conds: string[] = [
      `\`${dataCol}\` >= ?`,
      `\`${dataCol}\` <  ?`,
      `REF IS NOT NULL`,
      `REF <> ''`,
    ];
    const vals: any[] = [input.inicio, input.fim];

    if (input.descricaoContains?.trim()) {
      conds.push('UPPER(DESCRICAOCOMPLETA) LIKE ?');
      vals.push(`%${input.descricaoContains.trim().toUpperCase()}%`);
    }

    try {
      const sql = `
        SELECT REF                            AS ref,
               MAX(DESCRICAOCOMPLETA)         AS descricao,
               MAX(\`${dataCol}\`)            AS dataCadastro,
               COUNT(*)                       AS variantCount
          FROM produtos
         WHERE ${conds.join(' AND ')}
         GROUP BY REF
         ORDER BY MAX(\`${dataCol}\`) DESC
         LIMIT 500
      `;
      this.logger.log(`[erp] searchRefsByDateRange col=${dataCol} from=${input.inicio} to=${input.fim} desc=${input.descricaoContains || '(none)'}`);
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, vals);
      this.logger.log(`[erp] searchRefsByDateRange retornou ${rows.length} REF(s)`);
      return (rows as any[]).map((r) => ({
        ref: String(r.ref).trim(),
        descricao: String(r.descricao || '').trim(),
        variantCount: Number(r.variantCount) || 0,
        dataCadastro: r.dataCadastro ? String(r.dataCadastro) : null,
      }));
    } catch (e) {
      this.logger.error(`searchRefsByDateRange falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * BUSCA REFs com SOBRA DE ESTOQUE â€” quaisquer SKUs (cor Ã— tamanho) que
   * tenham >= minQty unidades em estoque. Ãštil pra encontrar candidatas a
   * realinhamento (ex.: "todas as blusas manga curta plus size com 2+ por SKU").
   *
   * DiferenÃ§a pra getParados: aqui nÃ£o filtra por "sem venda hÃ¡ X dias",
   * sÃ³ pelo critÃ©rio bruto de sobra >= minQty POR SKU. Filtro de descriÃ§Ã£o
   * permite restringir tipo (BLUSA, CALÃ‡A, etc).
   */
  async searchRefsComSobraPorSku(input: {
    minQty?: number;
    descricaoContains?: string;
    plusSizeOnly?: boolean;
    storeCode?: string | null;
    limit?: number;
  }): Promise<Array<{
    ref: string;
    descricao: string;
    variantesComSobra: number;
    estoqueTotalSobra: number;
    skuExemplo: string | null;
  }>> {
    if (!this.pool) return [];
    const minQty = Math.max(1, Math.min(100, input.minQty || 2));
    const limit = Math.max(1, Math.min(2000, input.limit || 500));

    const conds: string[] = [
      'e.ESTOQUE >= ?',
      'p.REF IS NOT NULL',
      "TRIM(p.REF) <> ''",
    ];
    const vals: any[] = [minQty];

    // LOJA: comparaÃ§Ã£o robusta â€” Giga pode ter LOJA como INT (1) ou STRING
    // com zero Ã  esquerda ('01'). Normaliza ambos os lados.
    if (input.storeCode) {
      const lojaNum = parseInt(input.storeCode, 10);
      const lojaStr = String(input.storeCode).trim();
      const lojaPadded = lojaStr.padStart(2, '0');
      conds.push(
        `(CAST(e.LOJA AS UNSIGNED) = ? OR TRIM(e.LOJA) = ? OR TRIM(e.LOJA) = ?)`,
      );
      vals.push(lojaNum, lojaStr, lojaPadded);
    }
    // PLUS SIZE: busca em DESCRICAOCOMPLETA OU DESCRICAOPDV (alguns produtos
    // sÃ³ tÃªm uma das duas preenchida). Aceita variaÃ§Ãµes de grafia.
    if (input.plusSizeOnly) {
      conds.push(`(
        UPPER(COALESCE(p.DESCRICAOCOMPLETA, '')) REGEXP 'PLUS[ -]?SIZE|PLUSSIZE'
        OR UPPER(COALESCE(p.DESCRICAOPDV, '')) REGEXP 'PLUS[ -]?SIZE|PLUSSIZE'
        OR UPPER(COALESCE(p.GRUPO, '')) LIKE '%PLUS%'
      )`);
    }
    if (input.descricaoContains?.trim()) {
      // Cada palavra do filtro pode aparecer em qualquer ordem (AND entre palavras)
      const palavras = input.descricaoContains.trim().toUpperCase().split(/\s+/).filter(Boolean);
      for (const palavra of palavras) {
        conds.push(`(
          UPPER(COALESCE(p.DESCRICAOCOMPLETA, '')) LIKE ?
          OR UPPER(COALESCE(p.DESCRICAOPDV, '')) LIKE ?
        )`);
        vals.push(`%${palavra}%`, `%${palavra}%`);
      }
    }

    const sql = `
      SELECT TRIM(p.REF)                                          AS ref,
             MAX(COALESCE(p.DESCRICAOCOMPLETA, p.DESCRICAOPDV, '')) AS descricao,
             COUNT(DISTINCT p.CODIGO)                             AS variantesComSobra,
             SUM(e.ESTOQUE)                                       AS estoqueTotalSobra,
             MAX(p.CODIGO)                                        AS skuExemplo
        FROM estoque e
        INNER JOIN produtos p
                ON CAST(p.CODIGO AS UNSIGNED) = CAST(e.CODIGO AS UNSIGNED)
       WHERE ${conds.join(' AND ')}
       GROUP BY TRIM(p.REF)
       ORDER BY estoqueTotalSobra DESC, variantesComSobra DESC
       LIMIT ?
    `;
    vals.push(limit);

    try {
      this.logger.log(
        `[erp] searchRefsComSobraPorSku minQty=${minQty} loja=${input.storeCode || 'all'} ` +
        `plusSize=${!!input.plusSizeOnly} desc=${input.descricaoContains || '(none)'}`,
      );
      this.logger.debug(`[erp] SQL: ${sql.replace(/\s+/g, ' ').trim()}`);
      this.logger.debug(`[erp] VALS: ${JSON.stringify(vals)}`);
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, vals);
      this.logger.log(`[erp] searchRefsComSobraPorSku retornou ${rows.length} REF(s)`);
      return (rows as any[]).map((r) => ({
        ref: String(r.ref).trim(),
        descricao: String(r.descricao || '').trim(),
        variantesComSobra: Number(r.variantesComSobra) || 0,
        estoqueTotalSobra: Number(r.estoqueTotalSobra) || 0,
        skuExemplo: r.skuExemplo ? String(r.skuExemplo).trim() : null,
      }));
    } catch (e) {
      this.logger.error(`searchRefsComSobraPorSku falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * SNAPSHOT do catálogo agregado por REFERÊNCIA (modelo) — usado pela tela
   * "Classificação de Produtos" (Cadastros). Uma única query GROUP BY REF sobre
   * `produtos`; o caller cacheia o resultado (é tela de retaguarda, não precisa
   * ser ao vivo a cada tecla). NÃO toca em estoque nem em nada existente.
   *
   * Uma REF é considerada plus-size se QUALQUER SKU dela tiver PLUS_SIZE in (1,2).
   * categoria = NOMEGRUPO (o "grupo" que a loja trata como categoria).
   */
  async getRefCatalogSnapshot(): Promise<Array<{
    ref: string;
    descricao: string;
    busca: string;
    marca: string;
    fornecedor: string;
    categoria: string;
    plusSize: boolean;
  }>> {
    if (!this.pool) return [];
    // Produtos COM ref: agrupados por REFERÊNCIA (modelo).
    // Produtos SEM ref: entram individualmente pelo CÓDIGO, com chave
    // sintética "#<codigo>" — assim meias/acessórios sem REF aparecem na tela
    // de classificação e podem ser excluídos de promoção. O prefixo "#" evita
    // colisão com REFs reais numéricas (ex.: REF "611" ≠ CÓDIGO 611).
    //
    // `busca` = TODAS as descrições da REF concatenadas (GROUP_CONCAT).
    // BUG corrigido: com só MAX(descricao), a pesquisa enxergava UMA variação
    // da REF — produto novo na mesma REF (ex.: "2319 KASUAL") sumia da busca
    // quando a descrição agregada era a de OUTRO item da REF.
    const sql = `
      SELECT TRIM(UPPER(p.REF))                                   AS ref,
             MAX(COALESCE(p.DESCRICAOCOMPLETA, p.DESCRICAOPDV, '')) AS descricao,
             SUBSTRING(GROUP_CONCAT(DISTINCT UPPER(COALESCE(p.DESCRICAOCOMPLETA, p.DESCRICAOPDV, '')) SEPARATOR ' '), 1, 8000) AS busca,
             MAX(COALESCE(p.MARCA, ''))                           AS marca,
             MAX(COALESCE(p.FORNECEDOR, ''))                      AS fornecedor,
             MAX(COALESCE(p.NOMEGRUPO, ''))                       AS categoria,
             MAX(CASE WHEN p.PLUS_SIZE IN (1, 2) THEN 1 ELSE 0 END) AS plus_size
        FROM produtos p
       WHERE p.REF IS NOT NULL
         AND TRIM(p.REF) <> ''
       GROUP BY TRIM(UPPER(p.REF))

      UNION ALL

      SELECT CONCAT('#', p.CODIGO)                                AS ref,
             COALESCE(p.DESCRICAOCOMPLETA, p.DESCRICAOPDV, '')    AS descricao,
             UPPER(COALESCE(p.DESCRICAOCOMPLETA, p.DESCRICAOPDV, '')) AS busca,
             COALESCE(p.MARCA, '')                                AS marca,
             COALESCE(p.FORNECEDOR, '')                           AS fornecedor,
             COALESCE(p.NOMEGRUPO, '')                            AS categoria,
             CASE WHEN p.PLUS_SIZE IN (1, 2) THEN 1 ELSE 0 END    AS plus_size
        FROM produtos p
       WHERE (p.REF IS NULL OR TRIM(p.REF) = '')
         AND p.CODIGO IS NOT NULL
         AND TRIM(p.CODIGO) <> ''
       LIMIT 400000
    `;
    let conn: mysql.PoolConnection | null = null;
    try {
      const t0 = Date.now();
      // GROUP_CONCAT trunca no default de 1024 bytes — REF com muitas
      // variações perderia descrições. Sobe o limite NA MESMA conexão.
      conn = await this.pool.getConnection();
      await conn.query('SET SESSION group_concat_max_len = 65535');
      const [rows] = await conn.query<mysql.RowDataPacket[]>({ sql, timeout: 120_000 });
      this.logger.log(
        `[erp] getRefCatalogSnapshot: ${(rows as any[]).length} REF(s) em ${Date.now() - t0}ms`,
      );
      // produtos.FORNECEDOR guarda o CNPJ — traduz pro NOME em memória
      // (JOIN no SQL quebrava: collation/charset misto nas tabelas legadas).
      const fornNome = new Map<string, string>();
      try {
        const [fs] = await conn.query<mysql.RowDataPacket[]>({
          sql: 'SELECT CNPJ, FANTASIA, RAZAOSOCIAL FROM fornecedores',
          timeout: 15_000,
        });
        for (const f of fs as any[]) {
          const cnpj = String(f.CNPJ || '').trim();
          const nome = String(f.FANTASIA || '').trim() || String(f.RAZAOSOCIAL || '').trim();
          if (cnpj && nome) fornNome.set(cnpj, nome);
        }
      } catch (e) {
        this.logger.warn(`[erp] snapshot: mapa de fornecedores falhou (${(e as Error).message}) — mantendo CNPJ cru`);
      }
      return (rows as any[]).map((r) => {
        const fornRaw = String(r.fornecedor || '').trim();
        return {
          ref: String(r.ref || '').trim(),
          descricao: String(r.descricao || '').trim(),
          busca: String(r.busca || '').trim(),
          marca: String(r.marca || '').trim(),
          fornecedor: fornNome.get(fornRaw) || fornRaw,
          categoria: String(r.categoria || '').trim(),
          plusSize: Number(r.plus_size) === 1,
        };
      });
    } catch (e) {
      this.logger.error(`getRefCatalogSnapshot falhou: ${(e as Error).message}`);
      throw e;
    } finally {
      try { conn?.release(); } catch { /* já liberada */ }
    }
  }

  /**
   * DIAGNÓSTICO da tela de classificação: linhas CRUAS de `produtos` que
   * batem com o termo (REF ou descrições), com HEX(REF) pra enxergar
   * caractere invisível que TRIM não remove (tab, quebra, NBSP...).
   */
  async debugProdutosByTerm(term: string): Promise<any[]> {
    if (!this.pool) return [];
    const t = `%${String(term || '').trim()}%`;
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>({
      sql: `SELECT CODIGO, REF, HEX(REF) AS ref_hex, LENGTH(REF) AS ref_len,
                   DESCRICAOPDV, DESCRICAOCOMPLETA, PLUS_SIZE, DATAALT
              FROM produtos
             WHERE REF LIKE ? OR DESCRICAOPDV LIKE ? OR DESCRICAOCOMPLETA LIKE ?
             LIMIT 30`,
      values: [t, t, t],
      timeout: 60_000,
    });
    return rows as any[];
  }

  /**
   * DIAGNÃ“STICO de searchRefsByDateRange â€” usado pra debugar quando "0 resultados".
   * Retorna:
   *   - qual coluna de data foi detectada
   *   - todas as colunas DATE/DATETIME existentes na tabela produtos
   *   - contagens em diferentes cenÃ¡rios (com/sem filtro de data, com/sem PLUS SIZE)
   *   - sample de DESCRICAOCOMPLETA pra ver o formato real
   *   - min/max da coluna de data (pra ver se tem dado nesse range)
   */
  async diagnoseRefsByDate(input: {
    inicio: string;
    fim: string;
    descricaoContains?: string;
  }): Promise<any> {
    if (!this.pool) return { error: 'pool nÃ£o inicializado' };

    const candidatas = [
      'DATAALT', 'DATA_ALT', 'DT_ALT', 'DATAALTERACAO', 'DATA_ALTERACAO',
      'DATACADASTRO', 'DATA_CADASTRO', 'DT_CADASTRO',
      'DATACRIACAO', 'DT_CRIACAO',
      'DATA_INC', 'DATAINC', 'DT_INC', 'DATA_INCLUSAO', 'DATAINCLUSAO', 'DT_INCLUSAO',
      'DATA_ENT', 'DATAENT', 'DT_ENT', 'DATA_ENTRADA', 'DATAENTRADA', 'DT_ENTRADA',
      'CREATED_AT', 'CRIADO_EM', 'DATA',
    ];
    const dataCol = await this.pickCol(candidatas);

    // Lista TODAS as colunas da tabela produtos pra ele ver
    const cols = await this.getProductsColumns();
    const colsList = Array.from(cols).sort();
    const dateCols = colsList.filter((c) => /DATA|DT|TIME|CREATED|UPDATED|INC/i.test(c));

    const result: any = {
      colunaDataDetectada: dataCol,
      colunasComDataNoNome: dateCols,
      todasAsColunasProdutos: colsList,
      candidatasTentadas: candidatas,
      filtros: {
        inicio: input.inicio,
        fim: input.fim,
        descricao: input.descricaoContains,
      },
    };

    if (!dataCol) {
      result.problema = 'Nenhuma coluna de data foi detectada. Veja "colunasComDataNoNome" pra ver opÃ§Ãµes.';
      return result;
    }

    try {
      // Range total da coluna
      const [minMaxRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT MIN(\`${dataCol}\`) AS minDate, MAX(\`${dataCol}\`) AS maxDate, COUNT(*) AS total FROM produtos WHERE \`${dataCol}\` IS NOT NULL`,
      );
      result.colunaStats = {
        minDate: minMaxRows[0]?.minDate ? String(minMaxRows[0].minDate) : null,
        maxDate: minMaxRows[0]?.maxDate ? String(minMaxRows[0].maxDate) : null,
        totalComData: Number(minMaxRows[0]?.total) || 0,
      };

      // Total no range (sem filtro descriÃ§Ã£o)
      const [rangeRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(DISTINCT REF) AS uniqueRefs, COUNT(*) AS totalRows
           FROM produtos
          WHERE \`${dataCol}\` >= ? AND \`${dataCol}\` < ? AND REF IS NOT NULL AND REF <> ''`,
        [input.inicio, input.fim],
      );
      result.semFiltroDescricao = {
        uniqueRefs: Number(rangeRows[0]?.uniqueRefs) || 0,
        totalRows: Number(rangeRows[0]?.totalRows) || 0,
      };

      // Total no range COM filtro descriÃ§Ã£o
      if (input.descricaoContains?.trim()) {
        const [filterRows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT COUNT(DISTINCT REF) AS uniqueRefs, COUNT(*) AS totalRows
             FROM produtos
            WHERE \`${dataCol}\` >= ? AND \`${dataCol}\` < ?
              AND REF IS NOT NULL AND REF <> ''
              AND UPPER(DESCRICAOCOMPLETA) LIKE ?`,
          [input.inicio, input.fim, `%${input.descricaoContains.trim().toUpperCase()}%`],
        );
        result.comFiltroDescricao = {
          uniqueRefs: Number(filterRows[0]?.uniqueRefs) || 0,
          totalRows: Number(filterRows[0]?.totalRows) || 0,
        };

        // Quantos produtos TEM essa descriÃ§Ã£o no banco inteiro (sem filtro de data)
        const [descCountRows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT COUNT(*) AS total FROM produtos WHERE UPPER(DESCRICAOCOMPLETA) LIKE ?`,
          [`%${input.descricaoContains.trim().toUpperCase()}%`],
        );
        result.descricaoTotalNoBanco = Number(descCountRows[0]?.total) || 0;
      }

      // Sample de 5 produtos no range (descriÃ§Ãµes reais)
      const [sampleRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT REF, DESCRICAOCOMPLETA, \`${dataCol}\` AS dataCadastro
           FROM produtos
          WHERE \`${dataCol}\` >= ? AND \`${dataCol}\` < ? AND REF IS NOT NULL
          LIMIT 10`,
        [input.inicio, input.fim],
      );
      result.sampleNoRange = (sampleRows as any[]).map((r) => ({
        ref: r.REF,
        descricao: r.DESCRICAOCOMPLETA,
        dataCadastro: String(r.dataCadastro),
      }));

      return result;
    } catch (e) {
      result.error = (e as Error).message;
      return result;
    }
  }

  /**
   * Busca preÃ§o cheio por SKU em batch na tabela `produtos` do Giga.
   *
   * Detecta automaticamente qual coluna tem o preÃ§o (VENDAUN, PRECO,
   * PRECOVENDA, PRECO_VENDA â€” varia entre instalaÃ§Ãµes Giga).
   *
   * Usado pelo realinhamento pra capturar o snapshot do preÃ§o no momento
   * da transferÃªncia (mesma lÃ³gica do `seedAndApply` em #194).
   *
   * Retorna Map<sku, preco>. SKUs sem preÃ§o (ou sem coluna de preÃ§o
   * detectada) NÃƒO aparecem no map â†’ caller deve tratar como 0.
   */
  async getProductPricesBySkus(skus: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!skus.length || !this.pool) return out;

    // Descobre qual coluna tem o preÃ§o (cache no mÃ©todo pickCol).
    // ORDEM CORRIGIDA: campos de preÃ§o de venda EXPLICITO vem primeiro.
    // VENDAUN ficava em primeiro mas em alguns Gigas eh custo/medio, nao venda
    // â€” gerava obrigacoes intercompany com R$ 0,80 por peca (errado).
    // Override por env GIGA_PRECO_COL pra forcar coluna especifica.
    const envCol = (process.env.GIGA_PRECO_COL || '').trim().toUpperCase();
    const candidatas = envCol
      ? [envCol]
      : ['PRECOVENDA', 'PRECO_VENDA', 'PRECO', 'VENDA', 'VENDAUN'];
    const precoCol = await this.pickCol(candidatas);
    if (!precoCol) {
      this.logger.warn(
        '[erp] getProductPricesBySkus: nenhuma coluna de preÃ§o detectada na tabela produtos',
      );
      return out;
    }
    this.logger.log(`[erp] getProductPricesBySkus: usando coluna "${precoCol}" (envOverride=${envCol || 'none'})`);

    // Dedup + limpa SKUs + EXPANDE variantes (zeros Ã  esquerda)
    const unique = Array.from(new Set(skus.map((s) => String(s).trim()).filter(Boolean)));
    if (!unique.length) return out;
    const { allVariants, variantToOriginal } = this.expandSkus(unique);
    if (!allVariants.length) return out;

    try {
      const sql = `
        SELECT CODIGO AS sku, \`${precoCol}\` AS preco
          FROM produtos
         WHERE CODIGO IN (?)
      `;
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, [allVariants]);
      for (const r of rows) {
        const codigoGiga = String(r.sku).trim();
        // Mapeia de volta pro SKU original que o caller passou
        const originalSku = variantToOriginal.get(codigoGiga) || codigoGiga;
        const preco = Number(r.preco);
        if (!Number.isNaN(preco) && preco > 0) {
          // VENDAUN Ã© em centavos â€” divide por 100 (consistente com getPdvProductInfo)
          const precoFinal = (precoCol || '').toUpperCase() === 'VENDAUN' ? preco / 100 : preco;
          // Se jÃ¡ tem o SKU no map, mantÃ©m o maior preÃ§o (defensivo contra duplicatas)
          const existing = out.get(originalSku);
          if (!existing || precoFinal > existing) {
            out.set(originalSku, precoFinal);
          }
        }
      }
      return out;
    } catch (e) {
      this.logger.error(
        `[erp] getProductPricesBySkus falhou: ${(e as Error).message}`,
      );
      return out;
    }
  }

  /**
   * Estoque TOTAL consolidado por SKU (soma de todas as lojas).
   * Retorna um mapa { [sku]: totalQty }.
   * SKUs que nÃ£o existem no ERP nÃ£o aparecem no mapa (nÃ£o ficam 0).
   *
   * Usado pela tela /produtos pra comparar estoque WooCommerce x ERP fÃ­sico.
   */
  async getStockTotalBySkus(skus: string[]): Promise<Record<string, number>> {
    if (!skus.length) return {};
    if (this.mirrorReadsEnabled) {
      try {
        if (await this.mirrorStockReady()) return await this.getStockTotalBySkusFromMirror(skus);
      } catch (e) {
        this.logger.warn(`[mirror-reads] getStockTotalBySkus: ${(e as Error).message} → Giga ao vivo`);
      }
    }
    if (!this.pool) return {};

    // Normaliza: tira duplicados e strings vazias
    const unique = Array.from(new Set(skus.filter((s) => s && s.trim()))).map((s) => s.trim());
    if (!unique.length) return {};

    // Expande variantes de zero-padding (Giga grava "0005383498", outros sistemas
    // podem mandar "5383498"). MantÃ©m map variantToOriginal pra retornar
    // o resultado agrupado pelo SKU original que o caller passou.
    const { allVariants, variantToOriginal } = this.expandSkus(unique);
    if (!allVariants.length) return {};

    // PASSO 1: verifica quais SKUs ORIGINAIS existem no CADASTRO (tabela `produtos`).
    // Produto pode existir em `produtos` mas NÃƒO em `estoque` se ele estÃ¡ zerado
    // em todas as lojas (gigasistemas sÃ³ cria linha em `estoque` quando hÃ¡ movimento).
    // Se confundirmos "sem linha em estoque" com "nÃ£o existe", as 698 variaÃ§Ãµes
    // nÃ£o atualizam pra zero quando deveriam.
    const existsInProducts = new Set<string>();
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        'SELECT CODIGO FROM produtos WHERE CODIGO IN (?)',
        [allVariants],
      );
      for (const r of rows) {
        const codigoGiga = String(r.CODIGO).trim();
        const original = variantToOriginal.get(codigoGiga) || codigoGiga;
        existsInProducts.add(original);
      }
    } catch (e) {
      this.logger.error(`Falha ao verificar cadastro ERP: ${(e as Error).message}`);
      // Em erro, segue pro passo 2 sem distinÃ§Ã£o (comportamento antigo)
    }

    // PASSO 2: busca estoque consolidado dos que tÃªm movimento em pelo menos uma loja.
    // Soma todas as variantes de cada SKU original (caso o Giga tenha as duas formas).
    const stockMap: Record<string, number> = {};
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO AS sku, SUM(ESTOQUE) AS totalQty
           FROM estoque
          WHERE CODIGO IN (?)
          GROUP BY CODIGO`,
        [allVariants],
      );
      for (const r of rows) {
        const codigoGiga = String(r.sku).trim();
        const original = variantToOriginal.get(codigoGiga) || codigoGiga;
        const qty = Number(r.totalQty) || 0;
        stockMap[original] = (stockMap[original] || 0) + qty;
      }
    } catch (e) {
      this.logger.error(`Falha ao consultar estoque total ERP: ${(e as Error).message}`);
      return {};
    }

    // PASSO 3: para cada SKU que EXISTE no cadastro mas NÃƒO tem linha em estoque,
    // assume estoque = 0. Pra SKU que nÃ£o existe no cadastro, omite do mapa
    // (fica como "nÃ£o encontrado" â€” produto descatalogado, nÃ£o mexer no WC).
    const result: Record<string, number> = { ...stockMap };
    for (const sku of existsInProducts) {
      if (!(sku in result)) {
        result[sku] = 0;
      }
    }
    return result;
  }

  /**
   * Estoque por SKU detalhado por loja â€” retorna mapa {[sku]: [{storeCode, qty}, ...]}.
   * Ãštil pra detalhamento por filial na tela de produto.
   */
  async getStockBySkusDetailed(skus: string[]): Promise<Record<string, Array<{ storeCode: string; qty: number }>>> {
    if (!skus.length) return {};
    if (this.mirrorReadsEnabled) {
      try {
        if (await this.mirrorStockReady()) return await this.getStockBySkusDetailedFromMirror(skus);
      } catch (e) {
        this.logger.warn(`[mirror-reads] getStockBySkusDetailed: ${(e as Error).message} → Giga ao vivo`);
      }
    }
    if (!this.pool) return {};
    const unique = Array.from(new Set(skus.filter((s) => s && s.trim()))).map((s) => s.trim());
    if (!unique.length) return {};

    // TolerÃ¢ncia a zeros Ã  esquerda: expande cada SKU pra suas variantes 3-14 dÃ­gitos
    // e mapeia o resultado de volta pro SKU original que o caller passou.
    const { allVariants, variantToOriginal } = this.expandSkus(unique);
    if (!allVariants.length) return {};

    const sql = `
      SELECT CODIGO AS sku,
             LOJA   AS storeCode,
             SUM(ESTOQUE) AS qty
        FROM estoque
       WHERE CODIGO IN (?)
         AND ESTOQUE > 0
       GROUP BY CODIGO, LOJA
       ORDER BY CODIGO, LOJA
    `;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, [allVariants]);
      // Agrega por (sku original, storeCode) somando variantes que apareÃ§am separadas.
      const agg = new Map<string, Map<string, number>>();
      for (const r of rows) {
        const codigoGiga = String(r.sku).trim();
        const original = variantToOriginal.get(codigoGiga) || codigoGiga;
        const storeCode = String(r.storeCode).trim();
        const qty = Number(r.qty) || 0;
        if (qty <= 0) continue;
        if (!agg.has(original)) agg.set(original, new Map());
        const lojaMap = agg.get(original)!;
        lojaMap.set(storeCode, (lojaMap.get(storeCode) || 0) + qty);
      }
      const map: Record<string, Array<{ storeCode: string; qty: number }>> = {};
      for (const [sku, lojaMap] of agg.entries()) {
        map[sku] = Array.from(lojaMap.entries()).map(([storeCode, qty]) => ({ storeCode, qty }));
      }
      return map;
    } catch (e) {
      this.logger.error(`Falha ao consultar estoque detalhado ERP: ${(e as Error).message}`);
      return {};
    }
  }

  /**
   * TRACE: executa getStock passo-a-passo e retorna cada etapa pra debug.
   * Usado pelo endpoint /intelligence/sku-trace/:sku quando routing diz ruptura
   * mas tela /produtos diz que tem estoque â€” identifica em qual passo o estoque
   * "some".
   */
  async traceSkuStock(sku: string, storeCodes: string[]): Promise<{
    input: { sku: string; storeCodes: string[] };
    step1_skuVariants: string[];
    step2_produtosFound: Array<{ codigoGiga: string }>;
    step3_codigoMapping: Array<{ codigoGiga: string; originalSku: string }>;
    step4_codigoVariantsForEstoque: string[];
    step5_estoqueRows: Array<{ codigoEstoque: string; loja: string; qty: number }>;
    step6_finalAggregated: Array<{ storeCode: string; sku: string; qty: number }>;
    rawTable: Array<{ sku: string; storeCode: string; qty: number }>;
    notes: string[];
  }> {
    const notes: string[] = [];
    const cleanSku = String(sku || '').trim();

    // STEP 1 â€” variantes do SKU (paddings)
    const skuVariantsList = this.skuVariants(cleanSku);
    notes.push(`SKU "${cleanSku}" expandido em ${skuVariantsList.length} variante(s)`);

    if (!this.pool) {
      notes.push('âš ï¸ Pool MySQL nÃ£o inicializado');
      return {
        input: { sku: cleanSku, storeCodes },
        step1_skuVariants: skuVariantsList,
        step2_produtosFound: [],
        step3_codigoMapping: [],
        step4_codigoVariantsForEstoque: [],
        step5_estoqueRows: [],
        step6_finalAggregated: [],
        rawTable: [],
        notes,
      };
    }

    // STEP 2 â€” busca em produtos
    const { allVariants, variantToOriginal } = this.expandSkus([cleanSku]);
    let produtosFound: Array<{ codigoGiga: string }> = [];
    try {
      const [prodRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO FROM produtos WHERE CODIGO IN (?)`,
        [allVariants],
      );
      produtosFound = (prodRows as any[]).map((r) => ({ codigoGiga: String(r.CODIGO).trim() }));
      notes.push(`PASSO 1: ${produtosFound.length} produto(s) encontrado(s) em produtos`);
    } catch (e) {
      notes.push(`âš ï¸ Falha PASSO 1 (produtos): ${(e as Error).message}`);
    }

    // STEP 3 â€” mapeamento codigoGiga â†’ originalSku
    const codigoGigaToOriginal = new Map<string, string>();
    for (const p of produtosFound) {
      const original = variantToOriginal.get(p.codigoGiga);
      if (original) codigoGigaToOriginal.set(p.codigoGiga, original);
    }

    // STEP 4 â€” expansÃ£o dos codigosGiga em variantes (NOVO FIX)
    const codigoVariantsForEstoque: string[] = [];
    const codigoVariantToOriginal = new Map<string, string>();
    for (const [codigoGiga, originalSku] of codigoGigaToOriginal.entries()) {
      for (const v of this.skuVariants(codigoGiga)) {
        if (!codigoVariantToOriginal.has(v)) {
          codigoVariantToOriginal.set(v, originalSku);
          codigoVariantsForEstoque.push(v);
        }
      }
    }
    notes.push(`PASSO 2: expandido em ${codigoVariantsForEstoque.length} variantes pra buscar em estoque`);

    // STEP 5 â€” query em estoque
    let estoqueRows: Array<{ codigoEstoque: string; loja: string; qty: number }> = [];
    if (codigoVariantsForEstoque.length > 0 && storeCodes.length > 0) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO AS sku, LOJA AS storeCode, ESTOQUE AS qty
             FROM estoque
            WHERE CODIGO IN (?) AND LOJA IN (?) AND ESTOQUE > 0`,
          [codigoVariantsForEstoque, storeCodes],
        );
        estoqueRows = (rows as any[]).map((r) => ({
          codigoEstoque: String(r.sku).trim(),
          loja: String(r.storeCode).trim(),
          qty: Number(r.qty) || 0,
        }));
        notes.push(`PASSO 3: ${estoqueRows.length} linha(s) em estoque com ESTOQUE>0 nas lojas filtradas`);
      } catch (e) {
        notes.push(`âš ï¸ Falha PASSO 3 (estoque): ${(e as Error).message}`);
      }
    }

    // STEP 6 â€” agregaÃ§Ã£o final
    const agg = new Map<string, number>();
    for (const r of estoqueRows) {
      const original = codigoVariantToOriginal.get(r.codigoEstoque);
      if (!original) continue;
      const key = `${r.loja}::${original}`;
      agg.set(key, (agg.get(key) || 0) + r.qty);
    }
    const finalAggregated = Array.from(agg.entries()).map(([k, qty]) => {
      const [storeCode, sku] = k.split('::');
      return { storeCode, sku, qty };
    });

    // RAW (sem filtros) pra comparaÃ§Ã£o
    const raw = await this.getStockRawBySku(cleanSku);

    return {
      input: { sku: cleanSku, storeCodes },
      step1_skuVariants: skuVariantsList,
      step2_produtosFound: produtosFound,
      step3_codigoMapping: Array.from(codigoGigaToOriginal.entries()).map(([codigoGiga, originalSku]) => ({
        codigoGiga,
        originalSku,
      })),
      step4_codigoVariantsForEstoque: codigoVariantsForEstoque,
      step5_estoqueRows: estoqueRows,
      step6_finalAggregated: finalAggregated,
      rawTable: raw,
      notes,
    };
  }

  /**
   * DIAGNÃ“STICO RAW: busca TODAS as linhas da tabela `estoque` para um SKU,
   * sem filtrar ESTOQUE > 0 e sem agregar. Revela:
   *   - duplicatas (mesma CODIGO+LOJA com linhas mÃºltiplas)
   *   - linhas negativas (devoluÃ§Ãµes pendentes)
   *   - distribuiÃ§Ã£o por loja COMPLETA (inclusive zeros)
   * Usado pra investigar por que routing escolheu uma loja que ERP "diz" nÃ£o ter peÃ§a.
   */
  async getStockRawBySku(sku: string): Promise<Array<{ sku: string; storeCode: string; qty: number }>> {
    if (!sku || !this.pool) return [];
    const variants = this.skuVariants(sku);
    if (!variants.length) return [];
    try {
      // DiagnÃ³stico: mostra TUDO (nÃ£o filtra ESTOQUE>0 e mantÃ©m o CODIGO real
      // do Giga pra ajudar a identificar problemas de zero-padding).
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO AS sku, LOJA AS storeCode, ESTOQUE AS qty
           FROM estoque
          WHERE CODIGO IN (?)
          ORDER BY LOJA, CODIGO`,
        [variants],
      );
      return (rows as any[]).map((r) => ({
        sku: String(r.sku).trim(),
        storeCode: String(r.storeCode).trim(),
        qty: Number(r.qty) || 0,
      }));
    } catch (e) {
      this.logger.error(`getStockRawBySku falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * DiagnÃ³stico: lista colunas da tabela `produtos` do Gigasistemas.
   * Usado pra descobrir qual coluna guarda o EAN13 (cÃ³digo de barras).
   * Retorna tambÃ©m 3 registros de amostra (com TODOS os campos preenchidos)
   * pra facilitar a identificaÃ§Ã£o visual do campo certo.
   */
  async describeProductsTable(): Promise<{
    columns: Array<{ field: string; type: string }>;
    sample: any[];
  }> {
    if (!this.pool) return { columns: [], sample: [] };
    try {
      const [cols] = await this.pool.query<mysql.RowDataPacket[]>(
        'SHOW COLUMNS FROM produtos',
      );
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        'SELECT * FROM produtos LIMIT 3',
      );
      return {
        columns: cols.map((c: any) => ({ field: c.Field, type: c.Type })),
        sample: rows as any[],
      };
    } catch (e) {
      this.logger.error(`describeProductsTable falhou: ${(e as Error).message}`);
      return { columns: [], sample: [] };
    }
  }

  /**
   * DiagnÃ³stico: descreve a tabela `caixa` do Gigasistemas.
   * Tabela `caixa` Ã© o registro linha-a-linha de tudo que passa pelo PDV â€”
   * usada tanto pra proporcionalidade (vendas por loja Ã— Ãºltimos 30d) quanto
   * pra auto-baixa de VENDA CERTA (match SKU+LOJA+DATA).
   *
   * Schema real (confirmado via LURDS ANÃLISES em 21/04/26):
   *   DATA         â€” data da venda
   *   LOJA         â€” cÃ³digo da loja (FK â†’ lojas.CODIGO)
   *   NUMERO       â€” nÃºmero do cupom (DISTINCT = pedido)
   *   CODIGO       â€” SKU do produto
   *   DESCRICAO    â€” nome do produto
   *   QUANTIDADE   â€” qty vendida
   *   VALOR        â€” preÃ§o unitÃ¡rio
   *   VALORTOTAL   â€” total da linha
   *   VENDEDOR     â€” vendedor
   *   MARCADO      â€” se ='SIM' â†’ linha invÃ¡lida (jÃ¡ validada pelo WinCred)
   */
  async describeSalesTable(): Promise<{
    columns: Array<{ field: string; type: string }>;
    sample: any[];
  }> {
    if (!this.pool) return { columns: [], sample: [] };
    try {
      const [cols] = await this.pool.query<mysql.RowDataPacket[]>(
        'SHOW COLUMNS FROM caixa',
      );
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT * FROM caixa
           WHERE (MARCADO IS NULL OR MARCADO <> 'SIM')
           ORDER BY DATA DESC
           LIMIT 3`,
      );
      return {
        columns: cols.map((c: any) => ({ field: c.Field, type: c.Type })),
        sample: rows as any[],
      };
    } catch (e) {
      this.logger.error(`describeSalesTable falhou: ${(e as Error).message}`);
      return { columns: [], sample: [] };
    }
  }

  /**
   * VENDA BRUTA por loja num intervalo de datas (em R$).
   *
   * Soma VALORTOTAL da tabela `caixa` entre [inicio, fim) â€” fim Ã© EXCLUSIVO.
   * Ignora linhas MARCADO='SIM' (estornadas/canceladas no PDV).
   *
   * Usado pra calcular royalties (8%) + marketing (4%) das filiais por mÃªs.
   *
   * Retorna Map<storeCode, vendaBrutaR$>. Lojas sem venda no perÃ­odo NÃƒO
   * aparecem no map (caller deve tratar como 0).
   */
  async getSalesGrossByStores(
    storeCodes: string[],
    inicio: Date,
    fim: Date,
    opts: { throwOnError?: boolean } = {},
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!storeCodes.length) return out;
    if (this.mirrorReadsEnabled) {
      try {
        if ((await this.mirrorCaixaReady()) && (await this.mirrorCaixaCovers(inicio))) {
          return await this.getSalesGrossByStoresFromMirror(storeCodes, inicio, fim);
        }
      } catch (e) {
        this.logger.warn(`[mirror-reads] getSalesGrossByStores: ${(e as Error).message} → Giga ao vivo`);
      }
    }
    if (!this.pool) return out;
    // RETRY: um blip transitório (uma das 2 conexões paralelas da conta corrente
    // cai) não pode zerar a venda. Tenta de novo antes de desistir.
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT c.LOJA AS storeCode,
                  SUM(c.VALORTOTAL) AS bruto
             FROM caixa c
            WHERE c.LOJA IN (?)
              AND c.DATA >= ?
              AND c.DATA <  ?
              AND (c.MARCADO IS NULL OR c.MARCADO <> 'SIM')
            GROUP BY c.LOJA`,
          [storeCodes, inicio, fim],
        );
        out.clear();
        for (const r of rows as any[]) {
          const code = String(r.storeCode).trim();
          const bruto = Number(r.bruto) || 0;
          if (bruto > 0) out.set(code, bruto);
        }
        return out;
      } catch (e) {
        lastErr = e;
        this.logger.error(`getSalesGrossByStores tentativa ${attempt}/2 falhou: ${(e as Error).message}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 600));
      }
    }
    // Esgotou as tentativas. throwOnError = quem chama PRECISA saber que falhou
    // (conta corrente, pra avisar) em vez de tratar 0 como venda real.
    if (opts.throwOnError) throw lastErr;
    return out;
  }

  /**
   * Venda bruta por (LOJA, DIA) — alimenta o ESPELHO `giga_caixa_diario`.
   * Já líquida de MARCADO='SIM'. DATA volta como 'YYYY-MM-DD'. PROPAGA o erro
   * (com retry): o sync precisa saber que falhou pra não zerar o espelho.
   */
  async getSalesGrossDailyByStore(
    from: Date,
    to: Date,
  ): Promise<Array<{ loja: string; data: string; bruto: number }>> {
    if (!this.pool) return [];
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT c.LOJA AS loja,
                  DATE_FORMAT(c.DATA, '%Y-%m-%d') AS data,
                  SUM(c.VALORTOTAL) AS bruto
             FROM caixa c
            WHERE c.DATA >= ? AND c.DATA <= ?
              AND (c.MARCADO IS NULL OR c.MARCADO <> 'SIM')
            GROUP BY c.LOJA, DATE(c.DATA)`,
          [from, to],
        );
        return (rows as any[]).map((r) => ({
          loja: String(r.loja ?? '').trim(),
          data: String(r.data ?? '').trim(),
          bruto: Number(r.bruto) || 0,
        }));
      } catch (e: any) {
        lastErr = e;
        this.logger.warn(`getSalesGrossDailyByStore tentativa ${attempt}/2 falhou: ${(e as Error)?.message || e}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 600));
      }
    }
    throw lastErr;
  }

  /**
   * VENDAS POR LOJA â€” Ãºltimos N dias (default 30), em UNIDADES.
   * Usado pra calcular a proporcionalidade inversa no routing:
   *   loja que vendeu MAIS tem meta de cessÃ£o MENOR.
   *
   * Ignora linhas com MARCADO='SIM' (jÃ¡ liquidadas no WinCred).
   * Retorna sempre todas as lojas que tiveram VENDA no perÃ­odo â€” quem nÃ£o
   * aparece no array Ã© porque nÃ£o vendeu nada (share=0).
   */
  async getSalesByStoreLastDays(
    days: number = 30,
  ): Promise<Array<{ storeCode: string; units: number; orders: number }>> {
    const n = Math.max(1, Math.min(365, Number(days) || 30));
    try {
      if (await this.caixaMovUsable(new Date(Date.now() - n * 86400_000))) {
        return await this.salesByStoreLastDaysFromMirror(n);
      }
    } catch (e) {
      this.logger.warn(`[mirror-reads] getSalesByStoreLastDays: ${(e as Error).message} → Giga ao vivo`);
    }
    if (!this.pool) return [];
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT c.LOJA       AS storeCode,
                SUM(c.QUANTIDADE) AS units,
                COUNT(DISTINCT c.NUMERO) AS orders
           FROM caixa c
          WHERE c.DATA >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            AND (c.MARCADO IS NULL OR c.MARCADO <> 'SIM')
          GROUP BY c.LOJA`,
        [n],
      );
      return (rows as any[]).map((r) => ({
        storeCode: String(r.storeCode).trim(),
        units: Number(r.units) || 0,
        orders: Number(r.orders) || 0,
      }));
    } catch (e) {
      this.logger.error(`getSalesByStoreLastDays falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * AUTO-MATCH VENDA CERTA â€” procura na tabela `caixa` se a peÃ§a enviada
   * pra uma loja destino JÃ foi vendida no PDV de lÃ¡.
   *
   * A engine recebe um array de "candidatos" (cada VENDA CERTA pending tem
   * refCode + cor + tamanho + lojaDestino + dataEnvio). Como a `caixa` indexa
   * pelo CODIGO (SKU) do Gigasistemas e nÃ£o pela REF, faÃ§o JOIN com `produtos`
   * pra resolver REF+COR+TAMANHO â†’ CODIGO.
   *
   * Retorna um mapa `{ [indiceDoCandidato]: { numero, data, codigo, quantidade } }`
   * â€” sÃ³ preenche quando bateu. Se nÃ£o bateu, nÃ£o tem entrada no mapa.
   *
   * Processamento em batch (LOOP de queries pequenas) â€” o volume Ã© baixo
   * (dezenas a centenas de VENDA CERTA pending no mÃ¡ximo), entÃ£o nÃ£o vale
   * a pena montar uma query gigante com UNION.
   */
  async findVendaCertaMatches(
    candidates: Array<{
      lojaDestinoCode: string;
      refCode: string;
      cor: string | null;
      tamanho: string | null;
      dataEnvio: Date;
    }>,
  ): Promise<Record<number, { numero: string; data: Date; codigo: string; quantidade: number }>> {
    if (!this.pool || !candidates.length) return {};

    const out: Record<number, { numero: string; data: Date; codigo: string; quantidade: number }> = {};

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (!c.lojaDestinoCode || !c.refCode) continue;

      // SQL dinÃ¢mico â€” cor/tamanho podem ser null no nosso lado (pedido veio
      // sem variaÃ§Ã£o especificada). Nesse caso nÃ£o filtra por esses campos.
      const conds: string[] = [
        'c.LOJA = ?',
        'p.REF = ?',
        'c.DATA >= ?',
        "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
      ];
      const vals: any[] = [
        c.lojaDestinoCode.trim(),
        c.refCode.trim().toUpperCase(),
        c.dataEnvio,
      ];
      if (c.cor && c.cor.trim()) {
        conds.push('p.COR = ?');
        vals.push(c.cor.trim());
      }
      if (c.tamanho && c.tamanho.trim()) {
        conds.push('p.TAMANHO = ?');
        vals.push(c.tamanho.trim());
      }

      const sql = `
        SELECT c.NUMERO     AS numero,
               c.DATA       AS data,
               c.CODIGO     AS codigo,
               c.QUANTIDADE AS quantidade
          FROM caixa c
          JOIN produtos p ON p.CODIGO = c.CODIGO
         WHERE ${conds.join(' AND ')}
         ORDER BY c.DATA ASC
         LIMIT 1
      `;

      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, vals);
        const row = (rows as any[])[0];
        if (row) {
          out[i] = {
            numero: String(row.numero),
            data: new Date(row.data),
            codigo: String(row.codigo).trim(),
            quantidade: Number(row.quantidade) || 1,
          };
        }
      } catch (e) {
        this.logger.warn(
          `findVendaCertaMatches(#${i}) falhou (loja=${c.lojaDestinoCode} ref=${c.refCode}): ${(e as Error).message}`,
        );
      }
    }

    return out;
  }

  /**
   * Busca produtos no Gigasistemas por uma lista de cÃ³digos que podem estar
   * em QUALQUER campo (CODIGO, EAN13, CODBARRAS, etc). Retorna um mapa
   * codigo-procurado â†’ CODIGO oficial do Gigasistemas.
   *
   * SÃ³ Ã© usada quando algum SKU nÃ£o bateu em getStockTotalBySkus (padrÃ£o),
   * pra evitar query cara no fluxo normal.
   */
  async findCodigosByAny(
    candidates: string[],
    column: string,
  ): Promise<Record<string, string>> {
    if (!candidates.length || !this.pool) return {};
    // Whitelist de colunas pra proteger contra injeÃ§Ã£o â€” expandir conforme schema
    const allowed = new Set([
      'CODIGO',
      'EAN',
      'EAN13',
      'CODBARRAS',
      'CODIGOBARRAS',
      'COD_BARRAS',
      'CODIGO_BARRAS',
      'COD_EAN',
      'REFERENCIA',
      'REF',
    ]);
    if (!allowed.has(column)) {
      throw new Error(`Coluna nÃ£o permitida: ${column}`);
    }
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO, \`${column}\` AS found FROM produtos WHERE \`${column}\` IN (?)`,
        [candidates],
      );
      const map: Record<string, string> = {};
      for (const r of rows as any[]) {
        if (r.found) map[String(r.found)] = String(r.CODIGO);
      }
      return map;
    } catch (e) {
      this.logger.error(
        `findCodigosByAny(${column}) falhou: ${(e as Error).message}`,
      );
      return {};
    }
  }

  /**
   * DIAGNÃ“STICO: busca produtos no ERP por trecho (LIKE) em CODIGO, REF ou DESCRICAOCOMPLETA.
   * Limita a 20 resultados. Retorna os campos relevantes pra entender o match.
   */
  async searchProductsLike(term: string, storeCode?: string): Promise<any[]> {
    if (!this.pool || !term) return [];
    const cleanTerm = String(term).trim();
    const fullLike = `%${cleanTerm}%`;
    // BUSCA MAGICA: divide o termo em palavras (>=2 chars cada) e exige
    // que TODAS apareÃ§am na DESCRICAOCOMPLETA, em qualquer ordem.
    // Ex: "plus blusa size" acha "BLUSA PLUS SIZE", "PLUS SIZE BLUSA", etc.
    // CODIGO/REF continuam com match exato/contains pra busca direta por SKU.
    const words = cleanTerm
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2);
    // REF DE MODELO: termo SÃ“ numÃ©rico de 3-6 dÃ­gitos = vendedora digitou a
    // REF (etiqueta sem cÃ³digo de barras). Fluxo do PDV:
    //   1Âº bipe (>=7 dÃ­g, direto) â†’ 2Âº cÃ³digo manual â†’ 3Âº REF do modelo.
    // Pra REF: match EXATO primeiro â€” retorna a GRADE COMPLETA (tamanhos Ã—
    // cores) daquele modelo, ordenada. Se exato nÃ£o achar (digitaÃ§Ã£o parcial),
    // fallback por PREFIXO. NUNCA contains nem DESCRICAO pra termo numÃ©rico â€”
    // era isso que trazia "referÃªncias nada a ver" no dropdown.
    // QUALQUER tamanho de REF numÃ©rica (3+ dÃ­gitos) â€” existem REFs com mais
    // de 6 dÃ­gitos. Ordem: REF exata â†’ REF prefixo â†’ fallback genÃ©rico
    // (CODIGO/REF/DESCRICAO contains, comportamento antigo, pra nÃ£o quebrar
    // outras telas que buscam cÃ³digo parcial).
    const isNumericRef = /^\d{3,}$/.test(cleanTerm);
    try {
      let products: any[] = [];
      if (isNumericRef) {
        const cols = 'CODIGO, REF, DESCRICAOCOMPLETA, COR, TAMANHO, ID';
        // BUG FIX: antes a busca numérica casava SÓ por REF. Um número que é
        // CODIGO de um produto mas REF de OUTRO trazia só o "outro" e escondia
        // o certo (ex.: 10115 = CODIGO da Calça, mas REF das Meias → vinha a
        // meia, sumia a calça). Agora casa CODIGO exato (com zero-padding,
        // igual resolveSkuInfo) E REF, com o CODIGO vindo PRIMEIRO.
        const codVariants = new Set<string>([cleanTerm]);
        const strip = cleanTerm.replace(/^0+/, '');
        if (strip) codVariants.add(strip);
        for (let len = 3; len <= 14; len++) {
          if (cleanTerm.length < len) codVariants.add(cleanTerm.padStart(len, '0'));
        }
        const codList = Array.from(codVariants);
        const [exactRows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT ${cols}
             FROM produtos
            WHERE CODIGO IN (?) OR TRIM(REF) = ?
            ORDER BY (CASE WHEN CODIGO IN (?) THEN 0 ELSE 1 END), DESCRICAOCOMPLETA, TAMANHO, COR
            LIMIT 80`,
          [codList, cleanTerm, codList],
        );
        products = exactRows as any[];
        if (!products.length) {
          const [prefixRows] = await this.pool.query<mysql.RowDataPacket[]>(
            `SELECT ${cols}
               FROM produtos
              WHERE TRIM(REF) LIKE ?
              ORDER BY REF, TAMANHO, COR
              LIMIT 30`,
            [`${cleanTerm}%`],
          );
          products = prefixRows as any[];
        }
        if (!products.length) {
          // Ãšltimo recurso: LIKE genÃ©rico (igual comportamento antigo)
          const [genericRows] = await this.pool.query<mysql.RowDataPacket[]>(
            `SELECT ${cols}
               FROM produtos
              WHERE CODIGO LIKE ? OR REF LIKE ? OR DESCRICAOCOMPLETA LIKE ?
              LIMIT 20`,
            [fullLike, fullLike, fullLike],
          );
          products = genericRows as any[];
        }
      } else {
        let sql: string;
        let params: any[];
        if (words.length >= 2) {
          // Multi-palavra: AND de LIKE em DESCRICAOCOMPLETA + OR fallback em CODIGO/REF
          const ands = words.map(() => 'DESCRICAOCOMPLETA LIKE ?').join(' AND ');
          sql = `SELECT CODIGO, REF, DESCRICAOCOMPLETA, COR, TAMANHO, ID
                   FROM produtos
                  WHERE (${ands})
                     OR CODIGO LIKE ?
                     OR REF LIKE ?
                  LIMIT 20`;
          params = [...words.map((w) => `%${w}%`), fullLike, fullLike];
        } else {
          // 1 palavra (texto): comportamento anterior â€” LIKE em tudo
          sql = `SELECT CODIGO, REF, DESCRICAOCOMPLETA, COR, TAMANHO, ID
                   FROM produtos
                  WHERE CODIGO LIKE ? OR REF LIKE ? OR DESCRICAOCOMPLETA LIKE ?
                  LIMIT 20`;
          params = [fullLike, fullLike, fullLike];
        }
        const [prodRows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
        products = prodRows as any[];
      }
      if (!products.length) return [];

      // 2) Pra cada CODIGO, soma estoque REAL na tabela `estoque`.
      //    - qtyMyStore: estoque na loja do usuario (vendedora)
      //    - qtyTotal: estoque TOTAL na rede (todas lojas)
      //    Tolerancia a zero-padding via expandSkus.
      const codigos = products.map((p) => String(p.CODIGO).trim()).filter(Boolean);
      const { allVariants, variantToOriginal } = this.expandSkus(codigos);

      const stockByCodigo = new Map<string, { myStore: number; total: number }>();
      if (allVariants.length > 0) {
        const lojaClean = storeCode
          ? String(storeCode).trim().toUpperCase().replace(/^LJ/i, '').padStart(2, '0')
          : null;
        const [stockRows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO, LOJA, SUM(ESTOQUE) AS qty
             FROM estoque
            WHERE CODIGO IN (?) AND ESTOQUE > 0
            GROUP BY CODIGO, LOJA`,
          [allVariants],
        );
        for (const r of stockRows as any[]) {
          const codigoGiga = String(r.CODIGO).trim();
          const original = variantToOriginal.get(codigoGiga) || codigoGiga;
          const loja = String(r.LOJA || '').trim().toUpperCase().replace(/^LJ/i, '').padStart(2, '0');
          const qty = Number(r.qty) || 0;
          const cur = stockByCodigo.get(original) || { myStore: 0, total: 0 };
          cur.total += qty;
          if (lojaClean && loja === lojaClean) cur.myStore += qty;
          stockByCodigo.set(original, cur);
        }
      }

      return products.map((p) => {
        const c = String(p.CODIGO).trim();
        const s = stockByCodigo.get(c) || { myStore: 0, total: 0 };
        return {
          ...p,
          ESTOQUE: s.myStore,   // legado â€” alguns consumers ainda leem ESTOQUE
          qtyMyStore: s.myStore,
          qtyTotal: s.total,
        };
      });
    } catch (e) {
      this.logger.error(`searchProductsLike falhou: ${(e as Error).message}`);
      return [];
    }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Consulta de loja â€” mÃ©todos especÃ­ficos por tipo de busca.
  // Cada mÃ©todo assume uma intenÃ§Ã£o diferente da vendedora, sem o LIMIT
  // agressivo do searchProductsLike (que perdia "vestido azul 48" porque
  // o ERP tem milhares de "vestido azul").
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Busca por REF base. Retorna TODAS as variaÃ§Ãµes de cor/tamanho.
   *
   * O Lurd's tem 3 convenÃ§Ãµes de cor coexistindo no Giga:
   *   1. REF exata (13015 = cor base, geralmente PRETO)
   *   2. Sufixo de letra direto sem separador (13015M = MARINHO, 13015V = VINHO)
   *   3. Sufixo com espaÃ§o + nome cor (VMS-223 PRETO, VMS-223 VERDE)
   *   4. Sufixo com hÃ­fen (alguns cadastros legados: BMM-100-A)
   *
   * EstratÃ©gia: SQL traz tudo que COMEÃ‡A com a REF base (LIKE 'X%'), depois
   * filtramos em JS pelo padrÃ£o de sufixo vÃ¡lido pra excluir falsos positivos
   * (ex: pedir "9002" nÃ£o pode trazer "900271" que Ã© outra REF inteira).
   *
   * PadrÃµes aceitos como variaÃ§Ã£o de cor da mesma REF base:
   *   - exata
   *   - base + " ALGO"          (espaÃ§o + texto)
   *   - base + "-ALGO"          (hÃ­fen + texto)
   *   - base + "LETRA(S)"       (sufixo sÃ³ letras maiÃºsculas/lowercase, sem dÃ­gito)
   * PadrÃµes REJEITADOS (provavelmente outra REF):
   *   - base + dÃ­gito (ex: "9002" + "71" = "900271")
   */
  async searchByRef(ref: string): Promise<any[]> {
    if (!this.pool || !ref) return [];
    const clean = String(ref).trim();
    if (!clean) return [];
    try {
      // Busca tudo que comeÃ§a com a REF base â€” cada cor pode estar com sufixo
      // diferente no Giga. Filtramos os falsos positivos no JS abaixo.
      //
      // âš  Inclui TOTAL_EST (soma estoque consolidado por CODIGO em todas as
      // lojas) â€” usado pra DEDUPLICAR duplicidade no Wincred (mesma REF+COR+TAM
      // cadastrada em 2 CODIGOs por mudanÃ§a de preÃ§o, etc). Sem dedup, o
      // realinhamento gera 2 TransferOrder pra mesma peÃ§a e a baixa Giga
      // pode ir pro CODIGO sem estoque.
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT p.CODIGO, p.REF, p.DESCRICAOCOMPLETA, p.COR, p.TAMANHO, p.ESTOQUE,
                COALESCE((SELECT SUM(e.ESTOQUE) FROM estoque e WHERE e.CODIGO = p.CODIGO), 0) AS TOTAL_EST,
                p.ID
           FROM produtos p
          WHERE p.REF = ? OR p.REF LIKE ?
          ORDER BY p.COR, p.TAMANHO
          LIMIT 1000`,
        [clean, `${clean}%`],
      );
      const all = rows as any[];

      const isVariationOf = (foundRef: string, baseRef: string): boolean => {
        if (!foundRef) return false;
        if (foundRef === baseRef) return true;
        if (!foundRef.startsWith(baseRef)) return false;
        const suffix = foundRef.slice(baseRef.length);
        if (suffix.startsWith(' ') || suffix.startsWith('-')) return true;
        if (/^[A-Za-z]/.test(suffix)) return true;
        return false;
      };

      const filtered = all.filter((r: any) => isVariationOf(String(r.REF || ''), clean));

      // âš  DEDUP por (REF+COR+TAM) â€” escolhe CODIGO com mais TOTAL_EST.
      // Empate â†’ CODIGO numericamente maior (cadastro mais novo).
      const norm = (s: any) => String(s ?? '').trim().toUpperCase();
      const byKey = new Map<string, any>();
      for (const r of filtered) {
        const k = `${norm(r.REF)}|${norm(r.COR)}|${norm(r.TAMANHO)}`;
        const cur = byKey.get(k);
        const totalEst = Number(r.TOTAL_EST) || 0;
        const codigoNum = Number(r.CODIGO) || 0;
        if (!cur) {
          byKey.set(k, r);
          continue;
        }
        const curTotal = Number(cur.TOTAL_EST) || 0;
        const curCod = Number(cur.CODIGO) || 0;
        if (totalEst > curTotal || (totalEst === curTotal && codigoNum > curCod)) {
          byKey.set(k, r);
        }
      }
      const deduped = Array.from(byKey.values());
      this.logger.log(
        `[erp] searchByRef("${clean}"): SQL ${all.length} â†’ filtrado ${filtered.length} â†’ dedup ${deduped.length} variaÃ§Ãµes${
          filtered.length !== deduped.length ? ` (DUPLICIDADE Wincred: ${filtered.length - deduped.length} CODIGOs descartados)` : ''
        }.`,
      );
      return deduped;
    } catch (e) {
      this.logger.error(`searchByRef falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Busca por SKU ou EAN (cÃ³digo da etiqueta). PRIMEIRO acha UMA linha que bate,
   * pega a REF dela, e DEPOIS retorna TODAS as variaÃ§Ãµes dessa REF â€” pra vendedora
   * ver os outros tamanhos/cores sem precisar buscar de novo.
   */
  async searchByCodeAndExpandRef(code: string): Promise<any[]> {
    if (!this.pool || !code) return [];
    const clean = String(code).trim();
    try {
      // FIX zeros Ã  esquerda: gera TODAS as variaÃ§Ãµes de padding (3 a 14
      // dÃ­gitos). Vendedora bipa "05344710" e Giga tem "5344710" â€” sem
      // skuVariants o lookup falha. skuVariants jÃ¡ cobre todos os paddings
      // intermediÃ¡rios que aparecem em diferentes pontos do Wincred.
      const variants = this.skuVariants(clean);
      const placeholders = variants.map(() => '?').join(',');

      // 1) Tenta achar em CODIGO direto (SKU bipado) â€” testa todas variaÃ§Ãµes
      let [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT REF FROM produtos WHERE CODIGO IN (${placeholders}) LIMIT 1`,
        variants,
      );
      let ref: string | null = (rows as any[])[0]?.REF ?? null;

      // 2) Se nÃ£o achou, tenta colunas de EAN/cÃ³digo de barras
      if (!ref && /^\d{6,}$/.test(clean)) {
        const eanCols = ['EAN13', 'EAN', 'CODBARRAS', 'CODIGOBARRAS', 'COD_BARRAS', 'CODIGO_BARRAS'];
        for (const col of eanCols) {
          try {
            const [r] = await this.pool.query<mysql.RowDataPacket[]>(
              `SELECT REF FROM produtos WHERE \`${col}\` IN (${placeholders}) LIMIT 1`,
              variants,
            );
            const found = (r as any[])[0]?.REF;
            if (found) { ref = String(found); break; }
          } catch {
            // coluna nÃ£o existe nesse schema â€” ignora
          }
        }
      }

      if (!ref) return [];

      // 3) Agora retorna TUDO da REF
      return this.searchByRef(ref);
    } catch (e) {
      this.logger.error(`searchByCodeAndExpandRef falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Busca por descriÃ§Ã£o. Aqui o volume Ã© grande â€” "vestido" pode retornar
   * milhares de linhas. EstratÃ©gia:
   *  - Quebra o termo em PALAVRAS (cada uma vira um LIKE que precisa bater â€” AND).
   *    Ex: "vestido azul 48" â†’ WHERE DESCRICAOCOMPLETA LIKE '%vestido%' AND ... '%azul%' AND ... '%48%'
   *  - Agrupa por REF (DISTINCT) e traz uma amostra da descriÃ§Ã£o.
   *  - Limite generoso (200 REFs) porque sÃ£o sÃ³ REFs Ãºnicas, nÃ£o linhas.
   */
  /**
   * Busca CODIGO por DESCRIÃ‡ÃƒO + COR + TAMANHO, priorizando o que tem estoque.
   * Usado pela reconciliaÃ§Ã£o de remessa quando o lookup REF+COR+TAM falha
   * (REF cadastrada com grafia diferente, zeros Ã  esquerda, etc).
   *
   * EstratÃ©gia: quebra a descriÃ§Ã£o em palavras (AND LIKE), filtra por cor
   * e tamanho exatos, ordena por estoque DESC. Retorna atÃ© 5 candidatos.
   */
  async searchByDescriptionPlusCorTam(
    descricao: string,
    cor: string | null,
    tamanho: string | null,
  ): Promise<Array<{ CODIGO: string; REF: string; COR: string; TAMANHO: string; DESCRICAOCOMPLETA: string; TOTAL_EST: number }>> {
    if (!this.pool || !descricao) return [];
    const palavras = String(descricao).trim().split(/\s+/).filter((p) => p.length > 1);
    if (palavras.length === 0) return [];

    const likeConds = palavras.map(() => 'UPPER(p.DESCRICAOCOMPLETA) LIKE UPPER(?)').join(' AND ');
    const corNorm = (cor || '').trim();
    const tamNorm = (tamanho || '').trim();

    try {
      const sql = `
        SELECT p.CODIGO, p.REF, COALESCE(p.COR,'') AS COR,
               COALESCE(p.TAMANHO,'') AS TAMANHO, p.DESCRICAOCOMPLETA,
               COALESCE((SELECT SUM(e.ESTOQUE) FROM estoque e WHERE e.CODIGO = p.CODIGO), 0) AS TOTAL_EST
          FROM produtos p
          WHERE ${likeConds}
            ${corNorm ? "AND TRIM(UPPER(COALESCE(p.COR,''))) = TRIM(UPPER(?))" : ''}
            ${tamNorm ? "AND TRIM(UPPER(COALESCE(p.TAMANHO,''))) = TRIM(UPPER(?))" : ''}
          ORDER BY TOTAL_EST DESC, p.CODIGO DESC
          LIMIT 5
      `;
      const params: string[] = palavras.map((p) => `%${p}%`);
      if (corNorm) params.push(corNorm);
      if (tamNorm) params.push(tamNorm);

      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      return (rows as any[]).map((r) => ({
        CODIGO: String(r.CODIGO).trim(),
        REF: String(r.REF || '').trim(),
        COR: String(r.COR || '').trim(),
        TAMANHO: String(r.TAMANHO || '').trim(),
        DESCRICAOCOMPLETA: String(r.DESCRICAOCOMPLETA || '').trim(),
        TOTAL_EST: Number(r.TOTAL_EST) || 0,
      }));
    } catch (e) {
      this.logger.warn(`searchByDescriptionPlusCorTam falhou: ${(e as Error).message}`);
      return [];
    }
  }

  async searchByDescriptionGrouped(
    term: string,
  ): Promise<Array<{ REF: string; DESCRICAOCOMPLETA: string; VARIANT_COUNT: number }>> {
    if (!this.pool || !term) return [];
    const trimmed = String(term).trim();
    if (!trimmed) return [];

    // â”€â”€â”€ DetecÃ§Ã£o de REF: quando o termo Ã© uma Ãºnica palavra "REF-like" â”€â”€â”€
    // (sÃ³ dÃ­gitos ex: "9002", ou padrÃ£o com hÃ­fen ex: "VMS-223"), busca
    // EXATA pela coluna REF. Isso evita "9002" trazer "900246", "900201"
    // (que contÃªm "9002" mas sÃ£o REFs totalmente diferentes).
    const isRefLike = /^[A-Z0-9]+(-[A-Z0-9]+)*$/i.test(trimmed) && !trimmed.includes(' ');
    if (isRefLike) {
      try {
        // Pega TODAS as variaÃ§Ãµes da REF (sem GROUP BY) e agrupa por "famÃ­lia"
        // em JS. FamÃ­lia = 1Âª palavra significativa (>=4 chars, nÃ£o stopword).
        // Isso resolve o caso de REF ambÃ­gua (mesma REF 8011 pra PIJAMA E VESTIDO):
        // antes retornava 1 linha sÃ³ (MAX alfabÃ©tico escondia uma famÃ­lia).
        const [allRows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT REF, DESCRICAOCOMPLETA FROM produtos WHERE REF = ?`,
          [trimmed],
        );
        if (allRows.length > 0) {
          return this.groupRowsByFamily(allRows as any[]);
        }
        // Fallback: se nÃ£o bateu exato, tenta prefixo (ex: usuÃ¡rio digitou
        // sÃ³ parte da REF). Evita o LIKE %term% que confunde "9002"/"900246".
        const [prefRows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT REF, DESCRICAOCOMPLETA
             FROM produtos
            WHERE REF LIKE ?
              AND REF IS NOT NULL
              AND REF <> ''
            ORDER BY REF ASC
            LIMIT 500`,
          [`${trimmed}%`],
        );
        return this.groupRowsByFamily(prefRows as any[]);
      } catch (e) {
        this.logger.error(`searchByDescriptionGrouped (ref) falhou: ${(e as Error).message}`);
        return [];
      }
    }

    // â”€â”€â”€ Busca por descriÃ§Ã£o (texto livre): LIKE %palavra% por palavra â”€â”€â”€
    const words = trimmed
      .split(/\s+/)
      .filter((w) => w.length >= 2)
      .slice(0, 6); // limite de palavras pra nÃ£o explodir SQL
    if (!words.length) return [];

    const whereClauses = words.map(() => 'DESCRICAOCOMPLETA LIKE ?').join(' AND ');
    const params = words.map((w) => `%${w}%`);

    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT REF,
                MAX(DESCRICAOCOMPLETA) AS DESCRICAOCOMPLETA,
                COUNT(*) AS VARIANT_COUNT
           FROM produtos
          WHERE ${whereClauses}
            AND REF IS NOT NULL
            AND REF <> ''
          GROUP BY REF
          ORDER BY VARIANT_COUNT DESC
          LIMIT 200`,
        params,
      );
      return rows as any[];
    } catch (e) {
      this.logger.error(`searchByDescriptionGrouped falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Agrupa rows {REF, DESCRICAOCOMPLETA} por "famÃ­lia" e retorna 1 linha por
   * (REF, famÃ­lia). FamÃ­lia = 1Âª palavra significativa (>=4 chars, nÃ£o stopword).
   *
   * Exemplo: REF 8011 com 35 variaÃ§Ãµes onde algumas sÃ£o "PIJAMA FEMININO..." e
   * outras "VESTIDO LONGO...". Retorna 2 linhas:
   *   - { REF: 8011, DESCRICAOCOMPLETA: "PIJAMA FEMININO...", VARIANT_COUNT: 12, FAMILIA: "pijama" }
   *   - { REF: 8011, DESCRICAOCOMPLETA: "VESTIDO LONGO...", VARIANT_COUNT: 23, FAMILIA: "vestido" }
   *
   * Antes o MAX(DESCRICAOCOMPLETA) escondia uma famÃ­lia. Agora frontend pode
   * mostrar TODAS as famÃ­lias e o usuÃ¡rio escolhe qual quer.
   */
  private groupRowsByFamily(
    rows: Array<{ REF: string; DESCRICAOCOMPLETA: string }>,
  ): Array<{ REF: string; DESCRICAOCOMPLETA: string; VARIANT_COUNT: number; FAMILIA?: string }> {
    const STOPWORDS = new Set([
      'plus', 'size', 'feminina', 'feminino', 'masculino', 'masculina',
      'infantil', 'unissex', 'adulto', 'manga', 'curta', 'longa', 'comum',
      'basica', 'basico', 'alfaiataria', 'modelo', 'inverno', 'verao',
    ]);
    const norm = (s: string) =>
      String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    const groups = new Map<string, { ref: string; desc: string; count: number; familia: string }>();
    for (const r of rows) {
      const ref = String(r.REF || '').trim();
      const desc = String(r.DESCRICAOCOMPLETA || '').trim();
      if (!ref) continue;
      const palavras = norm(desc).split(/\s+/).filter(Boolean);
      const familia = palavras.find((w) => w.length >= 4 && !STOPWORDS.has(w)) || '_outros';
      const key = `${ref}::${familia}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
      } else {
        groups.set(key, { ref, desc, count: 1, familia });
      }
    }
    return Array.from(groups.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 200)
      .map((g) => ({
        REF: g.ref,
        DESCRICAOCOMPLETA: g.desc,
        VARIANT_COUNT: g.count,
        FAMILIA: g.familia,
      }));
  }

  /**
   * Resolve EAN13 (cÃ³digo de barras) para uma lista de SKUs do Gigasistemas.
   *
   * Tenta vÃ¡rias colunas conhecidas (EAN13, EAN, CODBARRAS, CODIGOBARRAS,
   * COD_BARRAS, CODIGO_BARRAS) â€” a primeira que retornar dados vÃ¡lidos ganha.
   *
   * Retorna mapa sku â†’ ean. SKUs sem EAN ficam fora do mapa (operador vai
   * ter que bipar manualmente ou reportar).
   *
   * Usado pela tela de bipagem da filial â€” operador bipa EAN, sistema resolve
   * qual SKU Ã© via esse mapa invertido.
   */
  async getEansBySkus(skus: string[]): Promise<Record<string, string>> {
    if (!skus.length) return {};
    // EAN-13 prefixo 8 é GERADO PELO FLOW (EanSequence): o código É o próprio
    // EAN. Resolve local, sem espelho nem Giga — produto cadastrado na live
    // aparece na separação na hora (incidente 14/07).
    const selfEan: Record<string, string> = {};
    for (const s of skus) {
      const t = String(s || '').trim();
      if (/^8\d{12}$/.test(t)) selfEan[t] = t;
    }
    const pendentes = skus.filter((s) => !selfEan[String(s || '').trim()]);
    if (!pendentes.length) return selfEan;
    if (this.mirrorReadsEnabled) {
      try {
        if (await this.mirrorEanReady()) {
          const m = (await this.getEansBySkusFromMirror(pendentes)) as Record<string, string>;
          return { ...m, ...selfEan };
        }
      } catch (e) {
        this.logger.warn(`[mirror-reads] getEansBySkus: ${(e as Error).message} → Giga ao vivo`);
      }
    }
    if (!this.pool) return selfEan;
    const skusVivos = pendentes;
    {
      const skus = skusVivos; // caminho vivo abaixo intacto (só sem os prefixo-8)

    const candidates = ['EAN13', 'EAN', 'CODBARRAS', 'CODIGOBARRAS', 'COD_BARRAS', 'CODIGO_BARRAS'];

    // MERGE de TODAS as colunas (nÃ£o para no primeiro hit â€” uma coluna pode ter 1 SKU
    // preenchido e outra ter o resto). Primeira a preencher ganha a prioridade.
    const map: Record<string, string> = {};
    const totalSet = new Set<string>();

    for (const column of candidates) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO, \`${column}\` AS ean FROM produtos WHERE CODIGO IN (?)`,
          [skus],
        );
        let hits = 0;
        for (const r of rows as any[]) {
          const codigo = String(r.CODIGO).trim();
          const ean = r.ean ? String(r.ean).trim() : '';
          if (ean && ean.length >= 8 && !map[codigo]) {
            map[codigo] = ean;
            totalSet.add(codigo);
            hits++;
          }
        }
        if (hits > 0) {
          this.logger.log(`getEansBySkus: coluna ${column} adicionou ${hits} SKUs (total ${totalSet.size}/${skus.length})`);
        }
      } catch (e: any) {
        // Coluna nÃ£o existe nessa tabela â†’ tenta a prÃ³xima
        if (!/Unknown column/i.test(e?.message ?? '')) {
          this.logger.warn(`getEansBySkus(${column}) erro: ${e.message}`);
        }
      }
    }

    if (totalSet.size === 0) {
      this.logger.warn(`getEansBySkus: nenhuma coluna resolveu EANs pros SKUs ${skus.slice(0, 3).join(',')}...`);
    }
    return { ...map, ...selfEan };
    }
  }

  /**
   * Fallback pra bipagem: dado um EAN bipado, procura em TODAS as colunas candidatas
   * da tabela produtos (EAN13, EAN, CODBARRAS, etc) + tenta com e sem zeros Ã  esquerda.
   * Retorna o CODIGO (SKU oficial do Gigasistemas) ou null.
   *
   * Usado quando o frontend bipa um EAN que nÃ£o bateu no mapa local (eventualmente
   * o SKU do WC nÃ£o existe exatamente como CODIGO no Gigasistemas, ou tem padding
   * diferente de zeros).
   */
  async findSkuByAnyEan(ean: string): Promise<string | null> {
    if (!ean) return null;
    const raw = ean.trim();
    if (!raw) return null;
    // EAN prefixo 8 = gerado pelo Flow: o EAN É o código. Resolve local.
    if (/^8\d{12}$/.test(raw)) return raw;
    if (this.mirrorReadsEnabled) {
      try {
        if (await this.mirrorEanReady()) {
          const strippedM = raw.replace(/^0+/, '');
          const variantsM = new Set<string>([raw, strippedM]);
          if (/^\d+$/.test(raw)) {
            variantsM.add(raw.padStart(13, '0'));
            variantsM.add(raw.padStart(14, '0'));
          }
          const hit = await this.findSkuByAnyEanFromMirror(Array.from(variantsM).filter(Boolean));
          if (hit) return hit;
          // miss no espelho → deixa o Giga tentar (EAN recém-cadastrado)
        }
      } catch (e) {
        this.logger.warn(`[mirror-reads] findSkuByAnyEan: ${(e as Error).message} → Giga ao vivo`);
      }
    }
    if (!this.pool) return null;

    // Gera variantes: cru, sem zeros Ã  esquerda, padded pra 13/14 dÃ­gitos
    const stripped = raw.replace(/^0+/, '');
    const variants = new Set<string>([raw, stripped]);
    if (/^\d+$/.test(raw)) {
      variants.add(raw.padStart(13, '0'));
      variants.add(raw.padStart(14, '0'));
    }
    const list = Array.from(variants).filter(Boolean);
    if (!list.length) return null;

    // IMPORTANTE: busca por CODIGO primeiro â€” muitas confecÃ§Ãµes imprimem o cÃ³digo
    // interno do ERP como barcode (nÃ£o usam EAN13 internacional). SÃ³ depois
    // tenta as colunas de EAN propriamente ditas.
    const columns = ['CODIGO', 'EAN13', 'EAN', 'CODBARRAS', 'CODIGOBARRAS', 'COD_BARRAS', 'CODIGO_BARRAS'];

    for (const col of columns) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO FROM produtos WHERE \`${col}\` IN (?) LIMIT 5`,
          [list],
        );
        if ((rows as any[]).length) {
          const codigo = String((rows as any[])[0].CODIGO).trim();
          this.logger.log(`findSkuByAnyEan: EAN ${raw} encontrado em ${col} â†’ ${codigo}`);
          return codigo;
        }
      } catch (e: any) {
        if (!/Unknown column/i.test(e?.message ?? '')) {
          this.logger.warn(`findSkuByAnyEan(${col}) erro: ${e.message}`);
        }
      }
    }
    return null;
  }

  /**
   * DIAGNÃ“STICO: dump completo de um SKU na tabela produtos â€” todas as colunas
   * candidatas de EAN. Usado pra debugar quando um bip nÃ£o casa.
   */
  async debugProductEans(sku: string): Promise<Record<string, any> | null> {
    if (!this.pool || !sku) return null;
    const columns = ['EAN13', 'EAN', 'CODBARRAS', 'CODIGOBARRAS', 'COD_BARRAS', 'CODIGO_BARRAS', 'REF', 'REFERENCIA'];
    const existing: string[] = [];
    // Descobre quais colunas existem
    try {
      const [cols] = await this.pool.query<mysql.RowDataPacket[]>('SHOW COLUMNS FROM produtos');
      const names = new Set((cols as any[]).map((c) => String(c.Field).toUpperCase()));
      for (const c of columns) {
        if (names.has(c)) existing.push(c);
      }
    } catch {
      return null;
    }
    if (!existing.length) return { sku, columns: [], row: null };
    const selectList = ['CODIGO', ...existing].map((c) => `\`${c}\``).join(', ');
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT ${selectList} FROM produtos WHERE CODIGO = ? LIMIT 1`,
        [sku.trim()],
      );
      return {
        sku,
        columnsChecked: existing,
        row: (rows as any[])[0] ?? null,
      };
    } catch (e: any) {
      return { sku, error: e.message, columnsChecked: existing, row: null };
    }
  }

  /**
   * DIAGNÃ“STICO: lista tabelas do Gigasistemas que batem com um LIKE.
   * Uso: `listTablesLike('%credi%')` â†’ retorna nomes de tabelas com "credi".
   * Se a tabela existir, tambÃ©m devolve schema (colunas) e 3 linhas de amostra.
   *
   * Endpoint pensado pra eu (Claude) descobrir estrutura de tabelas sem precisar
   * subir dump â€” Ãºtil pra investigar integraÃ§Ãµes (ex: crediarios do WinCred).
   */
  async listTablesLike(
    pattern: string,
  ): Promise<{
    pattern: string;
    tables: string[];
    details: Array<{ table: string; columns: Array<{ field: string; type: string }>; sample: any[]; rowCount?: number }>;
  }> {
    if (!this.pool) return { pattern, tables: [], details: [] };

    const p = String(pattern || '').trim() || '%';
    const safe = p.includes('%') ? p : `%${p}%`;

    try {
      const [tRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SHOW TABLES LIKE ?`,
        [safe],
      );
      // SHOW TABLES retorna colunas tipo "Tables_in_gigasistemas21"
      const tables: string[] = (tRows as any[]).map((r) => {
        const keys = Object.keys(r);
        return String(r[keys[0]]);
      });

      const details: Array<{
        table: string;
        columns: Array<{ field: string; type: string }>;
        sample: any[];
        rowCount?: number;
      }> = [];

      for (const t of tables.slice(0, 10)) {
        // SÃ³ inspeciona as 10 primeiras â€” evitar payload gigante
        try {
          const [cols] = await this.pool.query<mysql.RowDataPacket[]>(
            // Nome de tabela nÃ£o pode ser parametrizado â€” usamos regex pra sanitizar
            `SHOW COLUMNS FROM \`${t.replace(/[^a-zA-Z0-9_]/g, '')}\``,
          );
          const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
            `SELECT * FROM \`${t.replace(/[^a-zA-Z0-9_]/g, '')}\` LIMIT 3`,
          );
          const [countRows] = await this.pool.query<mysql.RowDataPacket[]>(
            `SELECT COUNT(*) AS c FROM \`${t.replace(/[^a-zA-Z0-9_]/g, '')}\``,
          );
          details.push({
            table: t,
            columns: (cols as any[]).map((c) => ({ field: c.Field, type: c.Type })),
            sample: rows as any[],
            rowCount: Number((countRows as any[])[0]?.c ?? 0),
          });
        } catch (e: any) {
          details.push({ table: t, columns: [], sample: [], rowCount: undefined });
          this.logger.warn(`listTablesLike(describe ${t}) falhou: ${e.message}`);
        }
      }

      return { pattern: safe, tables, details };
    } catch (e: any) {
      this.logger.error(`listTablesLike falhou: ${e.message}`);
      return { pattern: safe, tables: [], details: [] };
    }
  }

  /** Retorna metadados de um produto (nome, preÃ§o) direto da tabela produtos. */
  async getProduct(sku: string): Promise<{ name: string; price: number } | null> {
    if (!this.pool) return null;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT DESCRICAOCOMPLETA AS name, VENDAUN AS price
           FROM produtos
          WHERE CODIGO = ?
          LIMIT 1`,
        [sku],
      );
      if (!rows.length) return null;
      return { name: String(rows[0].name), price: Number(rows[0].price) };
    } catch {
      return null;
    }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // PUBLICAÃ‡ÃƒO NO SITE â€” busca de referÃªncias pra enfileirar no LURDS ORDER ONE
  //
  // Este bloco existe pra alimentar a tela /retaguarda/publicar-site (Fase 1
  // da integraÃ§Ã£o Wincredâ†’WooCommerce). A estratÃ©gia Ã© DEFENSIVA: nem todo
  // Gigasistemas tem as mesmas colunas (GRUPO, SUBGRUPO, FORNECEDOR, NCM,
  // CFOP, DATACADASTRO variam por versÃ£o/customizaÃ§Ã£o). EntÃ£o detectamos o
  // schema em tempo de execuÃ§Ã£o via `SHOW COLUMNS` e montamos as queries
  // sÃ³ com as colunas que existem.
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  // Cache do schema da tabela `produtos` (conjunto de colunas em UPPER).
  // Evita rodar SHOW COLUMNS a cada request da tela.
  private _productsColsCache: Set<string> | null = null;
  private async getProductsColumns(): Promise<Set<string>> {
    if (this._productsColsCache) return this._productsColsCache;
    if (!this.pool) return new Set();
    try {
      const [cols] = await this.pool.query<mysql.RowDataPacket[]>(
        'SHOW COLUMNS FROM produtos',
      );
      const set = new Set<string>(
        (cols as any[]).map((c) => String(c.Field).toUpperCase()),
      );
      this._productsColsCache = set;
      return set;
    } catch (e) {
      this.logger.warn(`getProductsColumns falhou: ${(e as Error).message}`);
      return new Set();
    }
  }

  /**
   * Resolve o nome REAL da coluna no schema, dado um conjunto de candidatos
   * comuns. Retorna o primeiro que existe, ou null. Ãštil pra campos que
   * variam entre versÃµes do Gigasistemas (ex: CUSTOUN / CUSTO / CUSTOMEDIO).
   */
  private async pickCol(candidates: string[]): Promise<string | null> {
    const cols = await this.getProductsColumns();
    for (const cand of candidates) {
      if (cols.has(cand.toUpperCase())) return cand;
    }
    return null;
  }

  /**
   * FACETS â€” valores distintos de GRUPO, SUBGRUPO, FORNECEDOR pra popular
   * dropdowns no frontend. Cada um sÃ³ Ã© retornado se a coluna existir no
   * schema. Limita 500 valores por facet (o CEO tem poucos por natureza).
   */
  async getGigaFacetsForPublish(): Promise<{
    grupos: string[];
    subgrupos: string[];
    fornecedores: string[];
    hasGrupo: boolean;
    hasSubgrupo: boolean;
    hasFornecedor: boolean;
  }> {
    const emptyResult = {
      grupos: [] as string[],
      subgrupos: [] as string[],
      fornecedores: [] as string[],
      hasGrupo: false,
      hasSubgrupo: false,
      hasFornecedor: false,
    };
    if (!this.pool) return emptyResult;

    const grupoCol = await this.pickCol(['GRUPO', 'GRUPODESC', 'GRUPO_DESC', 'NOMEGRUPO']);
    const subgrupoCol = await this.pickCol(['SUBGRUPO', 'SUB_GRUPO', 'SUBGRUPODESC', 'NOMESUBGRUPO']);
    const fornecedorCol = await this.pickCol(['FORNECEDOR', 'NOMEFORNECEDOR', 'FORNECEDORNOME', 'FORN']);

    const result = { ...emptyResult };
    result.hasGrupo = !!grupoCol;
    result.hasSubgrupo = !!subgrupoCol;
    result.hasFornecedor = !!fornecedorCol;

    // Faz as 3 queries em paralelo, tolerando erro em cada uma.
    const tasks: Promise<void>[] = [];
    if (grupoCol) {
      tasks.push(
        this.pool
          .query<mysql.RowDataPacket[]>(
            `SELECT DISTINCT \`${grupoCol}\` AS v
               FROM produtos
              WHERE \`${grupoCol}\` IS NOT NULL AND \`${grupoCol}\` <> ''
              ORDER BY v
              LIMIT 500`,
          )
          .then(([rows]) => {
            result.grupos = (rows as any[]).map((r) => String(r.v).trim()).filter(Boolean);
          })
          .catch((e) => this.logger.warn(`facet grupo falhou: ${e?.message ?? e}`)),
      );
    }
    if (subgrupoCol) {
      tasks.push(
        this.pool
          .query<mysql.RowDataPacket[]>(
            `SELECT DISTINCT \`${subgrupoCol}\` AS v
               FROM produtos
              WHERE \`${subgrupoCol}\` IS NOT NULL AND \`${subgrupoCol}\` <> ''
              ORDER BY v
              LIMIT 500`,
          )
          .then(([rows]) => {
            result.subgrupos = (rows as any[]).map((r) => String(r.v).trim()).filter(Boolean);
          })
          .catch((e) => this.logger.warn(`facet subgrupo falhou: ${e?.message ?? e}`)),
      );
    }
    if (fornecedorCol) {
      tasks.push(
        this.pool
          .query<mysql.RowDataPacket[]>(
            `SELECT DISTINCT \`${fornecedorCol}\` AS v
               FROM produtos
              WHERE \`${fornecedorCol}\` IS NOT NULL AND \`${fornecedorCol}\` <> ''
              ORDER BY v
              LIMIT 500`,
          )
          .then(([rows]) => {
            result.fornecedores = (rows as any[]).map((r) => String(r.v).trim()).filter(Boolean);
          })
          .catch((e) => this.logger.warn(`facet fornecedor falhou: ${e?.message ?? e}`)),
      );
    }
    await Promise.all(tasks);
    return result;
  }

  /**
   * BUSCA PARA PUBLICAÃ‡ÃƒO â€” retorna referÃªncias agrupadas por REF+COR.
   *
   * Filtros (todos opcionais, combinam com AND):
   *   - refs:         lista de REFs exatas (fast-path, usa IN). MÃ¡x 200.
   *   - term:         busca LIKE em DESCRICAOCOMPLETA (mÃºltiplas palavras = AND).
   *   - grupo/subgrupo/fornecedor: exatos. SÃ³ aplicam se a coluna existir.
   *   - diasCadastro: Ãºltimos N dias (usa DATACADASTRO/DATA_CADASTRO/DT_CADASTRO
   *                   se existir; caso contrÃ¡rio ignora).
   *
   * Formato de retorno: array de REFs, cada uma com array de cores, cada cor
   * com array de tamanhos (CODIGO+TAMANHO+ESTOQUE). Tudo que o frontend precisa
   * pra mostrar o card e deixar o CEO marcar as cores que quer subir.
   *
   * Limite: 200 REFs distintas por chamada (pra nÃ£o travar a tela).
   */
  async searchRefsForPublish(filters: {
    refs?: string[];
    term?: string;
    grupo?: string;
    subgrupo?: string;
    fornecedor?: string;
    diasCadastro?: number;
    limit?: number;
  }): Promise<{
    refs: Array<{
      refCode: string;
      descricao: string;
      descLonga: string | null;
      grupo: string | null;
      subgrupo: string | null;
      fornecedor: string | null;
      ncm: string | null;
      cfop: string | null;
      custo: number | null;
      preco: number | null;          // preÃ§o PRINCIPAL (a prazo, geralmente)
      precoVista: number | null;     // preÃ§o Ã  vista (se diferente)
      precoPromo: number | null;     // preÃ§o promo (se houver)
      cores: Array<{
        cor: string;
        tamanhos: Array<{
          tamanho: string | null;
          codigo: string;
          estoque: number;
          ean: string | null;
        }>;
        estoqueTotal: number;
      }>;
      totalVariations: number;
      estoqueTotal: number;
    }>;
    truncated: boolean;
    schema: {
      hasGrupo: boolean;
      hasSubgrupo: boolean;
      hasFornecedor: boolean;
      hasDataCadastro: boolean;
    };
  }> {
    const empty = {
      refs: [] as any[],
      truncated: false,
      schema: { hasGrupo: false, hasSubgrupo: false, hasFornecedor: false, hasDataCadastro: false },
    };
    if (!this.pool) return empty as any;

    // Descobre colunas reais
    const cols = await this.getProductsColumns();
    const grupoCol = (await this.pickCol(['GRUPO', 'GRUPODESC', 'GRUPO_DESC', 'NOMEGRUPO'])) as string | null;
    const subgrupoCol = (await this.pickCol(['SUBGRUPO', 'SUB_GRUPO', 'SUBGRUPODESC', 'NOMESUBGRUPO'])) as string | null;
    const fornecedorCol = (await this.pickCol(['FORNECEDOR', 'NOMEFORNECEDOR', 'FORNECEDORNOME', 'FORN'])) as string | null;
    const ncmCol = (await this.pickCol(['NCM', 'CODNCM', 'CODIGONCM', 'COD_NCM'])) as string | null;
    const cfopCol = (await this.pickCol(['CFOP', 'CODCFOP'])) as string | null;
    const custoCol = (await this.pickCol(['CUSTOUN', 'CUSTO', 'CUSTO_UN', 'CUSTOMEDIO', 'CUSTO_MEDIO'])) as string | null;
    // FIX: Wincred tem MÃšLTIPLAS colunas de preÃ§o (Ã  vista, a prazo, promo, etc).
    // VENDAUN normalmente Ã© PREÃ‡O Ã€ VISTA (mais BAIXO). Pra publicaÃ§Ã£o no site, o
    // CEO geralmente quer o PREÃ‡O A PRAZO (VPRAZO/PRECOPRAZO), que Ã© o praticado
    // no PDV. Buscamos todos e expomos no payload pra UI escolher.
    const precoCol      = (await this.pickCol(['VPRAZO', 'PRECOPRAZO', 'PRECO_PRAZO', 'VENDAPRAZO', 'PRECOVENDA', 'PRECO_VENDA', 'PRECO', 'VENDAUN'])) as string | null;
    const precoVistaCol = (await this.pickCol(['VAVISTA', 'PRECOVISTA', 'PRECO_VISTA', 'VENDAVISTA', 'VENDAUN'])) as string | null;
    const precoPromoCol = (await this.pickCol(['PRECOPROMO', 'PRECO_PROMO', 'VPROMO', 'VENDAPROMO'])) as string | null;
    // DescriÃ§Ã£o estendida â€” Wincred Ã s vezes tem campos extras (OBSERVACAO, DETALHES,
    // INFORMACOES). Pegamos pra usar como base de descriÃ§Ã£o se houver.
    const descLongaCol  = (await this.pickCol(['OBSERVACAO', 'OBSERVACOES', 'DETALHES', 'INFORMACOES', 'DESCRICAOPROD', 'DESCRICAO_PROD', 'DESCRICAO'])) as string | null;
    const dataCol = (await this.pickCol(['DATAALT', 'DATA_ALT', 'DT_ALT', 'DATACADASTRO', 'DATA_CADASTRO', 'DT_CADASTRO', 'DATACRIACAO', 'DT_CRIACAO', 'CREATED_AT'])) as string | null;
    const eanCol = (await this.pickCol(['EAN13', 'EAN', 'CODBARRAS', 'CODIGOBARRAS', 'COD_BARRAS', 'CODIGO_BARRAS'])) as string | null;

    // Monta SELECT dinÃ¢mico
    const selects = [
      'p.CODIGO AS codigo',
      'p.REF AS ref',
      'p.DESCRICAOCOMPLETA AS descricao',
      'p.COR AS cor',
      'p.TAMANHO AS tamanho',
      'p.ESTOQUE AS estoqueLinha',
    ];
    if (grupoCol) selects.push(`p.\`${grupoCol}\` AS grupo`);
    if (subgrupoCol) selects.push(`p.\`${subgrupoCol}\` AS subgrupo`);
    if (fornecedorCol) selects.push(`p.\`${fornecedorCol}\` AS fornecedor`);
    if (ncmCol) selects.push(`p.\`${ncmCol}\` AS ncm`);
    if (cfopCol) selects.push(`p.\`${cfopCol}\` AS cfop`);
    if (custoCol) selects.push(`p.\`${custoCol}\` AS custo`);
    if (precoCol) selects.push(`p.\`${precoCol}\` AS preco`);
    if (precoVistaCol && precoVistaCol !== precoCol) selects.push(`p.\`${precoVistaCol}\` AS precoVista`);
    if (precoPromoCol) selects.push(`p.\`${precoPromoCol}\` AS precoPromo`);
    if (descLongaCol)  selects.push(`p.\`${descLongaCol}\` AS descLonga`);
    if (eanCol) selects.push(`p.\`${eanCol}\` AS ean`);
    if (dataCol) selects.push(`p.\`${dataCol}\` AS dataCadastro`);

    // WHERE
    const wheres: string[] = ["p.REF IS NOT NULL", "p.REF <> ''"];
    const params: any[] = [];

    if (filters.refs && filters.refs.length) {
      const clean = filters.refs
        .map((r) => String(r).trim())
        .filter((r) => r.length > 0)
        .slice(0, 200);
      if (clean.length) {
        // Wincred Ã s vezes cadastra cada cor como uma REF separada com sufixo
        // de espaÃ§o + letras (ex: "VMS-223" vira "VMS-223 P", "VMS-223 A",
        // "VMS-223 V", "VMS-223 N"). Pra o CEO nÃ£o precisar conhecer esse
        // detalhe de cadastro, a busca por "VMS-223" precisa pegar tambÃ©m
        // "VMS-223 X". Mesma lÃ³gica jÃ¡ usada em products.service (task #107).
        const orParts: string[] = [];
        for (const r of clean) {
          orParts.push('p.REF = ?');
          params.push(r);
          orParts.push('p.REF LIKE ?');
          params.push(`${r} %`); // espaÃ§o + qualquer sufixo de cor
        }
        wheres.push(`(${orParts.join(' OR ')})`);
      }
    }
    if (filters.term) {
      const words = String(filters.term)
        .trim()
        .split(/\s+/)
        .filter((w) => w.length >= 2);
      for (const w of words) {
        wheres.push('p.DESCRICAOCOMPLETA LIKE ?');
        params.push(`%${w}%`);
      }
    }
    if (filters.grupo && grupoCol) {
      wheres.push(`p.\`${grupoCol}\` = ?`);
      params.push(filters.grupo);
    }
    if (filters.subgrupo && subgrupoCol) {
      wheres.push(`p.\`${subgrupoCol}\` = ?`);
      params.push(filters.subgrupo);
    }
    if (filters.fornecedor && fornecedorCol) {
      wheres.push(`p.\`${fornecedorCol}\` = ?`);
      params.push(filters.fornecedor);
    }
    if (filters.diasCadastro && dataCol) {
      const n = Math.max(1, Math.min(3650, Number(filters.diasCadastro) || 30));
      wheres.push(`p.\`${dataCol}\` >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`);
      params.push(n);
    }

    const limitRefs = Math.max(1, Math.min(500, Number(filters.limit) || 200));
    // Primeiro descobre quais REFs batem (pra limitar); depois busca TODAS
    // as linhas dessas REFs (pra mostrar as cores/tamanhos completos).
    // IMPORTANTE: usamos limite inflado (x5) pra compensar sub-REFs â€” o limit
    // final vira pelo nÂº de REFs BASE Ãºnicas apÃ³s normalizaÃ§Ã£o.
    const sqlRefs = `
      SELECT DISTINCT p.REF AS ref
        FROM produtos p
       WHERE ${wheres.join(' AND ')}
       ORDER BY p.REF
       LIMIT ${limitRefs * 5 + 1}
    `;

    let refList: string[] = [];
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sqlRefs, params);
      refList = (rows as any[]).map((r) => String(r.ref).trim()).filter(Boolean);
    } catch (e) {
      this.logger.error(`searchRefsForPublish (refs step) falhou: ${(e as Error).message}`);
      return empty as any;
    }
    if (!refList.length) {
      return {
        refs: [],
        truncated: false,
        schema: {
          hasGrupo: !!grupoCol,
          hasSubgrupo: !!subgrupoCol,
          hasFornecedor: !!fornecedorCol,
          hasDataCadastro: !!dataCol,
        },
      };
    }
    // Deduplica pela REF base pra contar corretamente quantos produtos Ãºnicos
    // existem. MantÃ©m TODOS os sub-REFs na refList (passados pro IN), mas o
    // truncate fica baseado no nÂº de bases Ãºnicas.
    const uniqBaseRefs = new Set<string>();
    for (const r of refList) {
      const base = r.replace(/\s[A-Za-z]{1,3}$/, '').trim() || r;
      uniqBaseRefs.add(base);
    }
    const truncated = uniqBaseRefs.size > limitRefs;

    // Agora busca TODAS as linhas dessas REFs pra montar cor/tamanho.
    // FIX: re-aplicar OS MESMOS filtros (term/grupo/subgrupo/fornecedor/dias)
    // pra evitar trazer variaÃ§Ãµes que NÃƒO batem. Antes, se REF=13050 tinha
    // alguma variaÃ§Ã£o com "vestido longo" mas outras eram SOUTIEN, a Fase 2
    // trazia TODAS â€” incluindo o SOUTIEN. Agora sÃ³ vem o que combina.
    // Usa subset dos wheres SEM o filtro de REF (substituido pelo IN).
    const detailWheres = wheres.filter(
      (w) => !w.includes('p.REF = ?') && !w.includes('p.REF LIKE ?'),
    );
    // Reconstroi params correspondentes â€” remove os params do filtro REF original
    const detailParams: any[] = [];
    let pIdx = 0;
    for (const w of wheres) {
      // Conta quantos ? cada where consome
      const qmarks = (w.match(/\?/g) || []).length;
      if (w.includes('p.REF = ?') || w.includes('p.REF LIKE ?')) {
        pIdx += qmarks; // pula
      } else {
        for (let i = 0; i < qmarks; i++) detailParams.push(params[pIdx++]);
      }
    }
    detailWheres.push('p.REF IN (?)');
    detailParams.push(refList);

    const sqlDetails = `
      SELECT ${selects.join(', ')}
        FROM produtos p
       WHERE ${detailWheres.join(' AND ')}
       ORDER BY p.REF, p.COR, p.TAMANHO
    `;
    let detailRows: any[] = [];
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sqlDetails, detailParams);
      detailRows = rows as any[];
    } catch (e) {
      this.logger.error(`searchRefsForPublish (details) falhou: ${(e as Error).message}`);
      return empty as any;
    }

    // Normaliza REF pra base â€” Wincred cadastra cada cor como sub-REF com
    // sufixo (ex: "VMS-223 P", "VMS-223 A"). O CEO pensa "VMS-223" e espera
    // ver todas as 4 cores embaixo dessa referÃªncia Ãºnica. Mesma regex usada
    // em products.service (task #107) pra manter consistÃªncia.
    const normalizeBaseRef = (ref: string): string => {
      const s = String(ref).trim();
      return s.replace(/\s[A-Za-z]{1,3}$/, '').trim() || s;
    };

    // Agrupa por REF BASE â†’ COR â†’ tamanhos.
    const byRef = new Map<string, any>();
    for (const r of detailRows) {
      const rawRef = String(r.ref).trim();
      if (!rawRef) continue;
      const refCode = normalizeBaseRef(rawRef);
      let refEntry = byRef.get(refCode);
      if (!refEntry) {
        refEntry = {
          refCode,
          descricao: String(r.descricao ?? '').trim(),
          descLonga: r.descLonga != null ? String(r.descLonga).trim() : null,
          grupo: r.grupo != null ? String(r.grupo).trim() : null,
          subgrupo: r.subgrupo != null ? String(r.subgrupo).trim() : null,
          fornecedor: r.fornecedor != null ? String(r.fornecedor).trim() : null,
          ncm: r.ncm != null ? String(r.ncm).trim() : null,
          cfop: r.cfop != null ? String(r.cfop).trim() : null,
          custo: r.custo != null ? Number(r.custo) : null,
          preco: r.preco != null ? Number(r.preco) : null,
          precoVista: r.precoVista != null ? Number(r.precoVista) : null,
          precoPromo: r.precoPromo != null ? Number(r.precoPromo) : null,
          coresMap: new Map<string, any>(),
          totalVariations: 0,
          estoqueTotal: 0,
        };
        byRef.set(refCode, refEntry);
      }
      const corKey = (r.cor == null ? '' : String(r.cor).trim()).toUpperCase() || 'SEM_COR';
      let corEntry = refEntry.coresMap.get(corKey);
      if (!corEntry) {
        corEntry = {
          cor: r.cor != null ? String(r.cor).trim() : '',
          tamanhos: [] as any[],
          estoqueTotal: 0,
        };
        refEntry.coresMap.set(corKey, corEntry);
      }
      const est = Number(r.estoqueLinha) || 0;
      corEntry.tamanhos.push({
        tamanho: r.tamanho != null ? String(r.tamanho).trim() : null,
        codigo: String(r.codigo).trim(),
        estoque: est,
        ean: r.ean != null ? String(r.ean).trim() : null,
      });
      corEntry.estoqueTotal += est;
      refEntry.totalVariations += 1;
      refEntry.estoqueTotal += est;
    }

    // Transforma Map â†’ Array
    const refs = Array.from(byRef.values()).map((r: any) => ({
      refCode: r.refCode as string,
      descricao: r.descricao as string,
      descLonga: (r.descLonga ?? null) as string | null,
      grupo: (r.grupo ?? null) as string | null,
      subgrupo: (r.subgrupo ?? null) as string | null,
      fornecedor: (r.fornecedor ?? null) as string | null,
      ncm: (r.ncm ?? null) as string | null,
      cfop: (r.cfop ?? null) as string | null,
      custo: (r.custo ?? null) as number | null,
      preco: (r.preco ?? null) as number | null,
      precoVista: (r.precoVista ?? null) as number | null,
      precoPromo: (r.precoPromo ?? null) as number | null,
      cores: (Array.from(r.coresMap.values()) as any[]).map((c: any) => ({
        cor: c.cor as string,
        tamanhos: c.tamanhos as Array<{ tamanho: string | null; codigo: string; estoque: number; ean: string | null }>,
        estoqueTotal: c.estoqueTotal as number,
      })),
      totalVariations: r.totalVariations as number,
      estoqueTotal: r.estoqueTotal as number,
    }));

    return {
      refs,
      truncated,
      schema: {
        hasGrupo: !!grupoCol,
        hasSubgrupo: !!subgrupoCol,
        hasFornecedor: !!fornecedorCol,
        hasDataCadastro: !!dataCol,
      },
    };
  }

  /**
   * Retorna os dados crus de UMA REF+COR (todos os tamanhos) â€” usado no
   * momento de enfileirar pra congelar o snapshot no banco local.
   */
  async getRefColorForQueue(refCode: string, cor: string): Promise<{
    descricao: string;
    descLonga: string | null;
    grupo: string | null;
    subgrupo: string | null;
    fornecedor: string | null;
    ncm: string | null;
    cfop: string | null;
    custo: number | null;
    preco: number | null;
    precoVista: number | null;
    precoPromo: number | null;
    tamanhos: Array<{ tamanho: string | null; codigo: string; estoque: number; ean: string | null }>;
  } | null> {
    // Normaliza caso o caller mande sub-REF ("VMS-223 P") â€” a busca expande
    // sozinha, mas o matching na Map Ã© sempre pela base.
    const baseRef = String(refCode).trim().replace(/\s[A-Za-z]{1,3}$/, '').trim() || String(refCode).trim();
    const res = await this.searchRefsForPublish({ refs: [baseRef] });
    const ref = res.refs.find((r) => r.refCode === baseRef);
    if (!ref) return null;
    const corUpper = String(cor).trim().toUpperCase();
    const corEntry =
      ref.cores.find((c) => String(c.cor).trim().toUpperCase() === corUpper) ??
      (corUpper === 'SEM_COR' ? ref.cores.find((c) => !c.cor) : undefined);
    if (!corEntry) return null;
    return {
      descricao: ref.descricao,
      descLonga: ref.descLonga,
      grupo: ref.grupo,
      subgrupo: ref.subgrupo,
      fornecedor: ref.fornecedor,
      ncm: ref.ncm,
      cfop: ref.cfop,
      custo: ref.custo,
      preco: ref.preco,
      precoVista: ref.precoVista,
      precoPromo: ref.precoPromo,
      tamanhos: corEntry.tamanhos,
    };
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // EXPLORER GENÃ‰RICO DO ERP â€” list/schema/run read-only
  //
  // Usado pela tela /relatorios/giga (matriz). Permite ao admin executar
  // queries SELECT arbitrÃ¡rias contra o banco do Gigasistemas pra extrair
  // dados em tempo real (relatÃ³rios ad-hoc, exports CSV/XLSX, dashboards).
  //
  // SeguranÃ§a (defesa em camadas):
  //  1. Controller exige role admin/operator
  //  2. runReadOnly bloqueia comandos de escrita (regex blacklist)
  //  3. runReadOnly forÃ§a LIMIT global (default 1000, max 50000)
  //  4. Pool dedicado de leitura â€” usa o mesmo pool, mas o user MySQL
  //     do Gigasistemas idealmente sÃ³ tem GRANT SELECT
  //  5. Timeout de 30s na query
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Health check do pool MySQL â€” devolve diagnÃ³stico em formato amigÃ¡vel.
   *
   * NÃ£o engole erro: retorna o `error.message` real pra UI mostrar o motivo
   * (timeout, ECONNREFUSED, access denied, etc.). TambÃ©m expÃµe se as envs
   * obrigatÃ³rias estÃ£o setadas (sem vazar senha).
   */
  async pingHealth(): Promise<{
    ok: boolean;
    error?: string;
    host?: string;
    port?: number;
    database?: string;
    hasUser: boolean;
    hasPassword: boolean;
    pingMs?: number;
  }> {
    const host = this.config.get<string>('ERP_HOST');
    const port = Number(this.config.get<string>('ERP_PORT') ?? 3306);
    const database = this.config.get<string>('ERP_DATABASE');
    const hasUser = !!this.config.get<string>('ERP_USER');
    const hasPassword = !!this.config.get<string>('ERP_PASSWORD');

    if (!this.pool) {
      return { ok: false, error: 'Pool ERP nÃ£o inicializado', host, port, database, hasUser, hasPassword };
    }
    const t0 = Date.now();
    try {
      const conn = await this.pool.getConnection();
      try {
        await conn.ping();
      } finally {
        conn.release();
      }
      return { ok: true, host, port, database, hasUser, hasPassword, pingMs: Date.now() - t0 };
    } catch (e: any) {
      return {
        ok: false,
        error: e?.message ?? 'ping falhou',
        host, port, database, hasUser, hasPassword,
      };
    }
  }

  /**
   * Lista TODAS as tabelas do banco. EstratÃ©gia robusta:
   *   1. Tenta information_schema.TABLES (com TABLE_SCHEMA = ?). Traz rows+size.
   *   2. Se vier vazio, fallback pra SHOW TABLES (nÃ£o tem metadados, mas
   *      funciona em user MySQL com GRANT mÃ­nimo). Tenta enriquecer com
   *      information_schema.STATISTICS.TABLE_ROWS por tabela.
   *
   * Por que dois caminhos? O Gigasistemas usa MySQL antigo onde nem todo user
   * tem permissÃ£o pra ler information_schema completa. SHOW TABLES funciona
   * com qualquer SELECT, mesmo restrito.
   */
  async listAllTables(): Promise<Array<{ name: string; rows: number; sizeMb: number; engine: string | null }>> {
    if (!this.pool) return [];

    const dbName = this.config.get<string>('ERP_DATABASE') ?? '';

    // Tentativa 1: information_schema (com schema explÃ­cito + DATABASE() como fallback)
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT
            TABLE_NAME    AS name,
            TABLE_ROWS    AS rows,
            ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) AS sizeMb,
            ENGINE        AS engine
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = COALESCE(?, DATABASE())
            AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
          ORDER BY TABLE_NAME ASC`,
        [dbName || null],
      );
      const arr = (rows as any[]).map((r) => ({
        name: String(r.name),
        rows: Number(r.rows ?? 0),
        sizeMb: Number(r.sizeMb ?? 0),
        engine: r.engine ? String(r.engine) : null,
      }));
      if (arr.length > 0) return arr;
      this.logger.warn('listAllTables: information_schema retornou 0 â€” caindo pro SHOW TABLES');
    } catch (e: any) {
      this.logger.warn(`listAllTables information_schema falhou: ${e.message} â€” caindo pro SHOW TABLES`);
    }

    // Tentativa 2: SHOW TABLES (mais robusto, mas sem metadados de tamanho)
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(`SHOW TABLES`);
      // SHOW TABLES retorna 1 coluna chamada Tables_in_<dbname>
      const arr = (rows as any[]).map((r) => {
        const name = String(Object.values(r)[0] ?? '');
        return { name, rows: 0, sizeMb: 0, engine: null as string | null };
      }).filter((x) => x.name);
      this.logger.log(`listAllTables: SHOW TABLES retornou ${arr.length} tabelas`);
      return arr;
    } catch (e: any) {
      this.logger.error(`listAllTables SHOW TABLES tambÃ©m falhou: ${e.message}`);
      return [];
    }
  }

  /** Retorna schema (colunas + tipos + key) e amostra de N rows pra uma tabela. */
  async getTableSchema(
    tableName: string,
    sampleLimit = 5,
  ): Promise<{
    table: string;
    columns: Array<{ field: string; type: string; null: string; key: string; default: string | null }>;
    sample: any[];
    rowCount: number;
  } | null> {
    if (!this.pool) return null;
    // Sanitiza o nome da tabela: sÃ³ alfanum/underscore (mysql identifier)
    const safe = String(tableName || '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!safe) return null;
    const lim = Math.max(1, Math.min(50, Number(sampleLimit) || 5));

    try {
      const [cols] = await this.pool.query<mysql.RowDataPacket[]>(
        `SHOW COLUMNS FROM \`${safe}\``,
      );
      const [sample] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT * FROM \`${safe}\` LIMIT ${lim}`,
      );
      const [cnt] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS c FROM \`${safe}\``,
      );

      return {
        table: safe,
        columns: (cols as any[]).map((c) => ({
          field: String(c.Field),
          type: String(c.Type),
          null: String(c.Null),
          key: String(c.Key ?? ''),
          default: c.Default == null ? null : String(c.Default),
        })),
        sample: this.serializeRows(sample as any[]),
        rowCount: Number((cnt as any[])[0]?.c ?? 0),
      };
    } catch (e: any) {
      this.logger.warn(`getTableSchema(${safe}) falhou: ${e.message}`);
      return null;
    }
  }

  /**
   * Executa uma query READ-ONLY (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH).
   * Bloqueia comandos de escrita por regex e forÃ§a LIMIT.
   *
   * Retorna columns + rows + meta (executionMs, truncated).
   */
  async runReadOnly(
    sqlRaw: string,
    opts: { maxRows?: number; timeoutMs?: number } = {},
    params?: any[],
  ): Promise<{
    columns: string[];
    rows: any[];
    executionMs: number;
    rowCount: number;
    truncated: boolean;
    appliedLimit: number;
  }> {
    if (!this.pool) {
      throw new Error('Pool ERP nÃ£o inicializado');
    }
    const sql = String(sqlRaw || '').trim();
    if (!sql) throw new Error('SQL vazio');

    // Tira comentÃ¡rios simples e ponto-e-vÃ­rgula final pra checar a 1Âª palavra
    const cleaned = sql
      .replace(/^\s*--[^\n]*\n?/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim()
      .replace(/;+\s*$/, '');

    // 1. WHITELIST â€” sÃ³ comandos read-only
    const firstWord = cleaned.split(/\s+/)[0]?.toUpperCase() ?? '';
    const allowedFirst = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH'];
    if (!allowedFirst.includes(firstWord)) {
      throw new Error(`Apenas comandos de leitura: ${allowedFirst.join(', ')}. Recebido: ${firstWord || '(vazio)'}`);
    }

    // 2. BLACKLIST â€” nÃ£o pode ter comandos de escrita em qualquer lugar
    // (ex: SELECT 1; DELETE FROM produtos â€” rejeita pelo ;)
    if (/;[\s\S]+\S/.test(cleaned)) {
      throw new Error('MÃºltiplos statements separados por ";" nÃ£o sÃ£o permitidos');
    }
    // BUG FIX: REPLACE foi removido da blacklist porque colidia com a funÃ§Ã£o
    // de string REPLACE() usada pra normalizar CPF na busca de cliente do Giga.
    // O comando perigoso "REPLACE INTO" (escrita) jÃ¡ Ã© bloqueado pela WHITELIST
    // acima â€” que sÃ³ aceita SELECT/SHOW/DESCRIBE/DESC/EXPLAIN/WITH como 1Âª palavra.
    const blacklist = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|RENAME|GRANT|REVOKE|LOAD\s+DATA|INTO\s+OUTFILE|INTO\s+DUMPFILE|HANDLER|LOCK\s+TABLES|UNLOCK|CALL|DO\s+SLEEP|BENCHMARK\s*\()\b/i;
    const m = blacklist.exec(cleaned);
    if (m) {
      throw new Error(`Comando bloqueado: "${m[0].toUpperCase()}". Apenas leitura Ã© permitida.`);
    }

    // 3. LIMIT automÃ¡tico (sÃ³ pra SELECT/WITH; SHOW/DESCRIBE nÃ£o precisa)
    const maxRows = Math.max(1, Math.min(50000, opts.maxRows ?? 1000));
    let finalSql = cleaned;
    let appliedLimit = maxRows;
    if (firstWord === 'SELECT' || firstWord === 'WITH') {
      // Detecta LIMIT jÃ¡ existente (case-insensitive, no fim)
      const limitMatch = cleaned.match(/\bLIMIT\s+(\d+)(\s*,\s*\d+)?\s*$/i);
      if (limitMatch) {
        const userLimit = Number(limitMatch[1]);
        if (userLimit > maxRows) {
          // UsuÃ¡rio pediu acima do teto â€” sobrescreve
          finalSql = cleaned.replace(/\bLIMIT\s+\d+(\s*,\s*\d+)?\s*$/i, `LIMIT ${maxRows}`);
        } else {
          appliedLimit = userLimit;
        }
      } else {
        finalSql = `${cleaned}\nLIMIT ${maxRows}`;
      }
    }

    // 4. Timeout
    const timeoutMs = Math.max(1000, Math.min(120_000, opts.timeoutMs ?? 30_000));

    const t0 = Date.now();
    try {
      const conn = await this.pool.getConnection();
      try {
        // SET SESSION pra timeout â€” precisa ser ms (mysql usa MAX_EXECUTION_TIME hint OU SESSION var)
        // Forma compatÃ­vel com MySQL 5.7+: hint /*+ MAX_EXECUTION_TIME(N) */
        // Mas hint nÃ£o funciona em SHOW/DESCRIBE â€” entÃ£o usa SET SESSION quando dÃ¡.
        try {
          await conn.query(`SET SESSION MAX_EXECUTION_TIME=${timeoutMs}`);
        } catch {
          // MariaDB / versÃµes antigas nÃ£o suportam â€” segue sem timeout server-side
        }
        // params (opcional): quando presente, usa placeholders `?` — os valores
        // sao escapados pelo mysql2 (fecha SQL injection nos LIKE de busca e
        // evita que um termo tipo "DELETE" caia na blacklist). Sem params, a
        // execucao e identica ao comportamento anterior.
        const [rows, fields] =
          params && params.length
            ? await conn.query<mysql.RowDataPacket[]>(finalSql, params)
            : await conn.query<mysql.RowDataPacket[]>(finalSql);
        const ms = Date.now() - t0;
        const arr = Array.isArray(rows) ? (rows as any[]) : [];
        const cols = Array.isArray(fields)
          ? (fields as any[]).map((f) => String(f.name))
          : arr.length
          ? Object.keys(arr[0])
          : [];
        return {
          columns: cols,
          rows: this.serializeRows(arr),
          executionMs: ms,
          rowCount: arr.length,
          truncated: arr.length >= appliedLimit,
          appliedLimit,
        };
      } finally {
        conn.release();
      }
    } catch (e: any) {
      throw new Error(`MySQL: ${e.message}`);
    }
  }

  /** Serializa rows pra JSON: Bufferâ†’string, Dateâ†’ISO, BigIntâ†’number. */
  private serializeRows(rows: any[]): any[] {
    return rows.map((r) => {
      const out: any = {};
      for (const k of Object.keys(r)) {
        const v = r[k];
        if (v == null) out[k] = null;
        else if (Buffer.isBuffer(v)) out[k] = v.toString('utf8');
        else if (v instanceof Date) out[k] = v.toISOString();
        else if (typeof v === 'bigint') out[k] = Number(v);
        else out[k] = v;
      }
      return out;
    });
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // INTELIGÃŠNCIA DE ESTOQUE â€” mÃ©todos pra dashboard /retaguarda/inteligencia-estoque
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Detecta a coluna de DATA CADASTRO da tabela `produtos` (varia por versÃ£o
   * Giga: DATACADASTRO, DATA_INC, DT_CADASTRO, CREATED_AT, etc). CachÃª em
   * memÃ³ria pra evitar repetir DESCRIBE em cada query.
   */
  private _cadCol: string | null | undefined = undefined;
  async getCadastroDateCol(): Promise<string | null> {
    if (this._cadCol !== undefined) return this._cadCol;
    const candidatas = [
      'DATACADASTRO', 'DATA_CADASTRO', 'DT_CADASTRO',
      'DATA_INC', 'DATAINC', 'DT_INC', 'DATA_INCLUSAO', 'DATAINCLUSAO', 'DT_INCLUSAO',
      'DATACRIACAO', 'DT_CRIACAO',
      'DATA_ENT', 'DATAENT', 'DT_ENT', 'DATA_ENTRADA', 'DATAENTRADA', 'DT_ENTRADA',
      'CREATED_AT', 'CRIADO_EM',
      // Giga Lurd's: a única data em `produtos` é DATAALT (fallback — não há
      // coluna de cadastro dedicada).
      'DATAALT',
    ];
    // Auto-detecção; se nada casar, CAI no DATAALT (única data em `produtos` do
    // Giga Lurd's — confirmado no schema). Override via env GIGA_PRODUTO_DATA_COL.
    // Não depender só da detecção: ela voltava null e o filtro de ano virava no-op.
    const detected = await this.pickCol(candidatas);
    const fallback = (process.env.GIGA_PRODUTO_DATA_COL || 'DATAALT').trim();
    this._cadCol = detected || fallback || null;
    this.logger.log(
      `[erp] coluna de data cadastro = ${this._cadCol} (detectada: ${detected || 'nenhuma'}, fallback: ${fallback})`,
    );
    return this._cadCol;
  }

  /**
   * Converte filtro de ano (`pre2020`, `2021`, `2022`...) em condiÃ§Ã£o SQL
   * + bind params. Retorna `{ cond: '', params: [] }` se nÃ£o tiver coluna
   * de data ou filtro vazio.
   */
  private async buildYearFilter(
    year: string | undefined,
    pAlias: string,
  ): Promise<{ cond: string; params: any[] }> {
    if (!year) return { cond: '', params: [] };
    const dataCol = await this.getCadastroDateCol();
    if (!dataCol) return { cond: '', params: [] };
    const colRef = `${pAlias}.\`${dataCol}\``;
    if (year === 'pre2020') {
      return { cond: `${colRef} < ?`, params: ['2021-01-01'] };
    }
    const y = parseInt(year, 10);
    if (isNaN(y) || y < 2000 || y > 2100) return { cond: '', params: [] };
    return {
      cond: `${colRef} >= ? AND ${colRef} < ?`,
      params: [`${y}-01-01`, `${y + 1}-01-01`],
    };
  }

  /**
   * Estoque atual em PEÃ‡AS por loja (somatÃ³rio de ESTOQUE > 0).
   * Filtra opcionalmente sÃ³ PLUS SIZE e/ou por ANO DE CADASTRO da peÃ§a.
   *
   * Retorna Map<storeCode, totalPecas>. Lojas sem estoque NÃƒO aparecem (caller trata como 0).
   */
  async getStockTotalByStores(
    plusSize = false,
    year?: string,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.pool) return out;
    try {
      const yf = await this.buildYearFilter(year, 'p');
      const needsJoin = plusSize || yf.cond;
      const conds: string[] = ['e.ESTOQUE > 0'];
      if (plusSize) conds.push(`(COALESCE(p.PLUS_SIZE, 0) > 0 OR UPPER(COALESCE(p.DESCRICAOCOMPLETA, '')) LIKE '%PLUS SIZE%')`);
      if (yf.cond) conds.push(yf.cond);

      // JOIN por match EXATO (usa índice). NÃO usar CAST(... AS UNSIGNED):
      // estoque.CODIGO tem códigos não-numéricos (ex: 'MANUAL-1780170') que
      // viram 0 no CAST → JOIN explode (MAX_JOIN_SIZE) → query aborta → 0.
      // O exato pega ~todo o estoque (confirmado: ~212k peças); MANUAL não casa
      // produto e fica de fora (correto — não tem cadastro).
      const sql = needsJoin
        ? `SELECT e.LOJA AS storeCode, SUM(e.ESTOQUE) AS pecas
             FROM estoque e
             INNER JOIN produtos p ON p.CODIGO = e.CODIGO
            WHERE ${conds.join(' AND ')}
            GROUP BY e.LOJA`
        : `SELECT LOJA AS storeCode, SUM(ESTOQUE) AS pecas
             FROM estoque
            WHERE ESTOQUE > 0
            GROUP BY LOJA`;
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, yf.params);
      for (const r of rows as any[]) {
        const code = String(r.storeCode || '').trim();
        const pecas = Number(r.pecas) || 0;
        if (code && pecas > 0) out.set(code, pecas);
      }
      return out;
    } catch (e) {
      this.logger.error(`getStockTotalByStores falhou: ${(e as Error).message}`);
      return out;
    }
  }

  /**
   * Matriz LOJA × ANO de cadastro (DATAALT): peças em estoque por loja, quebradas
   * por ano. Uma query só (GROUP BY loja, bucket de ano). Bucket: 'pre2020'
   * (< 2021), o ano (2021..), ou 'sem_data' (DATAALT nulo). Pro relatório PDF.
   */
  async getStockByYearByStore(
    plusSize = false,
  ): Promise<Array<{ loja: string; ano: string; pecas: number }>> {
    if (!this.pool) return [];
    try {
      const dataCol = await this.getCadastroDateCol();
      const anoExpr = dataCol
        ? `CASE WHEN p.\`${dataCol}\` IS NULL THEN 'sem_data'
                WHEN p.\`${dataCol}\` < '2021-01-01' THEN 'pre2020'
                ELSE CAST(YEAR(p.\`${dataCol}\`) AS CHAR) END`
        : `'sem_data'`;
      const conds: string[] = ['e.ESTOQUE > 0'];
      if (plusSize) conds.push(`(COALESCE(p.PLUS_SIZE, 0) > 0 OR UPPER(COALESCE(p.DESCRICAOCOMPLETA, '')) LIKE '%PLUS SIZE%')`);
      // Match EXATO (índice). NÃO usar CAST: estoque.CODIGO tem 'MANUAL-...' que
      // vira 0 no CAST e estoura o MAX_JOIN_SIZE. Exato pega ~todo o estoque.
      const sql = `SELECT e.LOJA AS loja, ${anoExpr} AS ano, SUM(e.ESTOQUE) AS pecas
                     FROM estoque e
                     INNER JOIN produtos p ON p.CODIGO = e.CODIGO
                    WHERE ${conds.join(' AND ')}
                    GROUP BY e.LOJA, ano`;
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql);
      return (rows as any[]).map((r) => ({
        loja: String(r.loja || '').trim(),
        ano: String(r.ano || 'sem_data').trim(),
        pecas: Number(r.pecas) || 0,
      }));
    } catch (e) {
      this.logger.error(`getStockByYearByStore falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Vendas por loja num perÃ­odo (data inicio/fim half-open: >= inicio, < fim).
   * Retorna peÃ§as vendidas + valor bruto. Ignora MARCADO='SIM'.
   * Filtros opcionais: PLUS SIZE + ANO DE CADASTRO da peÃ§a.
   * Quando hÃ¡ filtro de plusSize ou year, faz JOIN com `produtos`.
   */
  async getSalesByStoresInRange(
    inicio: Date,
    fim: Date,
    plusSize = false,
    year?: string,
  ): Promise<Map<string, { pecas: number; valor: number }>> {
    const out = new Map<string, { pecas: number; valor: number }>();
    // Espelho não implementa o filtro `year` (raro/admin) — esse segue no Giga.
    if (!year) {
      try {
        if (await this.caixaMovUsable(inicio)) {
          return await this.salesByStoresInRangeFromMirror(inicio, fim, plusSize);
        }
      } catch (e) {
        this.logger.warn(`[mirror-reads] getSalesByStoresInRange: ${(e as Error).message} → Giga ao vivo`);
      }
    }
    if (!this.pool) return out;
    try {
      const yf = await this.buildYearFilter(year, 'p');
      const needsJoin = plusSize || yf.cond;
      const conds: string[] = [
        'c.DATA >= ?',
        'c.DATA < ?',
        "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
      ];
      const params: any[] = [inicio, fim];
      if (plusSize) conds.push(`(COALESCE(p.PLUS_SIZE, 0) > 0 OR UPPER(COALESCE(p.DESCRICAOCOMPLETA, '')) LIKE '%PLUS SIZE%')`);
      if (yf.cond) {
        conds.push(yf.cond);
        params.push(...yf.params);
      }

      // BUG FIX padding: ignora zeros Ã  esquerda no JOIN caixaÃ—produtos
      const sql = needsJoin
        ? `SELECT c.LOJA AS storeCode,
                  SUM(c.QUANTIDADE) AS pecas,
                  SUM(c.VALORTOTAL) AS valor
             FROM caixa c
             INNER JOIN produtos p ON CAST(p.CODIGO AS UNSIGNED) = CAST(c.CODIGO AS UNSIGNED)
            WHERE ${conds.join(' AND ')}
            GROUP BY c.LOJA`
        : `SELECT c.LOJA AS storeCode,
                  SUM(c.QUANTIDADE) AS pecas,
                  SUM(c.VALORTOTAL) AS valor
             FROM caixa c
            WHERE ${conds.join(' AND ')}
            GROUP BY c.LOJA`;
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      for (const r of rows as any[]) {
        const code = String(r.storeCode || '').trim();
        if (!code) continue;
        out.set(code, {
          pecas: Number(r.pecas) || 0,
          valor: Number(r.valor) || 0,
        });
      }
      return out;
    } catch (e) {
      this.logger.error(`getSalesByStoresInRange falhou: ${(e as Error).message}`);
      return out;
    }
  }

  /**
   * TOP REFs vendidas no perÃ­odo. Pode ser:
   *   - Toda a rede (storeCode null) ou loja especÃ­fica
   *   - Ordenadas por peÃ§as OU por valor
   *   - Filtro PLUS SIZE
   *
   * Junta `caixa` com `produtos` pra resolver REF (CODIGO no caixa = SKU).
   * Retorna atÃ© `limit` linhas.
   */
  async getTopRefsBySales(input: {
    inicio: Date;
    fim: Date;
    storeCode?: string | null;
    plusSize?: boolean;
    orderBy?: 'pecas' | 'valor';
    limit?: number;
  }): Promise<Array<{ refCode: string; descricao: string | null; pecas: number; valor: number }>> {
    const orderBy = input.orderBy === 'valor' ? 'valor' : 'pecas';
    const limit = Math.max(1, Math.min(100, input.limit || 10));
    try {
      if (await this.caixaMovUsable(input.inicio)) {
        return await this.topRefsFromMirror({
          inicio: input.inicio, fim: input.fim, storeCode: input.storeCode,
          plusSize: input.plusSize, orderBy, limit,
        });
      }
    } catch (e) {
      this.logger.warn(`[mirror-reads] getTopRefsBySales: ${(e as Error).message} → Giga ao vivo`);
    }
    if (!this.pool) return [];

    // OtimizaÃ§Ã£o: agrega `caixa` por CODIGO PRIMEIRO (subquery filtrada),
    // depois faz JOIN com produtos. Reduz drasticamente o tamanho do JOIN.
    const caixaConds: string[] = [
      'c.DATA >= ?',
      'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
    ];
    const caixaParams: any[] = [input.inicio, input.fim];
    if (input.storeCode) {
      caixaConds.push('c.LOJA = ?');
      caixaParams.push(input.storeCode);
    }

    const prodConds: string[] = ['p.REF IS NOT NULL', "p.REF <> ''"];
    if (input.plusSize) {
      prodConds.push("(COALESCE(p.PLUS_SIZE, 0) > 0 OR UPPER(COALESCE(p.DESCRICAOCOMPLETA, '')) LIKE '%PLUS SIZE%')");
    }

    // BUG FIX padding: caixa.CODIGO e produtos.CODIGO podem ter padding
    // diferente (ex: "5358458" vs "0005358458"). Compara como UNSIGNED INT
    // pra ignorar zeros Ã  esquerda. Mesmo problema do getStock.
    const sql = `
      SELECT p.REF AS refCode,
             MAX(p.DESCRICAOCOMPLETA) AS descricao,
             SUM(agg.pecas) AS pecas,
             SUM(agg.valor) AS valor
        FROM (
          SELECT c.CODIGO AS codigo,
                 SUM(c.QUANTIDADE) AS pecas,
                 SUM(c.VALORTOTAL) AS valor
            FROM caixa c
           WHERE ${caixaConds.join(' AND ')}
           GROUP BY c.CODIGO
        ) agg
        INNER JOIN produtos p ON CAST(p.CODIGO AS UNSIGNED) = CAST(agg.codigo AS UNSIGNED)
       WHERE ${prodConds.join(' AND ')}
       GROUP BY p.REF
       ORDER BY ${orderBy} DESC
       LIMIT ${limit}
    `;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, caixaParams);
      return (rows as any[]).map((r) => ({
        refCode: String(r.refCode).trim(),
        descricao: r.descricao ? String(r.descricao).trim() : null,
        pecas: Number(r.pecas) || 0,
        valor: Number(r.valor) || 0,
      }));
    } catch (e) {
      this.logger.error(`getTopRefsBySales falhou: ${(e as Error).message}`);
      return []; // nÃ£o throw â€” nÃ£o quebra o Promise.all do getStoreDetail
    }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // RELATÃ“RIO DE VENDAS â€” usado pela /retaguarda/inteligencia-vendas
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /** Cache do mapeamento dinÃ¢mico de colunas das tabelas caixa/produtos */
  private salesColMap: {
    vendedor: string | null;
    marca: string | null;
    numCupom: string | null;
  } | null = null;

  /**
   * Detecta colunas dinÃ¢micas relevantes pra relatÃ³rio de vendas:
   *  - VENDEDOR na tabela `caixa` (ou `funcionario`, `vendedor_codigo`)
   *  - MARCA na tabela `produtos` (ou `fabricante`, `griffe`)
   *  - NUMCUPOM/CUPOM/NUMVENDA na tabela caixa pra contar quantas vendas
   * Cache em memÃ³ria â€” detecta 1Ã— e reaproveita.
   */
  private async detectSalesColumns(): Promise<{
    vendedor: string | null;
    marca: string | null;
    numCupom: string | null;
  }> {
    if (this.salesColMap) return this.salesColMap;
    let vendedor: string | null = null;
    let marca: string | null = null;
    let numCupom: string | null = null;
    try {
      const caixaSchema = await this.getTableSchema('caixa', 1);
      if (caixaSchema) {
        const cols = caixaSchema.columns.map((c: any) => c.field);
        vendedor = cols.find((c: string) =>
          /^vendedor$/i.test(c) || /^vendedora$/i.test(c) ||
          /^cod_?vendedor$/i.test(c) || /^funcionario$/i.test(c) ||
          /^cod_?func/i.test(c)
        ) || null;
        numCupom = cols.find((c: string) =>
          /^num_?cupom$/i.test(c) || /^cupom$/i.test(c) ||
          /^num_?venda$/i.test(c) || /^numero?_?venda$/i.test(c) ||
          /^numero?_?cupom$/i.test(c) || /^cupom_?fiscal$/i.test(c)
        ) || null;
      }
      const prodSchema = await this.getTableSchema('produtos', 1);
      if (prodSchema) {
        const cols = prodSchema.columns.map((c: any) => c.field);
        marca = cols.find((c: string) =>
          /^marca$/i.test(c) || /^fabricante$/i.test(c) ||
          /^griffe$/i.test(c) || /^grife$/i.test(c)
        ) || null;
      }
    } catch (e: any) {
      this.logger.warn(`detectSalesColumns falhou: ${e?.message}`);
    }
    this.salesColMap = { vendedor, marca, numCupom };
    this.logger.log(`detectSalesColumns: ${JSON.stringify(this.salesColMap)}`);
    return this.salesColMap;
  }

  /**
   * SUMMARY â€” totais agregados do perÃ­odo. Retorna peÃ§as, valor, nÃºmero
   * de cupons distintos (vendas), ticket mÃ©dio.
   */
  async getSalesSummary(input: {
    inicio: Date;
    fim: Date;
    storeCode?: string | null;
  }): Promise<{ pecas: number; valor: number; vendas: number; ticketMedio: number }> {
    try {
      if (await this.caixaMovUsable(input.inicio)) {
        return await this.salesSummaryFromMirror(input.inicio, input.fim, input.storeCode);
      }
    } catch (e) {
      this.logger.warn(`[mirror-reads] getSalesSummary: ${(e as Error).message} → Giga ao vivo`);
    }
    if (!this.pool) return { pecas: 0, valor: 0, vendas: 0, ticketMedio: 0 };
    const { numCupom } = await this.detectSalesColumns();
    const conds: string[] = [
      'c.DATA >= ?',
      'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
    ];
    const params: any[] = [input.inicio, input.fim];
    if (input.storeCode) {
      conds.push('c.LOJA = ?');
      params.push(input.storeCode);
    }
    const cupomSelect = numCupom
      ? `COUNT(DISTINCT CONCAT(c.LOJA, '-', c.\`${numCupom}\`)) AS vendas`
      : `COUNT(DISTINCT CONCAT(c.LOJA, '-', DATE(c.DATA), '-', COALESCE(c.CODCLIENTE, 0))) AS vendas`;
    const sql = `
      SELECT SUM(c.QUANTIDADE) AS pecas,
             SUM(c.VALORTOTAL) AS valor,
             ${cupomSelect}
        FROM caixa c
       WHERE ${conds.join(' AND ')}
    `;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      const r: any = (rows as any[])[0] || {};
      const pecas = Number(r.pecas) || 0;
      const valor = Number(r.valor) || 0;
      const vendas = Number(r.vendas) || 0;
      return {
        pecas,
        valor,
        vendas,
        ticketMedio: vendas > 0 ? valor / vendas : 0,
      };
    } catch (e) {
      this.logger.error(`getSalesSummary falhou: ${(e as Error).message}`);
      return { pecas: 0, valor: 0, vendas: 0, ticketMedio: 0 };
    }
  }

  /** Vendas agrupadas POR DIA â€” pra grÃ¡fico de linha/barra. */
  async getSalesByDay(input: {
    inicio: Date;
    fim: Date;
    storeCode?: string | null;
  }): Promise<Array<{ date: string; pecas: number; valor: number }>> {
    try {
      if (await this.caixaMovUsable(input.inicio)) {
        return await this.salesByDayFromMirror(input.inicio, input.fim, input.storeCode);
      }
    } catch (e) {
      this.logger.warn(`[mirror-reads] getSalesByDay: ${(e as Error).message} → Giga ao vivo`);
    }
    if (!this.pool) return [];
    const conds: string[] = [
      'c.DATA >= ?',
      'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
    ];
    const params: any[] = [input.inicio, input.fim];
    if (input.storeCode) {
      conds.push('c.LOJA = ?');
      params.push(input.storeCode);
    }
    const sql = `
      SELECT DATE(c.DATA) AS d,
             SUM(c.QUANTIDADE) AS pecas,
             SUM(c.VALORTOTAL) AS valor
        FROM caixa c
       WHERE ${conds.join(' AND ')}
       GROUP BY DATE(c.DATA)
       ORDER BY d ASC
    `;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      return (rows as any[]).map((r) => ({
        date: r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10),
        pecas: Number(r.pecas) || 0,
        valor: Number(r.valor) || 0,
      }));
    } catch (e) {
      this.logger.error(`getSalesByDay falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * TOP VENDEDORAS â€” agrupado por cÃ³digo (e nome se a tabela funcionarios
   * existir e tiver coluna nome). Calcula valor + qtd peÃ§as + nÃºmero de
   * vendas distintas.
   */
  async getTopVendedoras(input: {
    inicio: Date;
    fim: Date;
    storeCode?: string | null;
    limit?: number;
  }): Promise<Array<{ codigo: string; nome: string; pecas: number; valor: number; vendas: number }>> {
    try {
      if (await this.caixaMovUsable(input.inicio)) {
        return await this.topVendedorasFromMirror({
          inicio: input.inicio, fim: input.fim, storeCode: input.storeCode,
          limit: Math.max(1, Math.min(100, input.limit || 20)),
        });
      }
    } catch (e) {
      this.logger.warn(`[mirror-reads] getTopVendedoras: ${(e as Error).message} → Giga ao vivo`);
    }
    if (!this.pool) return [];
    const { vendedor: vendedorCol, numCupom } = await this.detectSalesColumns();
    if (!vendedorCol) {
      this.logger.warn('getTopVendedoras: coluna VENDEDOR nÃ£o detectada na caixa');
      return [];
    }
    const limit = Math.max(1, Math.min(100, input.limit || 20));
    const conds: string[] = [
      'c.DATA >= ?',
      'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
      `c.\`${vendedorCol}\` IS NOT NULL`,
    ];
    const params: any[] = [input.inicio, input.fim];
    if (input.storeCode) {
      conds.push('c.LOJA = ?');
      params.push(input.storeCode);
    }
    const cupomCount = numCupom
      ? `COUNT(DISTINCT CONCAT(c.LOJA, '-', c.\`${numCupom}\`))`
      : `COUNT(DISTINCT CONCAT(c.LOJA, '-', DATE(c.DATA), '-', COALESCE(c.CODCLIENTE, 0)))`;

    // Tenta JOIN com `funcionarios` pra trazer nome â€” se a tabela nÃ£o existir
    // ou nÃ£o tiver coluna nome, faz sÃ³ agregaÃ§Ã£o por cÃ³digo.
    let sqlWithJoin: string | null = null;
    try {
      const funcSchema = await this.getTableSchema('funcionarios', 1);
      if (funcSchema) {
        const cols = funcSchema.columns.map((c: any) => c.field);
        const codCol = cols.find((c: string) => /^codigo$/i.test(c) || /^cod/i.test(c) || /^id$/i.test(c));
        const nomeCol = cols.find((c: string) => /^nome$/i.test(c));
        if (codCol && nomeCol) {
          sqlWithJoin = `
            SELECT CONCAT('', c.\`${vendedorCol}\`) AS codigo,
                   MAX(f.\`${nomeCol}\`) AS nome,
                   SUM(c.QUANTIDADE) AS pecas,
                   SUM(c.VALORTOTAL) AS valor,
                   ${cupomCount} AS vendas
              FROM caixa c
              LEFT JOIN funcionarios f ON CONCAT('', f.\`${codCol}\`) = CONCAT('', c.\`${vendedorCol}\`)
             WHERE ${conds.join(' AND ')}
             GROUP BY CONCAT('', c.\`${vendedorCol}\`)
             ORDER BY valor DESC
             LIMIT ${limit}
          `;
        }
      }
    } catch {/* funcionarios nÃ£o existe â€” sem JOIN */}

    const sql = sqlWithJoin || `
      SELECT CONCAT('', c.\`${vendedorCol}\`) AS codigo,
             '' AS nome,
             SUM(c.QUANTIDADE) AS pecas,
             SUM(c.VALORTOTAL) AS valor,
             ${cupomCount} AS vendas
        FROM caixa c
       WHERE ${conds.join(' AND ')}
       GROUP BY CONCAT('', c.\`${vendedorCol}\`)
       ORDER BY valor DESC
       LIMIT ${limit}
    `;

    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      return (rows as any[]).map((r) => ({
        codigo: String(r.codigo || '').trim(),
        nome: String(r.nome || '').trim(),
        pecas: Number(r.pecas) || 0,
        valor: Number(r.valor) || 0,
        vendas: Number(r.vendas) || 0,
      }));
    } catch (e) {
      this.logger.error(`getTopVendedoras falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Total faturado em UM MÃŠS especÃ­fico de UM ANO especÃ­fico.
   * Usado pra montar grÃ¡fico "Ãºltimos N anos no mesmo mÃªs".
   */
  async getMonthSalesByYear(input: {
    year: number;
    month: number; // 1-12
    storeCode?: string | null;
  }): Promise<{ pecas: number; valor: number }> {
    const inicio = new Date(input.year, input.month - 1, 1);
    const fim = new Date(input.year, input.month, 1);
    try {
      if (await this.caixaMovUsable(inicio)) {
        const s = await this.salesSummaryFromMirror(inicio, fim, input.storeCode);
        return { pecas: s.pecas, valor: s.valor };
      }
    } catch (e) {
      this.logger.warn(`[mirror-reads] getMonthSalesByYear: ${(e as Error).message} → Giga ao vivo`);
    }
    if (!this.pool) return { pecas: 0, valor: 0 };
    const conds: string[] = [
      'c.DATA >= ?', 'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
    ];
    const params: any[] = [inicio, fim];
    if (input.storeCode) {
      conds.push('c.LOJA = ?');
      params.push(input.storeCode);
    }
    const sql = `SELECT SUM(c.QUANTIDADE) AS pecas, SUM(c.VALORTOTAL) AS valor FROM caixa c WHERE ${conds.join(' AND ')}`;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      const r: any = (rows as any[])[0] || {};
      return { pecas: Number(r.pecas) || 0, valor: Number(r.valor) || 0 };
    } catch (e) {
      this.logger.warn(`getMonthSalesByYear ${input.year}/${input.month} falhou`);
      return { pecas: 0, valor: 0 };
    }
  }

  /**
   * Vendas por MÃŠS nos Ãºltimos N meses. Pra grÃ¡fico de linha
   * "evoluÃ§Ã£o mensal Ãºltimos 12 meses".
   */
  async getSalesByMonth(input: {
    months: number;
    storeCode?: string | null;
  }): Promise<Array<{ year: number; month: number; pecas: number; valor: number }>> {
    const months = Math.max(1, Math.min(36, input.months));
    const out: Array<{ year: number; month: number; pecas: number; valor: number }> = [];
    const now = new Date();
    {
      const inicioM = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
      const fimM = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      try {
        if (await this.caixaMovUsable(inicioM)) {
          const rows = await this.salesMonthAggFromMirror(inicioM, fimM, input.storeCode);
          const map = new Map<string, any>();
          for (const r of rows) map.set(`${r.y}-${r.m}`, { pecas: r.pecas, valor: r.valor });
          for (let i = months - 1; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const k = `${d.getFullYear()}-${d.getMonth() + 1}`;
            const v = map.get(k) || { pecas: 0, valor: 0 };
            out.push({ year: d.getFullYear(), month: d.getMonth() + 1, pecas: v.pecas, valor: v.valor });
          }
          return out;
        }
      } catch (e) {
        this.logger.warn(`[mirror-reads] getSalesByMonth: ${(e as Error).message} → Giga ao vivo`);
      }
    }
    if (!this.pool) return [];

    // Promise.all com N queries seria mais rÃ¡pido mas pode estourar conexÃ£o.
    // Uma sÃ³ query com agregaÃ§Ã£o por YEAR/MONTH Ã© melhor.
    const inicio = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
    const fim = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const conds: string[] = [
      'c.DATA >= ?', 'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
    ];
    const params: any[] = [inicio, fim];
    if (input.storeCode) {
      conds.push('c.LOJA = ?');
      params.push(input.storeCode);
    }
    const sql = `
      SELECT YEAR(c.DATA) AS y, MONTH(c.DATA) AS m,
             SUM(c.QUANTIDADE) AS pecas,
             SUM(c.VALORTOTAL) AS valor
        FROM caixa c
       WHERE ${conds.join(' AND ')}
       GROUP BY YEAR(c.DATA), MONTH(c.DATA)
       ORDER BY y ASC, m ASC
    `;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      // Preenche todos os meses (mesmo zero) pra grÃ¡fico ficar contÃ­nuo
      const map = new Map<string, any>();
      for (const r of rows as any[]) {
        map.set(`${r.y}-${r.m}`, { pecas: Number(r.pecas) || 0, valor: Number(r.valor) || 0 });
      }
      for (let i = months - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const k = `${d.getFullYear()}-${d.getMonth() + 1}`;
        const v = map.get(k) || { pecas: 0, valor: 0 };
        out.push({ year: d.getFullYear(), month: d.getMonth() + 1, pecas: v.pecas, valor: v.valor });
      }
      return out;
    } catch (e) {
      this.logger.warn(`getSalesByMonth falhou: ${(e as Error).message}`);
      return out;
    }
  }

  /**
   * Quantidade de clientes Ãºnicos no perÃ­odo (CODCLIENTE distinct).
   */
  async getUniqueClientesCount(input: {
    inicio: Date;
    fim: Date;
    storeCode?: string | null;
  }): Promise<number> {
    try {
      if (await this.caixaMovUsable(input.inicio)) {
        return await this.uniqueClientesFromMirror(input.inicio, input.fim, input.storeCode);
      }
    } catch (e) {
      this.logger.warn(`[mirror-reads] getUniqueClientesCount: ${(e as Error).message} → Giga ao vivo`);
    }
    if (!this.pool) return 0;
    const conds: string[] = [
      'c.DATA >= ?', 'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
      'c.CODCLIENTE IS NOT NULL',
      'c.CODCLIENTE > 0',
    ];
    const params: any[] = [input.inicio, input.fim];
    if (input.storeCode) {
      conds.push('c.LOJA = ?');
      params.push(input.storeCode);
    }
    const sql = `SELECT COUNT(DISTINCT c.CODCLIENTE) AS clientes FROM caixa c WHERE ${conds.join(' AND ')}`;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      return Number((rows as any[])[0]?.clientes) || 0;
    } catch {
      return 0;
    }
  }

  /** TOP MARCAS â€” agrupa por coluna MARCA da tabela produtos. */
  async getTopMarcas(input: {
    inicio: Date;
    fim: Date;
    storeCode?: string | null;
    limit?: number;
  }): Promise<Array<{ marca: string; pecas: number; valor: number }>> {
    try {
      if (await this.caixaMovUsable(input.inicio)) {
        return await this.topMarcasFromMirror({
          inicio: input.inicio, fim: input.fim, storeCode: input.storeCode,
          limit: Math.max(1, Math.min(100, input.limit || 15)),
        });
      }
    } catch (e) {
      this.logger.warn(`[mirror-reads] getTopMarcas: ${(e as Error).message} → Giga ao vivo`);
    }
    if (!this.pool) return [];
    const { marca: marcaCol } = await this.detectSalesColumns();
    if (!marcaCol) {
      this.logger.warn('getTopMarcas: coluna MARCA nÃ£o detectada em produtos');
      return [];
    }
    const limit = Math.max(1, Math.min(100, input.limit || 15));
    const caixaConds: string[] = [
      'c.DATA >= ?',
      'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
    ];
    const params: any[] = [input.inicio, input.fim];
    if (input.storeCode) {
      caixaConds.push('c.LOJA = ?');
      params.push(input.storeCode);
    }
    // BUG FIX padding: ignora zeros Ã  esquerda no JOIN caixaÃ—produtos
    const sql = `
      SELECT UPPER(TRIM(p.\`${marcaCol}\`)) AS marca,
             SUM(agg.pecas) AS pecas,
             SUM(agg.valor) AS valor
        FROM (
          SELECT c.CODIGO,
                 SUM(c.QUANTIDADE) AS pecas,
                 SUM(c.VALORTOTAL) AS valor
            FROM caixa c
           WHERE ${caixaConds.join(' AND ')}
           GROUP BY c.CODIGO
        ) agg
        INNER JOIN produtos p ON CAST(p.CODIGO AS UNSIGNED) = CAST(agg.CODIGO AS UNSIGNED)
       WHERE p.\`${marcaCol}\` IS NOT NULL AND TRIM(p.\`${marcaCol}\`) <> ''
       GROUP BY UPPER(TRIM(p.\`${marcaCol}\`))
       ORDER BY valor DESC
       LIMIT ${limit}
    `;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      return (rows as any[]).map((r) => ({
        marca: String(r.marca || '').trim(),
        pecas: Number(r.pecas) || 0,
        valor: Number(r.valor) || 0,
      }));
    } catch (e) {
      this.logger.error(`getTopMarcas falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * RUPTURAS â€” REFs que VENDERAM no perÃ­odo mas estÃ£o com estoque ZERO HOJE.
   * Sinaliza necessidade de reposiÃ§Ã£o urgente.
   *
   * Pode ser global (storeCode null) ou por loja. Retorna atÃ© `limit`.
   *
   * LÃ³gica: agrega vendas por REF no perÃ­odo, faz LEFT JOIN com estoque
   * (somando todas as lojas se global, sÃ³ a loja se especÃ­fico) e filtra
   * onde estoque atual = 0.
   */
  async getRupturas(input: {
    inicio: Date;
    fim: Date;
    storeCode?: string | null;
    plusSize?: boolean;
    limit?: number;
  }): Promise<Array<{ refCode: string; descricao: string | null; pecasVendidas: number; estoqueAtual: number }>> {
    if (!this.pool) return [];
    const limit = Math.max(1, Math.min(100, input.limit || 10));
    // OtimizaÃ§Ã£o igual getTopRefsBySales: agrega caixa por CODIGO antes do JOIN.
    const caixaConds: string[] = [
      'c.DATA >= ?',
      'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
    ];
    const caixaParams: any[] = [input.inicio, input.fim];
    if (input.storeCode) {
      caixaConds.push('c.LOJA = ?');
      caixaParams.push(input.storeCode);
    }
    const prodConds: string[] = ['p.REF IS NOT NULL', "p.REF <> ''"];
    if (input.plusSize) {
      prodConds.push("(COALESCE(p.PLUS_SIZE, 0) > 0 OR UPPER(COALESCE(p.DESCRICAOCOMPLETA, '')) LIKE '%PLUS SIZE%')");
    }

    // Subquery de estoque atual por REF
    const stockJoin = input.storeCode
      ? `LEFT JOIN (
            SELECT pr.REF AS ref, COALESCE(SUM(e.ESTOQUE), 0) AS qtd
              FROM estoque e
              INNER JOIN produtos pr ON pr.CODIGO = e.CODIGO
             WHERE e.LOJA = ?
             GROUP BY pr.REF
          ) est ON est.ref = p.REF`
      : `LEFT JOIN (
            SELECT pr.REF AS ref, COALESCE(SUM(e.ESTOQUE), 0) AS qtd
              FROM estoque e
              INNER JOIN produtos pr ON pr.CODIGO = e.CODIGO
             GROUP BY pr.REF
          ) est ON est.ref = p.REF`;
    const stockParams = input.storeCode ? [input.storeCode] : [];

    // BUG FIX padding: ignora zeros Ã  esquerda no JOIN caixaÃ—produtos
    const sql = `
      SELECT p.REF AS refCode,
             MAX(p.DESCRICAOCOMPLETA) AS descricao,
             SUM(agg.pecas) AS pecasVendidas,
             COALESCE(MAX(est.qtd), 0) AS estoqueAtual
        FROM (
          SELECT c.CODIGO AS codigo, SUM(c.QUANTIDADE) AS pecas
            FROM caixa c
           WHERE ${caixaConds.join(' AND ')}
           GROUP BY c.CODIGO
        ) agg
        INNER JOIN produtos p ON CAST(p.CODIGO AS UNSIGNED) = CAST(agg.codigo AS UNSIGNED)
        ${stockJoin}
       WHERE ${prodConds.join(' AND ')}
       GROUP BY p.REF
      HAVING estoqueAtual = 0 AND pecasVendidas > 0
       ORDER BY pecasVendidas DESC
       LIMIT ${limit}
    `;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, [...stockParams, ...caixaParams]);
      return (rows as any[]).map((r) => ({
        refCode: String(r.refCode).trim(),
        descricao: r.descricao ? String(r.descricao).trim() : null,
        pecasVendidas: Number(r.pecasVendidas) || 0,
        estoqueAtual: Number(r.estoqueAtual) || 0,
      }));
    } catch (e) {
      this.logger.error(`getRupturas falhou: ${(e as Error).message}`);
      return []; // nÃ£o throw â€” nÃ£o quebra o Promise.all
    }
  }

  /**
   * PARADOS â€” REFs com estoque alto mas SEM venda hÃ¡ N dias (default 30).
   * Candidatos a realinhamento (mandar pra loja que vende mais essa REF).
   *
   * LÃ³gica:
   *   1. Pega REFs com SUM(estoque) >= minStock (default 5)
   *   2. Exclui as que tiveram venda nos Ãºltimos N dias
   *   3. Ordena por estoque desc
   */
  async getParados(input: {
    storeCode?: string | null;
    daysSemVenda?: number;
    minStock?: number;
    plusSize?: boolean;
    limit?: number;
  }): Promise<Array<{ refCode: string; descricao: string | null; estoqueAtual: number; ultimaVenda: string | null }>> {
    if (!this.pool) return [];
    const days = Math.max(1, Math.min(365, input.daysSemVenda || 30));
    const minStock = Math.max(1, input.minStock || 5);
    const limit = Math.max(1, Math.min(100, input.limit || 10));
    const stockConds: string[] = ['e.ESTOQUE > 0'];
    const stockParams: any[] = [];
    if (input.storeCode) {
      stockConds.push('e.LOJA = ?');
      stockParams.push(input.storeCode);
    }
    if (input.plusSize) {
      stockConds.push("(COALESCE(p.PLUS_SIZE, 0) > 0 OR UPPER(COALESCE(p.DESCRICAOCOMPLETA, '')) LIKE '%PLUS SIZE%')");
    }
    const salesJoinFilter = input.storeCode ? 'AND c2.LOJA = ?' : '';
    const salesParams = input.storeCode ? [input.storeCode] : [];

    // BUG FIX padding: ignora zeros Ã  esquerda nos JOINs caixa/estoqueÃ—produtos
    const sql = `
      SELECT p.REF AS refCode,
             MAX(p.DESCRICAOCOMPLETA) AS descricao,
             SUM(e.ESTOQUE) AS estoqueAtual,
             (SELECT MAX(c2.DATA) FROM caixa c2
                INNER JOIN produtos p2 ON CAST(p2.CODIGO AS UNSIGNED) = CAST(c2.CODIGO AS UNSIGNED)
               WHERE p2.REF = p.REF
                 AND (c2.MARCADO IS NULL OR c2.MARCADO <> 'SIM')
                 ${salesJoinFilter}
             ) AS ultimaVenda
        FROM estoque e
        INNER JOIN produtos p ON CAST(p.CODIGO AS UNSIGNED) = CAST(e.CODIGO AS UNSIGNED)
       WHERE ${stockConds.join(' AND ')}
       GROUP BY p.REF
      HAVING estoqueAtual >= ?
         AND (ultimaVenda IS NULL OR ultimaVenda < DATE_SUB(CURDATE(), INTERVAL ? DAY))
       ORDER BY estoqueAtual DESC
       LIMIT ?
    `;
    try {
      const params = [...stockParams, ...salesParams, minStock, days, limit];
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      return (rows as any[]).map((r) => ({
        refCode: String(r.refCode).trim(),
        descricao: r.descricao ? String(r.descricao).trim() : null,
        estoqueAtual: Number(r.estoqueAtual) || 0,
        ultimaVenda: r.ultimaVenda
          ? r.ultimaVenda instanceof Date
            ? r.ultimaVenda.toISOString().slice(0, 10)
            : String(r.ultimaVenda).slice(0, 10)
          : null,
      }));
    } catch (e) {
      this.logger.error(`getParados falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * HEATMAP REF Ã— LOJA â€” matriz de estoque pra visualizaÃ§Ã£o cruzada.
   * Pega top N REFs com maior estoque total (rede) e mostra distribuiÃ§Ã£o
   * por loja. Ãštil pra decidir realinhamento manualmente.
   *
   * Retorna `{ refs: [{refCode, descricao, totalRede}], lojas: [storeCode],
   *   matrix: { [refCode]: { [storeCode]: qtd } } }`
   */
  async getHeatmap(input: {
    plusSize?: boolean;
    limitRefs?: number;
  }): Promise<{
    refs: Array<{ refCode: string; descricao: string | null; totalRede: number }>;
    lojas: string[];
    matrix: Record<string, Record<string, number>>;
  }> {
    const empty = { refs: [], lojas: [], matrix: {} };
    if (!this.pool) return empty;
    const limit = Math.max(1, Math.min(50, input.limitRefs || 20));

    // 1. Pega top REFs por estoque total
    const topConds: string[] = ['e.ESTOQUE > 0'];
    if (input.plusSize) {
      topConds.push("(COALESCE(p.PLUS_SIZE, 0) > 0 OR UPPER(COALESCE(p.DESCRICAOCOMPLETA, '')) LIKE '%PLUS SIZE%')");
    }
    const topSql = `
      SELECT p.REF AS refCode,
             MAX(p.DESCRICAOCOMPLETA) AS descricao,
             SUM(e.ESTOQUE) AS totalRede
        FROM estoque e
        INNER JOIN produtos p ON p.CODIGO = e.CODIGO
       WHERE ${topConds.join(' AND ')}
         AND p.REF IS NOT NULL AND p.REF <> ''
       GROUP BY p.REF
       ORDER BY totalRede DESC
       LIMIT ?
    `;
    try {
      const [topRows] = await this.pool.query<mysql.RowDataPacket[]>(topSql, [limit]);
      const refs = (topRows as any[]).map((r) => ({
        refCode: String(r.refCode).trim(),
        descricao: r.descricao ? String(r.descricao).trim() : null,
        totalRede: Number(r.totalRede) || 0,
      }));
      if (!refs.length) return empty;

      const refCodes = refs.map((r) => r.refCode);

      // 2. DistribuiÃ§Ã£o por loja dessas REFs
      const distSql = `
        SELECT p.REF AS refCode,
               e.LOJA AS storeCode,
               SUM(e.ESTOQUE) AS qtd
          FROM estoque e
          INNER JOIN produtos p ON p.CODIGO = e.CODIGO
         WHERE p.REF IN (?)
           AND e.ESTOQUE > 0
         GROUP BY p.REF, e.LOJA
      `;
      const [distRows] = await this.pool.query<mysql.RowDataPacket[]>(distSql, [refCodes]);

      const matrix: Record<string, Record<string, number>> = {};
      const lojasSet = new Set<string>();
      for (const ref of refs) matrix[ref.refCode] = {};
      for (const r of distRows as any[]) {
        const ref = String(r.refCode).trim();
        const code = String(r.storeCode).trim();
        const qtd = Number(r.qtd) || 0;
        if (!matrix[ref]) matrix[ref] = {};
        matrix[ref][code] = qtd;
        lojasSet.add(code);
      }
      const lojas = Array.from(lojasSet).sort();
      return { refs, lojas, matrix };
    } catch (e) {
      this.logger.error(`getHeatmap falhou: ${(e as Error).message}`);
      return empty;
    }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // TRIAGEM DO PROVADOR â€” auxiliares
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Resolve um SKU (CODIGO Giga) pra dados completos do produto.
   *
   * Tolerante a zeros Ã  esquerda e EANs:
   *   1. Tenta CODIGO exato
   *   2. Se nÃ£o achar, tenta variantes com padding zero (5, 6, 7, 8, 13, 14 dÃ­gitos)
   *   3. Se nÃ£o achar, delega pra findSkuByAnyEan (procura em EAN13, EAN, CODBARRAS, etc)
   *
   * Retorna null se nada bater.
   */
  async resolveSkuInfo(sku: string): Promise<{
    codigo: string;
    ref: string | null;
    cor: string | null;
    tamanho: string | null;
    descricao: string | null;
  } | null> {
    // Wrapper bulletproof â€” NUNCA propaga erro pra cima.
    // Qualquer erro de conexÃ£o / timeout / SQL â†’ loga + retorna null.
    // Caller (triage, etc) trata null como "produto nÃ£o cadastrado" e mostra
    // mensagem amigÃ¡vel em vez de 500.
    try {
      return await this._resolveSkuInfoInner(sku);
    } catch (e: any) {
      this.logger.error(`[resolveSkuInfo] erro fatal nÃ£o tratado pra "${sku}": ${e?.message || e}`);
      return null;
    }
  }

  private async _resolveSkuInfoInner(sku: string): Promise<{
    codigo: string;
    ref: string | null;
    cor: string | null;
    tamanho: string | null;
    descricao: string | null;
  } | null> {
    if (!this.pool) return null;
    const s = String(sku || '').trim();
    if (!s) return null;

    // Helper: query produtos por CODIGO exato (com lista de candidatos).
    // Usa sÃ³ DESCRICAOCOMPLETA (DESCRICAO nÃ£o existe no Giga).
    // Captura erro pra nÃ£o derrubar a chain inteira (erros transitÃ³rios de MySQL
    // viravam 500 no /triage/suggest quando bipava EAN13).
    const tryCodigos = async (candidates: string[]): Promise<any | null> => {
      if (!candidates.length) return null;
      try {
        const [rows] = await this.pool!.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO AS codigo,
                  REF AS ref,
                  COR AS cor,
                  TAMANHO AS tamanho,
                  DESCRICAOCOMPLETA AS descricao
             FROM produtos
            WHERE CODIGO IN (?)
            LIMIT 1`,
          [candidates],
        );
        return (rows as any[])[0] || null;
      } catch (e: any) {
        this.logger.warn(`resolveSkuInfo tryCodigos falhou: ${e?.message || e}`);
        return null;
      }
    };

    // 1. Tenta exato + variantes com zero-padding comuns
    const variants = new Set<string>([s]);
    const stripped = s.replace(/^0+/, '');
    if (stripped) variants.add(stripped);
    if (/^\d+$/.test(s)) {
      // Padding completo de 3 atÃ© 14 dÃ­gitos (cobre qualquer formato Giga)
      for (let len = 3; len <= 14; len++) {
        if (s.length < len) variants.add(s.padStart(len, '0'));
      }
    }
    const list = Array.from(variants);

    let row = await tryCodigos(list);

    // 2. Fallback: tenta achar via colunas de EAN/barcode
    if (!row) {
      try {
        const codigoEncontrado = await this.findSkuByAnyEan(s);
        if (codigoEncontrado) {
          row = await tryCodigos([codigoEncontrado]);
        }
      } catch (e) {
        this.logger.warn(`resolveSkuInfo fallback EAN: ${(e as Error).message}`);
      }
    }

    if (!row) {
      this.logger.warn(`resolveSkuInfo: SKU "${s}" nÃ£o bateu nem com variantes nem com EANs`);
      return null;
    }
    return {
      codigo: String(row.codigo).trim(),
      ref: row.ref ? String(row.ref).trim() : null,
      cor: row.cor ? String(row.cor).trim() : null,
      tamanho: row.tamanho ? String(row.tamanho).trim() : null,
      descricao: row.descricao ? String(row.descricao).trim() : null,
    };
  }

  /**
   * DiagnÃ³stico de SKU bipado quando resolveSkuInfo retorna null.
   * Retorna sample de produtos com CODIGO/REF/DESCRICAO contendo o termo,
   * pra identificar como o "17" realmente aparece no Giga.
   */
  async diagnoseSku(sku: string): Promise<{
    sku: string;
    variantsTried: string[];
    matchesByCodigo: Array<{ codigo: string; ref: string | null; descricao: string | null }>;
    matchesByRef: Array<{ codigo: string; ref: string | null; descricao: string | null }>;
    matchesByEan: Array<{ codigo: string; ref: string | null; descricao: string | null; matchedColumn?: string }>;
    matchesByDescricao: Array<{ codigo: string; ref: string | null; descricao: string | null }>;
  }> {
    const empty = {
      sku,
      variantsTried: [],
      matchesByCodigo: [],
      matchesByRef: [],
      matchesByEan: [],
      matchesByDescricao: [],
    };
    if (!this.pool) return empty;
    const s = String(sku || '').trim();
    if (!s) return empty;

    // Variantes que seriam testadas pelo resolveSkuInfo
    const variants = new Set<string>([s]);
    const stripped = s.replace(/^0+/, '');
    if (stripped) variants.add(stripped);
    if (/^\d+$/.test(s)) {
      for (let len = 3; len <= 14; len++) {
        if (s.length < len) variants.add(s.padStart(len, '0'));
      }
    }
    const variantsTried = Array.from(variants);

    // Busca LIKE %sku% em CODIGO
    let matchesByCodigo: any[] = [];
    let matchesByRef: any[] = [];
    let matchesByDescricao: any[] = [];
    let matchesByEan: any[] = [];

    try {
      const [r1] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO, REF, DESCRICAOCOMPLETA AS descricao
           FROM produtos WHERE CODIGO LIKE ? LIMIT 10`,
        [`%${s}%`],
      );
      matchesByCodigo = (r1 as any[]).map((r) => ({
        codigo: String(r.CODIGO).trim(),
        ref: r.REF ? String(r.REF).trim() : null,
        descricao: r.descricao ? String(r.descricao).trim() : null,
      }));
    } catch (e) {
      this.logger.warn(`diagnoseSku CODIGO LIKE: ${(e as Error).message}`);
    }

    try {
      const [r2] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO, REF, DESCRICAOCOMPLETA AS descricao
           FROM produtos WHERE REF LIKE ? LIMIT 10`,
        [`%${s}%`],
      );
      matchesByRef = (r2 as any[]).map((r) => ({
        codigo: String(r.CODIGO).trim(),
        ref: r.REF ? String(r.REF).trim() : null,
        descricao: r.descricao ? String(r.descricao).trim() : null,
      }));
    } catch (e) {
      this.logger.warn(`diagnoseSku REF LIKE: ${(e as Error).message}`);
    }

    // Procura nas colunas de EAN (exato com variantes)
    const eanColumns = ['EAN13', 'EAN', 'CODBARRAS', 'CODIGOBARRAS', 'COD_BARRAS', 'CODIGO_BARRAS'];
    for (const col of eanColumns) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO, REF, DESCRICAOCOMPLETA AS descricao
             FROM produtos WHERE \`${col}\` IN (?) LIMIT 5`,
          [variantsTried],
        );
        for (const r of rows as any[]) {
          matchesByEan.push({
            codigo: String(r.CODIGO).trim(),
            ref: r.REF ? String(r.REF).trim() : null,
            descricao: r.descricao ? String(r.descricao).trim() : null,
            matchedColumn: col,
          });
        }
      } catch {
        // coluna nÃ£o existe â€” ignora
      }
    }

    // Busca por descriÃ§Ã£o parcial (Ãºltimo recurso)
    if (s.length >= 3) {
      try {
        const [r4] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO, REF, DESCRICAOCOMPLETA AS descricao
             FROM produtos WHERE COALESCE(DESCRICAOCOMPLETA, DESCRICAO) LIKE ? LIMIT 5`,
          [`%${s}%`],
        );
        matchesByDescricao = (r4 as any[]).map((r) => ({
          codigo: String(r.CODIGO).trim(),
          ref: r.REF ? String(r.REF).trim() : null,
          descricao: r.descricao ? String(r.descricao).trim() : null,
        }));
      } catch {
        /* noop */
      }
    }

    return {
      sku: s,
      variantsTried,
      matchesByCodigo,
      matchesByRef,
      matchesByEan,
      matchesByDescricao,
    };
  }

  /**
   * Busca direta no Giga pelo CODIGO de uma combinaÃ§Ã£o REF + cor + tamanho.
   * Tolerante a TRIM, case e variaÃ§Ãµes de espaÃ§o.
   *
   * Uso: na hora de fechar uma remessa de realinhamento, pegamos
   * REF/COR/TAM do TransferOrder e precisamos do CODIGO pra dar baixa
   * em estoque. Esse mÃ©todo resolve isso direto sem depender de searchByRef.
   *
   * Tenta em ordem:
   *   1. Match exato (case-insensitive + trim)
   *   2. Match com LIKE (cobre variaÃ§Ãµes tipo "BEGE" vs "XADREZ BEGE")
   *   3. Match sÃ³ por REF + tamanho (ignora cor â€” fallback)
   */
  async findCodigoByRefCorTam(
    refCode: string,
    cor: string | null,
    tamanho: string | null,
  ): Promise<string | null> {
    if (!this.pool || !refCode) return null;
    const ref = String(refCode).trim();
    const corClean = (cor || '').trim();
    const tamClean = (tamanho || '').trim();

    // âš  Quando Wincred tem DUPLICIDADE (mesma REF+COR+TAM cadastrada em 2
    // CODIGOs distintos, ex: produto re-cadastrado com preÃ§o novo), a query
    // anterior fazia LIMIT 1 sem ORDER BY â†’ pegava ALEATÃ“RIO, frequentemente
    // o CODIGO sem estoque â†’ app mostrava "sem estoque" e baixava SKU errado.
    //
    // FIX: JOIN com tabela `estoque`, GROUP BY CODIGO, ORDER BY estoque DESC
    // (CODIGO com estoque > 0 ganha; empate â†’ mais novo via CODIGO DESC).

    // 1. Match exato (com priorizaÃ§Ã£o por estoque)
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT p.CODIGO, COALESCE(SUM(e.ESTOQUE), 0) AS TOTAL_EST
          FROM produtos p
          LEFT JOIN estoque e ON e.CODIGO = p.CODIGO
          WHERE TRIM(UPPER(p.REF)) = TRIM(UPPER(?))
            AND TRIM(UPPER(COALESCE(p.COR, ''))) = TRIM(UPPER(?))
            AND TRIM(UPPER(COALESCE(p.TAMANHO, ''))) = TRIM(UPPER(?))
          GROUP BY p.CODIGO
          ORDER BY TOTAL_EST DESC, p.CODIGO DESC
          LIMIT 1`,
        [ref, corClean, tamClean],
      );
      if ((rows as any[]).length) {
        return String((rows as any[])[0].CODIGO).trim();
      }
    } catch (e) {
      this.logger.warn(`findCodigoByRefCorTam exato falhou: ${(e as Error).message}`);
    }

    // 2. Tenta com cor LIKE (pra casos "BEGE" vs "XADREZ BEGE")
    if (corClean) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT p.CODIGO, COALESCE(SUM(e.ESTOQUE), 0) AS TOTAL_EST
            FROM produtos p
            LEFT JOIN estoque e ON e.CODIGO = p.CODIGO
            WHERE TRIM(UPPER(p.REF)) = TRIM(UPPER(?))
              AND UPPER(p.COR) LIKE UPPER(?)
              AND TRIM(UPPER(COALESCE(p.TAMANHO, ''))) = TRIM(UPPER(?))
            GROUP BY p.CODIGO
            ORDER BY TOTAL_EST DESC, p.CODIGO DESC
            LIMIT 1`,
          [ref, `%${corClean}%`, tamClean],
        );
        if ((rows as any[]).length) {
          return String((rows as any[])[0].CODIGO).trim();
        }
        // Tenta o reverso (cor cadastrada estÃ¡ dentro da bipada)
        const [rows2] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT p.CODIGO, COALESCE(SUM(e.ESTOQUE), 0) AS TOTAL_EST
            FROM produtos p
            LEFT JOIN estoque e ON e.CODIGO = p.CODIGO
            WHERE TRIM(UPPER(p.REF)) = TRIM(UPPER(?))
              AND ? LIKE CONCAT('%', UPPER(p.COR), '%')
              AND TRIM(UPPER(COALESCE(p.TAMANHO, ''))) = TRIM(UPPER(?))
            GROUP BY p.CODIGO
            ORDER BY TOTAL_EST DESC, p.CODIGO DESC
            LIMIT 1`,
          [ref, corClean.toUpperCase(), tamClean],
        );
        if ((rows2 as any[]).length) {
          return String((rows2 as any[])[0].CODIGO).trim();
        }
      } catch (e) {
        this.logger.warn(`findCodigoByRefCorTam LIKE falhou: ${(e as Error).message}`);
      }
    }

    // 3. Ãšltimo fallback: sÃ³ REF + tamanho (ignora cor)
    if (tamClean) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT p.CODIGO, COALESCE(SUM(e.ESTOQUE), 0) AS TOTAL_EST
            FROM produtos p
            LEFT JOIN estoque e ON e.CODIGO = p.CODIGO
            WHERE TRIM(UPPER(p.REF)) = TRIM(UPPER(?))
              AND TRIM(UPPER(COALESCE(p.TAMANHO, ''))) = TRIM(UPPER(?))
            GROUP BY p.CODIGO
            ORDER BY TOTAL_EST DESC, p.CODIGO DESC
            LIMIT 1`,
          [ref, tamClean],
        );
        if ((rows as any[]).length) {
          this.logger.warn(
            `findCodigoByRefCorTam: usando fallback REF+TAM (cor "${corClean}" ignorada) pra ${ref}/${tamClean}`,
          );
          return String((rows as any[])[0].CODIGO).trim();
        }
      } catch (e) {
        this.logger.warn(`findCodigoByRefCorTam fallback falhou: ${(e as Error).message}`);
      }
    }

    // 4. Variante de cor com REF SUFIXADA (padrão Lurd's: 900658 = OFF WHITE,
    //    900658M = MOSTARDA — mesma peça, cor cadastrada estendendo a REF).
    //    A grade da live já junta por prefixo (fix 073db40); a entrada de
    //    remessa caía aqui: "900881 OFF WHITE/46" não existe como REF 900881,
    //    está numa irmã "900881X". Busca REF^[A-Z]+$ exigindo TAMANHO exato e
    //    COR batendo (exato ou contido) — sem cor não arrisca, falha explícito.
    if (corClean && tamClean) {
      try {
        // Sufixo pode vir com separador ("900881M", "900881-M", "900881 M").
        // Cor compara SEM espaços/hífens dos dois lados ("OFF WHITE" casa
        // "OFF-WHITE"/"OFFWHITE") — grafia varia entre cadastros irmãos.
        const refRegexp = `^${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[- ]?[A-Z]+$`;
        const corSquash = corClean.toUpperCase().replace(/[\s-]/g, '');
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT p.CODIGO, p.REF, COALESCE(SUM(e.ESTOQUE), 0) AS TOTAL_EST
            FROM produtos p
            LEFT JOIN estoque e ON e.CODIGO = p.CODIGO
            WHERE p.REF REGEXP ?
              AND TRIM(UPPER(COALESCE(p.TAMANHO, ''))) = TRIM(UPPER(?))
              AND (
                REPLACE(REPLACE(UPPER(COALESCE(p.COR, '')), ' ', ''), '-', '') = ?
                OR REPLACE(REPLACE(UPPER(COALESCE(p.COR, '')), ' ', ''), '-', '') LIKE ?
                OR ? LIKE CONCAT('%', REPLACE(REPLACE(UPPER(COALESCE(p.COR, '')), ' ', ''), '-', ''), '%')
              )
            GROUP BY p.CODIGO, p.REF
            ORDER BY TOTAL_EST DESC, p.CODIGO DESC
            LIMIT 1`,
          [refRegexp, tamClean, corSquash, `%${corSquash}%`, corSquash],
        );
        if ((rows as any[]).length) {
          this.logger.warn(
            `findCodigoByRefCorTam: resolvido via REF irmã sufixada ${(rows as any[])[0].REF} pra ${ref} ${corClean}/${tamClean}`,
          );
          return String((rows as any[])[0].CODIGO).trim();
        }
      } catch (e) {
        this.logger.warn(`findCodigoByRefCorTam sufixo falhou: ${(e as Error).message}`);
      }
    }

    this.logger.warn(`findCodigoByRefCorTam: NADA encontrado pra REF=${ref} COR=${corClean} TAM=${tamClean}`);
    return null;
  }

  /**
   * Batch lookup: pra um conjunto de items (refCode/cor/tamanho), retorna mapa
   * `${ref}|${cor}|${tam}` (normalizado upper+trim) -> CODIGO em UMA query SQL.
   *
   * Usado pelo bipe de entrada de remessa pra evitar N queries MySQL por bipe
   * (antes: 1 query por item da remessa = 100+ queries; agora: 1 query total).
   */
  async batchFindCodigosByRefCorTam(
    items: Array<{ refCode: string; cor?: string | null; tamanho?: string | null }>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.pool || !items.length) return out;

    const norm = (s: any) => String(s ?? '').trim().toUpperCase();
    const stripZeros = (s: string) => s.replace(/^0+/, '') || '0';
    const keyOf = (ref: string, cor: any, tam: any) => `${norm(ref)}|${norm(cor)}|${norm(tam)}`;

    // TOLERANCIA DE ZEROS A ESQUERDA NA REF:
    // Giga pode ter REF "012467" e TransferOrder ter "12467" (ou vice-versa).
    // Match exato falha. Geramos variantes de padding e usamos IN().
    const refVariants = (ref: string): string[] => {
      const core = stripZeros(ref);
      const vs = new Set<string>();
      vs.add(ref);
      vs.add(core);
      for (let i = 1; i <= 3; i++) vs.add('0'.repeat(i) + core);
      return Array.from(vs);
    };

    const seen = new Set<string>();
    const uniq: Array<{ ref: string; refCore: string; cor: string; tam: string }> = [];
    for (const it of items) {
      const ref = norm(it.refCode);
      if (!ref) continue;
      const cor = norm(it.cor);
      const tam = norm(it.tamanho);
      const k = `${ref}|${cor}|${tam}`;
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push({ ref, refCore: stripZeros(ref), cor, tam });
    }
    if (!uniq.length) return out;

    // refCore â†’ items originais com essa core (pode haver vÃ¡rios com cor/tam diferentes)
    const byRefCore = new Map<string, typeof uniq>();
    for (const u of uniq) {
      const arr = byRefCore.get(u.refCore) || [];
      arr.push(u);
      byRefCore.set(u.refCore, arr);
    }

    const chunks: typeof uniq[] = [];
    for (let i = 0; i < uniq.length; i += 500) chunks.push(uniq.slice(i, i + 500));

    // âš  DUPLICIDADE NO WINCRED: mesma REF+COR+TAM pode ter 2 CODIGOs diferentes
    // (cadastro repetido por mudanÃ§a de preÃ§o, etc). Selecionamos o CODIGO com
    // MAIOR estoque consolidado â€” desempate por CODIGO DESC (mais novo).
    //
    // Score por (refCore|cor|tam): { codigo, totalEst } â€” guarda o melhor.
    const bestByKey = new Map<string, { codigo: string; totalEst: number }>();

    for (const chunk of chunks) {
      const conds = chunk
        .map(() => `(TRIM(UPPER(p.REF)) IN (?,?,?,?,?) AND TRIM(UPPER(COALESCE(p.COR,''))) = ? AND TRIM(UPPER(COALESCE(p.TAMANHO,''))) = ?)`)
        .join(' OR ');
      const params: string[] = [];
      for (const u of chunk) {
        const vs = refVariants(u.ref);
        const padded = [...vs];
        while (padded.length < 5) padded.push(vs[0]);
        params.push(padded[0], padded[1], padded[2], padded[3], padded[4], u.cor, u.tam);
      }
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT p.REF, COALESCE(p.COR,'') AS COR, COALESCE(p.TAMANHO,'') AS TAMANHO, p.CODIGO,
                  COALESCE((SELECT SUM(e.ESTOQUE) FROM estoque e WHERE e.CODIGO = p.CODIGO), 0) AS TOTAL_EST
            FROM produtos p
            WHERE ${conds}`,
          params,
        );
        // Mapeia REF do Giga (possivelmente com zeros) de volta pra REF do input via refCore
        for (const r of rows as any[]) {
          const refGiga = norm(r.REF);
          const refCore = stripZeros(refGiga);
          const cor = norm(r.COR);
          const tam = norm(r.TAMANHO);
          const totalEst = Number(r.TOTAL_EST) || 0;
          const codigo = String(r.CODIGO).trim();
          const matches = byRefCore.get(refCore) || [];
          for (const m of matches) {
            if (m.cor === cor && m.tam === tam) {
              const k = keyOf(m.ref, m.cor, m.tam);
              const cur = bestByKey.get(k);
              // Prefere mais estoque; empate â†’ CODIGO numericamente maior (mais novo).
              if (
                !cur ||
                totalEst > cur.totalEst ||
                (totalEst === cur.totalEst && Number(codigo) > Number(cur.codigo))
              ) {
                bestByKey.set(k, { codigo, totalEst });
              }
            }
          }
        }
      } catch (e: any) {
        this.logger.warn(`batchFindCodigosByRefCorTam falhou em chunk: ${e?.message || e}`);
      }
    }
    for (const [k, v] of bestByKey.entries()) out.set(k, v.codigo);
    return out;
  }

  /**
   * Variante do batchFindCodigosByRefCorTam que retorna TODOS os CODIGOs
   * candidatos pra cada (REF+COR+TAM) â€” nÃ£o sÃ³ o "melhor" com mais estoque.
   *
   * USADO ESPECIFICAMENTE NO BIPE DE REMESSA: quando vendedora bipa o cÃ³digo
   * de barras da peÃ§a fÃ­sica que chegou, esse cÃ³digo pode ser QUALQUER um
   * dos cadastros duplicados no Wincred â€” nÃ£o necessariamente o que tem mais
   * estoque. Por isso precisamos comparar com TODOS os candidatos.
   *
   * Retorna Map onde a chave Ã© `${ref}|${cor}|${tam}` (norm) e o valor Ã©
   * um Set de CODIGOs (todos os cadastros pra essa combinaÃ§Ã£o).
   */
  async batchFindAllCodigosByRefCorTam(
    items: Array<{ refCode: string; cor?: string | null; tamanho?: string | null }>,
  ): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    if (!this.pool || !items.length) return out;

    const norm = (s: any) => String(s ?? '').trim().toUpperCase();
    const stripZeros = (s: string) => s.replace(/^0+/, '') || '0';
    const keyOf = (ref: string, cor: any, tam: any) => `${norm(ref)}|${norm(cor)}|${norm(tam)}`;

    const refVariants = (ref: string): string[] => {
      const core = stripZeros(ref);
      const vs = new Set<string>();
      vs.add(ref);
      vs.add(core);
      for (let i = 1; i <= 3; i++) vs.add('0'.repeat(i) + core);
      return Array.from(vs);
    };

    const seen = new Set<string>();
    const uniq: Array<{ ref: string; refCore: string; cor: string; tam: string }> = [];
    for (const it of items) {
      const ref = norm(it.refCode);
      if (!ref) continue;
      const cor = norm(it.cor);
      const tam = norm(it.tamanho);
      const k = `${ref}|${cor}|${tam}`;
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push({ ref, refCore: stripZeros(ref), cor, tam });
    }
    if (!uniq.length) return out;

    const byRefCore = new Map<string, typeof uniq>();
    for (const u of uniq) {
      const arr = byRefCore.get(u.refCore) || [];
      arr.push(u);
      byRefCore.set(u.refCore, arr);
    }

    const chunks: typeof uniq[] = [];
    for (let i = 0; i < uniq.length; i += 500) chunks.push(uniq.slice(i, i + 500));

    for (const chunk of chunks) {
      const conds = chunk
        .map(() => `(TRIM(UPPER(REF)) IN (?,?,?,?,?) AND TRIM(UPPER(COALESCE(COR,''))) = ? AND TRIM(UPPER(COALESCE(TAMANHO,''))) = ?)`)
        .join(' OR ');
      const params: string[] = [];
      for (const u of chunk) {
        const vs = refVariants(u.ref);
        const padded = [...vs];
        while (padded.length < 5) padded.push(vs[0]);
        params.push(padded[0], padded[1], padded[2], padded[3], padded[4], u.cor, u.tam);
      }
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT REF, COALESCE(COR,'') AS COR, COALESCE(TAMANHO,'') AS TAMANHO, CODIGO
            FROM produtos WHERE ${conds}`,
          params,
        );
        for (const r of rows as any[]) {
          const refGiga = norm(r.REF);
          const refCore = stripZeros(refGiga);
          const cor = norm(r.COR);
          const tam = norm(r.TAMANHO);
          const codigo = String(r.CODIGO).trim();
          const matches = byRefCore.get(refCore) || [];
          for (const m of matches) {
            if (m.cor === cor && m.tam === tam) {
              const k = keyOf(m.ref, m.cor, m.tam);
              if (!out.has(k)) out.set(k, new Set());
              out.get(k)!.add(codigo);
            }
          }
        }
      } catch (e: any) {
        this.logger.warn(`batchFindAllCodigosByRefCorTam falhou em chunk: ${e?.message || e}`);
      }
    }
    return out;
  }

  /**
   * Soma estoque de TODOS os SKUs cadastrados como mesma REF+COR+TAM em UMA loja.
   *
   * Por que isso existe: o Giga frequentemente tem mÃºltiplos cadastros pra
   * exatamente a mesma peÃ§a (mesma REF+COR+TAM) com CODIGOs diferentes â€” porque
   * cada peÃ§a fÃ­sica entrou com etiqueta Ãºnica (legado de cadastros manuais).
   *
   * `findCodigoByRefCorTam` retorna sÃ³ UM SKU (LIMIT 1). Se esse SKU estÃ¡ zerado
   * em estoque mas OUTRO SKU da mesma peÃ§a tem estoque, a peÃ§a FÃSICA existe na
   * loja mas o sistema acha que nÃ£o tem. Esse mÃ©todo resolve isso somando todos.
   *
   * Caso real (Lurd's): "13015 MARINHO 50" tem CODIGOs 5383672 e 5383665 cadastrados;
   * o precheck pegava o zerado e bloqueava a remessa mesmo tendo a peÃ§a fÃ­sica.
   */
  /**
   * Inspeciona indices de uma tabela do Giga. Retorna lista de indices com
   * suas colunas e tipo. Usado pra diagnostico antes de criar indice novo
   * (idempotencia + transparencia pra admin).
   */
  async inspectTableIndexes(table: string): Promise<{
    table: string;
    indexes: Array<{ name: string; columns: string[]; unique: boolean; type: string }>;
    error?: string;
  }> {
    if (!this.pool) return { table, indexes: [], error: 'Pool ERP nao inicializado' };
    const safeTable = String(table).replace(/[^a-zA-Z0-9_]/g, '');
    if (!safeTable) return { table, indexes: [], error: 'Nome de tabela invalido' };
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SHOW INDEX FROM \`${safeTable}\``,
      );
      // Agrupa por Key_name (cada indice pode ter N colunas)
      const byKey = new Map<string, { name: string; columns: Array<{ seq: number; col: string }>; unique: boolean; type: string }>();
      for (const r of rows as any[]) {
        const name = String(r.Key_name);
        const unique = Number(r.Non_unique) === 0;
        const type = String(r.Index_type || 'BTREE');
        const col = String(r.Column_name);
        const seq = Number(r.Seq_in_index) || 1;
        if (!byKey.has(name)) byKey.set(name, { name, columns: [], unique, type });
        byKey.get(name)!.columns.push({ seq, col });
      }
      const indexes = Array.from(byKey.values()).map((k) => ({
        name: k.name,
        unique: k.unique,
        type: k.type,
        columns: k.columns.sort((a, b) => a.seq - b.seq).map((c) => c.col),
      }));
      return { table: safeTable, indexes };
    } catch (e: any) {
      return { table: safeTable, indexes: [], error: e?.message || String(e) };
    }
  }

  /**
   * BATCH do getStockByRefCorTamInStore â€” em vez de N round-trips, faz tudo
   * em 2 queries (produtos + estoque). Usado pelo precheck de remessa pra
   * evitar loop serial.
   *
   * Retorna Map<key, { totalQty, codigos }> onde key = `${refCode}::${cor}::${tamanho}::${storeCode}`
   */
  async getStockByRefCorTamInStoreBatch(
    items: Array<{ refCode: string; cor: string | null; tamanho: string | null; storeCode: string }>,
  ): Promise<Map<string, { totalQty: number; codigos: string[] }>> {
    const out = new Map<string, { totalQty: number; codigos: string[] }>();
    if (!this.pool || !items?.length) return out;

    const makeKey = (refCode: string, cor: string | null, tamanho: string | null, storeCode: string) =>
      `${String(refCode).trim().toUpperCase()}::${String(cor || '').trim().toUpperCase()}::${String(tamanho || '').trim().toUpperCase()}::${String(storeCode).trim()}`;

    try {
      // 1) Coleta TODAS combinacoes unicas de REF+COR+TAM (independente de loja)
      const uniqRefCorTam = new Map<string, { refCode: string; cor: string; tamanho: string }>();
      for (const it of items) {
        const ref = String(it.refCode).trim();
        const cor = String(it.cor || '').trim();
        const tam = String(it.tamanho || '').trim();
        const k = `${ref.toUpperCase()}::${cor.toUpperCase()}::${tam.toUpperCase()}`;
        if (!uniqRefCorTam.has(k)) uniqRefCorTam.set(k, { refCode: ref, cor, tamanho: tam });
      }

      // 2) Resolve CODIGOs de cada combinacao via 1 query batch em produtos
      // TOLERANCIA DE ZEROS A ESQUERDA NA REF: Giga pode ter REF "012467"
      // mas input "12467" (ou vice-versa). Gera variantes e usa IN().
      const stripZeros = (s: string) => s.replace(/^0+/, '') || '0';
      const refVariants = (ref: string): string[] => {
        const core = stripZeros(ref);
        const vs = new Set<string>();
        vs.add(ref);
        vs.add(core);
        for (let i = 1; i <= 3; i++) vs.add('0'.repeat(i) + core);
        return Array.from(vs);
      };

      const orParts: string[] = [];
      const orParams: any[] = [];
      for (const { refCode, cor, tamanho } of uniqRefCorTam.values()) {
        const refUp = String(refCode).trim().toUpperCase();
        const vs = refVariants(refUp);
        const padded = [...vs];
        while (padded.length < 5) padded.push(vs[0]);
        orParts.push(
          `(TRIM(UPPER(REF)) IN (?,?,?,?,?) AND TRIM(UPPER(COALESCE(COR,''))) = TRIM(UPPER(?)) AND TRIM(UPPER(COALESCE(TAMANHO,''))) = TRIM(UPPER(?)))`,
        );
        orParams.push(padded[0], padded[1], padded[2], padded[3], padded[4], cor, tamanho);
      }
      const [prodRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT REF, COALESCE(COR,'') AS COR, COALESCE(TAMANHO,'') AS TAMANHO, CODIGO FROM produtos WHERE ${orParts.join(' OR ')}`,
        orParams,
      );

      // Mapeia input por refCore pra reconectar com REF do Giga
      const inputByRefCore = new Map<string, Array<{ ref: string; cor: string; tam: string }>>();
      for (const { refCode, cor, tamanho } of uniqRefCorTam.values()) {
        const refUp = String(refCode).trim().toUpperCase();
        const refCore = stripZeros(refUp);
        const corUp = String(cor).trim().toUpperCase();
        const tamUp = String(tamanho).trim().toUpperCase();
        const arr = inputByRefCore.get(refCore) || [];
        arr.push({ ref: refUp, cor: corUp, tam: tamUp });
        inputByRefCore.set(refCore, arr);
      }

      // refCorTamKey (do input) â†’ Set<codigoBase>
      const refCorTamToCodigos = new Map<string, Set<string>>();
      for (const r of prodRows as any[]) {
        const refGiga = String(r.REF || '').trim().toUpperCase();
        const refCore = stripZeros(refGiga);
        const cor = String(r.COR || '').trim().toUpperCase();
        const tam = String(r.TAMANHO || '').trim().toUpperCase();
        const codigo = String(r.CODIGO || '').trim();
        if (!codigo) continue;
        const candidates = inputByRefCore.get(refCore) || [];
        for (const cand of candidates) {
          if (cand.cor === cor && cand.tam === tam) {
            const k = `${cand.ref}::${cor}::${tam}`;
            if (!refCorTamToCodigos.has(k)) refCorTamToCodigos.set(k, new Set());
            refCorTamToCodigos.get(k)!.add(codigo);
          }
        }
      }

      // 3) Expande todas variantes de CODIGOs encontrados
      const allCodigoVariants = new Set<string>();
      const codigoToVariants = new Map<string, string[]>();
      for (const setCodigos of refCorTamToCodigos.values()) {
        for (const codigo of setCodigos) {
          if (!codigoToVariants.has(codigo)) {
            const vs = this.skuVariants(codigo);
            codigoToVariants.set(codigo, vs);
            for (const v of vs) allCodigoVariants.add(v);
          }
        }
      }
      const allStores = Array.from(new Set(items.map((i) => String(i.storeCode).trim())));

      if (allCodigoVariants.size === 0 || allStores.length === 0) {
        // Sem CODIGOs achados â†’ todos os items retornam 0
        for (const it of items) out.set(makeKey(it.refCode, it.cor, it.tamanho, it.storeCode), { totalQty: 0, codigos: [] });
        return out;
      }

      // 4) 1 SELECT batch trazendo TODO estoque relevante (de todos os codigos em todas as lojas)
      const [stockRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO, LOJA, ESTOQUE FROM estoque WHERE CODIGO IN (?) AND LOJA IN (?) AND ESTOQUE > 0`,
        [Array.from(allCodigoVariants), allStores],
      );
      // mapa (codigo-variant, loja) â†’ estoque
      const stockMap = new Map<string, number>();
      for (const r of stockRows as any[]) {
        const codigo = String(r.CODIGO).trim();
        const loja = String(r.LOJA).trim();
        stockMap.set(`${codigo}::${loja}`, Number(r.ESTOQUE) || 0);
      }

      // 5) Pra cada item de input, soma estoque considerando todas variantes dos CODIGOs daquela REF+COR+TAM
      for (const it of items) {
        const refKey = `${String(it.refCode).trim().toUpperCase()}::${String(it.cor || '').trim().toUpperCase()}::${String(it.tamanho || '').trim().toUpperCase()}`;
        const codigosBase = refCorTamToCodigos.get(refKey);
        const storeCode = String(it.storeCode).trim();
        if (!codigosBase || codigosBase.size === 0) {
          out.set(makeKey(it.refCode, it.cor, it.tamanho, it.storeCode), { totalQty: 0, codigos: [] });
          continue;
        }
        let totalQty = 0;
        const codigosUsados: string[] = [];
        for (const codigo of codigosBase) {
          const variants = codigoToVariants.get(codigo) || [codigo];
          for (const v of variants) {
            const qty = stockMap.get(`${v}::${storeCode}`);
            if (qty && qty > 0) {
              totalQty += qty;
            }
          }
          codigosUsados.push(codigo);
        }
        out.set(makeKey(it.refCode, it.cor, it.tamanho, it.storeCode), { totalQty, codigos: codigosUsados });
      }
      return out;
    } catch (e: any) {
      this.logger.warn(`getStockByRefCorTamInStoreBatch falhou: ${e?.message || e}`);
      return out;
    }
  }

  async getStockByRefCorTamInStore(
    refCode: string,
    cor: string | null,
    tamanho: string | null,
    storeCode: string,
  ): Promise<{ totalQty: number; codigos: string[] }> {
    if (!this.pool || !refCode || !storeCode) return { totalQty: 0, codigos: [] };
    const ref = String(refCode).trim();
    const corClean = (cor || '').trim();
    const tamClean = (tamanho || '').trim();

    try {
      // 1) Pega TODOS os CODIGOs cadastrados com essa REF+COR+TAM em produtos
      const [prodRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO FROM produtos
          WHERE TRIM(UPPER(REF)) = TRIM(UPPER(?))
            AND TRIM(UPPER(COALESCE(COR, ''))) = TRIM(UPPER(?))
            AND TRIM(UPPER(COALESCE(TAMANHO, ''))) = TRIM(UPPER(?))`,
        [ref, corClean, tamClean],
      );
      const codigosGiga = Array.from(
        new Set((prodRows as any[]).map((r) => String(r.CODIGO).trim()).filter(Boolean)),
      );
      if (!codigosGiga.length) return { totalQty: 0, codigos: [] };

      // 2) Expande padding (estoque pode ter outras formas: 5383672 e 0005383672)
      const allVariants = new Set<string>();
      for (const c of codigosGiga) {
        for (const v of this.skuVariants(c)) allVariants.add(v);
      }
      const variantsArr = Array.from(allVariants);

      // 3) SUM(ESTOQUE) com filtro >0 â€” mesmo padrÃ£o de getStockBySkusDetailed
      const [stockRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT SUM(ESTOQUE) AS qty FROM estoque
          WHERE CODIGO IN (?)
            AND LOJA = ?
            AND ESTOQUE > 0`,
        [variantsArr, storeCode],
      );
      const totalQty = Math.max(0, Number((stockRows as any[])[0]?.qty ?? 0) || 0);
      return { totalQty, codigos: codigosGiga };
    } catch (e) {
      this.logger.warn(`getStockByRefCorTamInStore falhou: ${(e as Error).message}`);
      return { totalQty: 0, codigos: [] };
    }
  }

  /**
   * Estoque atual de UM SKU especÃ­fico em N lojas. Retorna Map<storeCode, qty>.
   * Lojas sem o SKU (ou com 0) NÃƒO aparecem no map.
   */
  async getStockBySkuAndStores(sku: string, storeCodes: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!sku || !storeCodes.length) return out;
    if (this.mirrorReadsEnabled) {
      try {
        if (await this.mirrorStockReady()) return await this.getStockBySkuAndStoresFromMirror(sku, storeCodes);
      } catch (e) {
        this.logger.warn(`[mirror-reads] getStockBySkuAndStores: ${(e as Error).message} → Giga ao vivo`);
      }
    }
    if (!this.pool) return out;
    const variants = this.skuVariants(sku);
    if (!variants.length) return out;
    try {
      // Soma tudo do SKU (todas as variantes de zero-padding) por loja.
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT LOJA AS storeCode, SUM(ESTOQUE) AS qty
           FROM estoque
          WHERE CODIGO IN (?)
            AND LOJA IN (?)
            AND ESTOQUE > 0
          GROUP BY LOJA`,
        [variants, storeCodes],
      );
      for (const r of rows as any[]) {
        const code = String(r.storeCode).trim();
        const qty = Number(r.qty) || 0;
        if (qty > 0) out.set(code, qty);
      }
      return out;
    } catch (e) {
      this.logger.error(`getStockBySkuAndStores falhou: ${(e as Error).message}`);
      return out;
    }
  }

  /**
   * PDV â€” busca info COMPLETA de produto pra venda (SKU/EAN bipado).
   *
   * Retorna tudo necessÃ¡rio pro carrinho + futuro NFC-e:
   *   sku, ean, ref, cor, tamanho, descricao, preco, ncm, cfop, custo
   *
   * Usa as MESMAS variantes de zero-padding + fallback EAN do resolveSkuInfo.
   * Detecta colunas dinamicamente (PRECO/PRECOVENDA/VALORVENDA, NCM, CFOP, etc).
   */
  async getPdvProductInfo(skuOrEan: string): Promise<{
    sku: string;
    ean: string | null;
    ref: string | null;
    cor: string | null;
    tamanho: string | null;
    descricao: string;
    preco: number;
    ncm: string | null;
    cfop: string | null;
    custo: number | null;
    dataCadastro: string | null;
  } | null> {
    if (!this.pool) return null;
    const s = String(skuOrEan || '').trim();
    if (!s) return null;

    // 1. Resolve SKU (jÃ¡ trata zero-padding + EAN fallback)
    const info = await this.resolveSkuInfo(s);
    if (!info) return null;

    // 2. Descobre colunas disponÃ­veis na tabela produtos
    let priceCols: string[] = [];
    let costCol: string | null = null;
    let ncmCol: string | null = null;
    let cfopCol: string | null = null;
    let eanCol: string | null = null;
    let dataCol: string | null = null;
    let allColumnNames: string[] = [];
    try {
      // Schema da `produtos` é estável — usa o cache de processo (getProductsColumns)
      // em vez de rodar SHOW COLUMNS a CADA bipe (era 1 ida WAN ao Giga por peça).
      const names = await this.getProductsColumns();
      allColumnNames = Array.from(names);

      // PREÃ‡O â€” lista ampla de candidatos comuns + fallback dinÃ¢mico.
      // ORDEM IMPORTA: VENDAUN (Gigasistemas) Ã© o oficial â€” fica primeiro.
      const priceCandidates = [
        'VENDAUN', 'VENDA_UN', 'VENDAUNIT',
        'PRECOVAREJO', 'PRECO_VAREJO', 'VALORVAREJO', 'VALOR_VAREJO',
        'PRECOVENDA', 'PRECO_VENDA', 'VALORVENDA', 'VALOR_VENDA',
        'PRECO1', 'PVENDA', 'PRECO', 'VALOR', 'PRC_VENDA', 'PRECOUNIT',
        'VALOR_UNITARIO', 'PRECOATUAL', 'PRECO_ATUAL',
      ];
      for (const c of priceCandidates) {
        if (names.has(c)) priceCols.push(c);
      }
      // Fallback: qualquer coluna com PREC ou VALOR no nome (que ainda nÃ£o tÃ¡ na lista)
      for (const n of allColumnNames) {
        const upper = n.toUpperCase();
        if (priceCols.includes(upper)) continue;
        if (upper.startsWith('CUSTO') || upper.includes('CUSTO')) continue;
        if (/^(PREC|PRC|VALOR|VL_|VLR_|VEN|VAR)/.test(upper)) {
          priceCols.push(n);
        }
      }
      // Custo
      for (const c of ['CUSTO', 'PRECOCUSTO', 'VALORCUSTO', 'CUSTO_MEDIO', 'CUSTOMEDIO']) {
        if (names.has(c)) { costCol = c; break; }
      }
      // NCM
      for (const c of ['NCM', 'CODIGONCM', 'COD_NCM']) {
        if (names.has(c)) { ncmCol = c; break; }
      }
      // CFOP
      for (const c of ['CFOP', 'CODCFOP', 'CFOP_PADRAO']) {
        if (names.has(c)) { cfopCol = c; break; }
      }
      // EAN
      for (const c of ['EAN13', 'EAN', 'CODBARRAS', 'CODIGOBARRAS', 'COD_BARRAS', 'CODIGO_BARRAS']) {
        if (names.has(c)) { eanCol = c; break; }
      }
      // Data de cadastro (usado pra promoÃ§Ãµes por ano)
      for (const c of ['DATAALT', 'DATACAD', 'DATA_CAD', 'DATACADASTRO', 'DATA_CADASTRO']) {
        if (names.has(c)) { dataCol = c; break; }
      }
      this.logger.debug(
        `[pdv] Cols detectadas: preco=[${priceCols.join('|')}] custo=${costCol} ncm=${ncmCol} cfop=${cfopCol} ean=${eanCol} data=${dataCol}`,
      );
    } catch (e) {
      this.logger.warn(`getPdvProductInfo SHOW COLUMNS: ${(e as Error).message}`);
    }

    // 3. Monta SELECT dinÃ¢mico â€” traz TODAS as colunas de preÃ§o candidatas
    const selects = ['CODIGO AS codigo'];
    priceCols.forEach((c, i) => selects.push(`\`${c}\` AS preco_${i}`));
    if (costCol) selects.push(`\`${costCol}\` AS custo`);
    if (ncmCol) selects.push(`\`${ncmCol}\` AS ncm`);
    if (cfopCol) selects.push(`\`${cfopCol}\` AS cfop`);
    if (eanCol) selects.push(`\`${eanCol}\` AS ean`);
    if (dataCol) selects.push(`\`${dataCol}\` AS dataCadastro`);

    let extra: any = {};
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT ${selects.join(', ')} FROM produtos WHERE CODIGO = ? LIMIT 1`,
        [info.codigo],
      );
      const r = (rows as any[])[0];
      if (r) extra = r;
    } catch (e) {
      this.logger.warn(`getPdvProductInfo extra: ${(e as Error).message}`);
    }

    // Helper: parseia preÃ§o (string com vÃ­rgula vira nÃºmero)
    const parsePrice = (v: any): number => {
      if (v == null) return 0;
      if (typeof v === 'number') return v;
      const s = String(v).trim().replace(/\./g, '').replace(',', '.');
      const n = Number(s);
      return isNaN(n) ? 0 : n;
    };

    // Colunas conhecidas que armazenam preÃ§o em CENTAVOS (precisa dividir por 100)
    // No Giga (Lurd's), VENDAUN Ã© centavos: 25990 = R$ 259,90
    const isCentavos = (col: string): boolean => {
      const u = col.toUpperCase();
      return u === 'VENDAUN' || u === 'VENDA_UN' || u === 'VENDAUNIT';
    };

    // Pega o primeiro preÃ§o > 0 entre os candidatos
    let preco = 0;
    let precoFonte: string | null = null;
    for (let i = 0; i < priceCols.length; i++) {
      let v = parsePrice(extra[`preco_${i}`]);
      if (v > 0) {
        // Se a coluna armazena em centavos, divide por 100
        if (isCentavos(priceCols[i])) v = v / 100;
        preco = v;
        precoFonte = priceCols[i];
        break;
      }
    }

    // PLANO B: se nÃ£o achou preÃ§o em produtos, busca Ãºltimo preÃ§o da tabela `caixa`
    // (Ãºltimo valor unitÃ¡rio praticado pra esse SKU em qualquer loja)
    if (preco <= 0) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT VALORTOTAL / NULLIF(QUANTIDADE, 0) AS unitario
             FROM caixa
            WHERE CODIGO = ?
              AND VALORTOTAL > 0
              AND QUANTIDADE > 0
              AND (MARCADO IS NULL OR MARCADO <> 'SIM')
            ORDER BY DATA DESC
            LIMIT 1`,
          [info.codigo],
        );
        const u = parsePrice((rows as any[])[0]?.unitario);
        if (u > 0) {
          preco = u;
          precoFonte = 'caixa.Ãºltimo_unitÃ¡rio';
          this.logger.log(`[pdv] PreÃ§o de ${info.codigo} via fallback caixa: R$${u.toFixed(2)}`);
        }
      } catch (e) {
        this.logger.warn(`getPdvProductInfo fallback caixa: ${(e as Error).message}`);
      }
    }

    if (preco > 0) {
      this.logger.log(`[pdv] PreÃ§o de ${info.codigo}: R$${preco.toFixed(2)} (fonte: ${precoFonte})`);
    }

    // Normaliza dataCadastro pra YYYY-MM-DD
    let dataCadastro: string | null = null;
    if (extra.dataCadastro) {
      try {
        const d = extra.dataCadastro instanceof Date
          ? extra.dataCadastro
          : new Date(String(extra.dataCadastro));
        if (!isNaN(d.getTime())) {
          dataCadastro = d.toISOString().slice(0, 10);
        }
      } catch { /* noop */ }
    }

    return {
      sku: info.codigo,
      ean: extra.ean ? String(extra.ean).trim() : null,
      ref: info.ref,
      cor: info.cor,
      tamanho: info.tamanho,
      descricao: info.descricao || `${info.ref || info.codigo} ${info.cor || ''} ${info.tamanho || ''}`.trim(),
      preco,
      ncm: extra.ncm ? String(extra.ncm).trim() : null,
      cfop: extra.cfop ? String(extra.cfop).trim() : null,
      custo: extra.custo != null ? parsePrice(extra.custo) : null,
      dataCadastro,
    };
  }

  /**
   * Vendas de uma REF (qualquer cor/tamanho) por loja nos Ãºltimos N dias.
   * Usado pra priorizar destino que mais vende essa REF.
   */
  async getRecentSalesByRefAndStores(
    refCode: string,
    storeCodes: string[],
    days = 30,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.pool || !refCode || !storeCodes.length) return out;
    const n = Math.max(1, Math.min(365, days || 30));
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT c.LOJA AS storeCode, SUM(c.QUANTIDADE) AS qty
           FROM caixa c
           INNER JOIN produtos p ON p.CODIGO = c.CODIGO
          WHERE p.REF = ?
            AND c.LOJA IN (?)
            AND c.DATA >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            AND (c.MARCADO IS NULL OR c.MARCADO <> 'SIM')
          GROUP BY c.LOJA`,
        [refCode, storeCodes, n],
      );
      for (const r of rows as any[]) {
        const code = String(r.storeCode).trim();
        const qty = Number(r.qty) || 0;
        if (qty > 0) out.set(code, qty);
      }
      return out;
    } catch (e) {
      this.logger.error(`getRecentSalesByRefAndStores falhou: ${(e as Error).message}`);
      return out;
    }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // CADASTRO DINÃ‚MICO DE PRODUTOS (Cadastro DinÃ¢mico â†’ Wincred)
  //
  // Usado por /retaguarda/cadastro-produtos. Permite listar grupos,
  // subgrupos, cores, tamanhos, fornecedores existentes e inserir novos
  // produtos na tabela `produtos` (uma linha por combinaÃ§Ã£o corÃ—tamanho).
  // INSERT controlado por ERP_WRITE_ENABLED â€” mesma flag do decreaseStock.
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Lista todos os grupos cadastrados no Wincred.
   * Tabela `grupos` (CODIGO PK + GRUPO nome).
   */
  async listarGrupos(): Promise<Array<{ codigo: number; nome: string }>> {
    if (!this.pool) return [];
    try {
      const [rows] = await this.pool.query(
        `SELECT CODIGO AS codigo, GRUPO AS nome
           FROM grupos
          WHERE CODIGO IS NOT NULL
          ORDER BY GRUPO`,
      );
      return (rows as any[]).map((r) => ({
        codigo: Number(r.codigo),
        nome: String(r.nome || '').trim() || `GRUPO-${r.codigo}`,
      })).filter((g) => g.codigo);
    } catch (e) {
      this.logger.error(`listarGrupos falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Lista subgrupos de um grupo especÃ­fico.
   * Tabela `subgrupos` (CODIGO PK + SUBGRUPO nome + GRUPO FK).
   */
  async listarSubgrupos(grupoCodigo: number): Promise<Array<{ codigo: number; nome: string }>> {
    if (!this.pool) return [];
    try {
      const [rows] = await this.pool.query(
        `SELECT CODIGO AS codigo, SUBGRUPO AS nome
           FROM subgrupos
          WHERE GRUPO = ?
          ORDER BY SUBGRUPO`,
        [grupoCodigo],
      );
      return (rows as any[]).map((r) => ({
        codigo: Number(r.codigo),
        nome: String(r.nome || '').trim() || `SUBGRUPO-${r.codigo}`,
      })).filter((s) => s.codigo);
    } catch (e) {
      this.logger.error(`listarSubgrupos falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * DistribuiÃ§Ã£o de estoque por loja â€” tela de anÃ¡lise pra detectar excessos
   * em algumas lojas e zero em outras pra mesma variaÃ§Ã£o (REF+COR+TAM).
   *
   * CenÃ¡rio tÃ­pico (Lurd's): VLM-222 MARINHO 48 tem 8 em Santos, 0 em
   * Sorocaba/Campinas/Piracicaba. Vendedora em Sorocaba nÃ£o consegue vender
   * pq nÃ£o tem grade. Essa tela mostra essas distorÃ§Ãµes e linka pro
   * realinhamento.
   *
   * CritÃ©rio de criticidade (conforme regra de negÃ³cio):
   *   - ALTO  â†’ alguma loja com 0 E outra com 3+ unidades
   *   - MEDIO â†’ alguma com 0 E outra com 2 unidades
   *   - OK    â†’ distribuÃ­do (sem zero OU sem excesso)
   *
   * @param filters Filtros opcionais. Default: PLUS SIZE only, modo desequilibrado.
   * @returns Lista de variaÃ§Ãµes + lojas (header) + cache hint.
   */
  /**
   * Cache em memoria do getStockDistribution. TTL curto (60s) — estoque
   * muda muito rapido por causa de vendas, mas dentro de 60s e razoavel
   * servir resultado cacheado. Reduz drasticamente carga no MySQL Giga.
   *
   * Chave = JSON estavel dos filtros relevantes. Limpo no Map quando lota
   * (LRU simples: 50 entradas, ejeta a mais antiga).
   */
  private stockDistCache: Map<string, { data: any; ts: number }> = new Map();
  private readonly STOCK_DIST_CACHE_TTL_MS = 60 * 1000;
  private readonly STOCK_DIST_CACHE_MAX = 50;

  private stockDistCacheKey(filters: any): string {
    return JSON.stringify({
      g: filters.grupoCodigo ?? null,
      sg: filters.subgrupoCodigo ?? null,
      s: (filters.search || '').trim().toUpperCase(),
      t: (filters.tamanhos || []).slice().sort().join(','),
      l: (filters.lojas || []).slice().sort().join(','),
      m: filters.mode || 'imbalanced',
      mt: filters.minTotal ?? null,
      lim: filters.limit ?? null,
    });
  }

  async getStockDistribution(filters: {
    grupoCodigo?: number | null;
    subgrupoCodigo?: number | null;
    search?: string | null;
    tamanhos?: string[] | null; // default = plus size
    lojas?: string[] | null;     // default = todas exceto SITE/PF
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
    if (!this.pool) return { rows: [], lojas: [], totalRows: 0, truncated: false };

    // Cache check — 60s TTL. Acelera reaberturas do drawer e cliques rapidos.
    const cacheKey = this.stockDistCacheKey(filters);
    const cached = this.stockDistCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.STOCK_DIST_CACHE_TTL_MS) {
      this.logger.log(`[erp] getStockDistribution CACHE HIT (idade=${Date.now() - cached.ts}ms)`);
      return cached.data;
    }

    const limit = Math.max(50, Math.min(5000, filters.limit || 1500));
    const mode = filters.mode || 'imbalanced';
    // minTotal default = 2 (antes era 3): mostra SKUs com pelo menos 2 peÃ§as
    // somadas na rede. Ajustado a pedido â€” anÃ¡lise faz sentido sÃ³ com 2+ peÃ§as.
    const minTotal = Math.max(0, filters.minTotal ?? 2);

    // Default PLUS SIZE = lista atual do setting (cobre 46-60 + combos)
    const defaultPlusSize = [
      '46', '48', '50', '52', '54', '56', '58', '60',
      '46/48', '48/50', '50/52', '52/54', '54/56', '56/58', '58/60',
    ];
    const tamanhos = (filters.tamanhos && filters.tamanhos.length > 0)
      ? filters.tamanhos.map((t) => t.toUpperCase().trim()).filter(Boolean)
      : defaultPlusSize;

    // Lojas: ignora SITE e PF por padrÃ£o (regra do user)
    const ignoredLojas = new Set(['SITE', 'PF']);

    // â”€â”€ 1) Monta WHERE da query principal â”€â”€
    // CRÃTICO: Wincred tem padding/case inconsistente em TAMANHO ("48 ",
    // "  48", " 48 ", etc). Usar TRIM(UPPER(...)) Ã© o padrÃ£o do sistema.
    // Sem isso, IN ('48') nÃ£o bate com "48 " e a query volta 0 linhas.
    const conds: string[] = [
      `TRIM(UPPER(COALESCE(p.TAMANHO, ''))) IN (${tamanhos.map(() => '?').join(',')})`,
    ];
    const vals: any[] = [...tamanhos];

    // REF pode estar vazia em alguns produtos legados â€” nÃ£o bloqueia, sÃ³
    // nÃ£o vai poder agrupar grade pra eles (mostra como CODIGO solto)
    conds.push("COALESCE(p.REF, '') <> ''");

    if (filters.grupoCodigo) {
      conds.push('p.GRUPO = ?');
      vals.push(filters.grupoCodigo);
    }
    if (filters.subgrupoCodigo) {
      conds.push('p.SUBGRUPO = ?');
      vals.push(filters.subgrupoCodigo);
    }
    if (filters.search?.trim()) {
      const rawSearch = filters.search.trim().toUpperCase();
      // FAST PATH: se search e UMA palavra so e parece REF (ex: "VLM-222"),
      // usa igualdade direta p.REF = ? em vez de LIKE %x%. Isso usa indice
      // (REF normalmente tem indice no Giga) e corta de segundos pra <50ms.
      // Detecta REF: sem espaco + tem ao menos 1 letra + ao menos 1 numero ou hifen.
      const isLikelyRef =
        !rawSearch.includes(' ') &&
        rawSearch.length >= 3 &&
        rawSearch.length <= 20 &&
        /[A-Z]/.test(rawSearch) &&
        /[0-9\-]/.test(rawSearch);
      if (isLikelyRef) {
        // Igualdade exata na REF — usa indice
        conds.push('p.REF = ?');
        vals.push(rawSearch);
      } else {
        // Caminho generico (busca livre por descricao/codigo)
        const tokens = rawSearch.split(/\s+/).filter((t) => t.length > 0);
        for (const tok of tokens) {
          const term = `%${tok}%`;
          conds.push(
            `(UPPER(p.REF) LIKE ? OR UPPER(COALESCE(p.DESCRICAOCOMPLETA, '')) LIKE ? OR p.CODIGO LIKE ?)`,
          );
          vals.push(term, term, term);
        }
      }
    }

    // â”€â”€ 2) Query principal: pega produto + estoque por loja agregado â”€â”€
    // Performance: usa GROUP_CONCAT pra trazer todos os pares (loja, qty)
    // em UMA linha por CODIGO. Mais rÃ¡pido que mÃºltiplas joins.
    // FIX: Wincred Lurd's nÃ£o tem coluna p.DESCRICAO nem p.PRECO.
    // - descriÃ§Ã£o: usa DESCRICAOCOMPLETA (Ãºnica que existe)
    // - preÃ§o de venda: VENDAUN estÃ¡ EM REAIS direto (formato decimal),
    //   nÃ£o em centavos. Ex: 199.90 = R$ 199,90 (sem dividir).
    const sql = `
      SELECT
        p.CODIGO AS codigo,
        p.REF AS ref,
        p.COR AS cor,
        p.TAMANHO AS tamanho,
        COALESCE(p.DESCRICAOCOMPLETA, '') AS descricao,
        ROUND(COALESCE(p.VENDAUN, 0), 2) AS preco,
        (
          SELECT GROUP_CONCAT(CONCAT(e.LOJA, ':', e.ESTOQUE) SEPARATOR '|')
            FROM estoque e
           WHERE CAST(e.CODIGO AS UNSIGNED) = CAST(p.CODIGO AS UNSIGNED)
        ) AS estoque_str
      FROM produtos p
      WHERE ${conds.join(' AND ')}
      ORDER BY p.REF, p.COR, p.TAMANHO
      LIMIT ?
    `;
    vals.push(limit);

    this.logger.log(
      `[erp] getStockDistribution mode=${mode} minTotal=${minTotal} tamanhos=${tamanhos.length} ` +
      `grupo=${filters.grupoCodigo || 'all'} sub=${filters.subgrupoCodigo || 'all'} ` +
      `search=${filters.search || '(none)'}`,
    );
    const t0 = Date.now();
    let rawRows: any[] = [];
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, vals);
      rawRows = rows as any[];
    } catch (e) {
      this.logger.error(`getStockDistribution falhou: ${(e as Error).message}`);
      return { rows: [], lojas: [], totalRows: 0, truncated: false };
    }
    this.logger.log(
      `[erp] getStockDistribution: ${rawRows.length} produtos retornados da query em ${Date.now() - t0}ms`,
    );

    // GUARDA-CHUVA: se busca especÃ­fica foi feita (search) mas nada veio,
    // tenta sem filtro de tamanho â€” talvez a peÃ§a buscada nÃ£o esteja na
    // lista de plus size (mas o user buscou explicitamente por ela).
    if (rawRows.length === 0 && filters.search?.trim()) {
      const term = `%${filters.search.trim().toUpperCase()}%`;
      const fallbackSql = `
        SELECT
          p.CODIGO AS codigo,
          p.REF AS ref,
          p.COR AS cor,
          p.TAMANHO AS tamanho,
          COALESCE(p.DESCRICAOCOMPLETA, '') AS descricao,
          ROUND(COALESCE(p.VENDAUN, 0), 2) AS preco,
          (
            SELECT GROUP_CONCAT(CONCAT(e.LOJA, ':', e.ESTOQUE) SEPARATOR '|')
              FROM estoque e
             WHERE CAST(e.CODIGO AS UNSIGNED) = CAST(p.CODIGO AS UNSIGNED)
          ) AS estoque_str
        FROM produtos p
        WHERE COALESCE(p.REF, '') <> ''
          AND (UPPER(p.REF) LIKE ? OR UPPER(COALESCE(p.DESCRICAOCOMPLETA, '')) LIKE ? OR p.CODIGO LIKE ?)
        ORDER BY p.REF, p.COR, p.TAMANHO
        LIMIT ?
      `;
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          fallbackSql,
          [term, term, term, limit],
        );
        rawRows = rows as any[];
        this.logger.warn(
          `[erp] getStockDistribution fallback (sem filtro de tamanho) retornou ${rawRows.length} linhas`,
        );
      } catch (e) {
        this.logger.error(`fallback falhou: ${(e as Error).message}`);
      }
    }

    // â”€â”€ 3) Parse estoque_str â†’ mapa por loja + descobre conjunto de lojas â”€â”€
    const lojasSet = new Set<string>();
    type Parsed = {
      codigo: string;
      ref: string;
      cor: string | null;
      tamanho: string | null;
      descricao: string;
      preco: number;
      estoquePorLoja: Record<string, number>;
      total: number;
      criticidade: 'ALTO' | 'MEDIO' | 'OK';
    };
    const parsed: Parsed[] = [];

    for (const r of rawRows) {
      const estoquePorLoja: Record<string, number> = {};
      let total = 0;
      const estoqueStr = r.estoque_str ? String(r.estoque_str) : '';
      if (estoqueStr) {
        for (const pair of estoqueStr.split('|')) {
          const [loja, qtdRaw] = pair.split(':');
          const lojaCode = String(loja || '').trim().toUpperCase();
          if (!lojaCode || ignoredLojas.has(lojaCode)) continue;
          const qty = Number(qtdRaw) || 0;
          estoquePorLoja[lojaCode] = (estoquePorLoja[lojaCode] || 0) + qty;
          lojasSet.add(lojaCode);
          total += qty;
        }
      }

      // Filtro de lojas (se especificado): mantÃ©m SÃ“ as solicitadas
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

      // Calcula criticidade
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
        estoquePorLoja,
        total,
        criticidade,
      });
    }

    // â”€â”€ 4) Filtra por modo + minTotal â”€â”€
    // minTotal agora Ã© "mÃ­nimo de peÃ§as em ALGUMA loja" (maxQty), nÃ£o soma total.
    // Faz sentido analÃ­tico: se a maior loja sÃ³ tem 1 peÃ§a, nÃ£o dÃ¡ pra
    // redistribuir nada. AnÃ¡lise Ãºtil sÃ³ com SKUs onde alguma loja tem 2+.
    let filtered = parsed;
    if (minTotal > 0) {
      filtered = filtered.filter((r) => {
        const vals = Object.values(r.estoquePorLoja || {});
        const maxQty = vals.length > 0 ? Math.max(...vals) : 0;
        return maxQty >= minTotal;
      });
    }
    if (mode === 'imbalanced') {
      filtered = filtered.filter((r) => r.criticidade !== 'OK');
    }

    // â”€â”€ 5) Ordena: ALTO â†’ MEDIO â†’ OK, dentro de cada grupo por total desc â”€â”€
    const ordWeight: Record<string, number> = { ALTO: 0, MEDIO: 1, OK: 2 };
    filtered.sort((a, b) => {
      const dw = ordWeight[a.criticidade] - ordWeight[b.criticidade];
      if (dw !== 0) return dw;
      return b.total - a.total;
    });

    // â”€â”€ 6) Header de lojas: ordena alfabeticamente pra ficar consistente â”€â”€
    const lojas = Array.from(lojasSet)
      .filter((l) => !ignoredLojas.has(l))
      .filter((l) => !filters.lojas || filters.lojas.includes(l))
      .sort();

    const result = {
      rows: filtered,
      lojas,
      totalRows: filtered.length,
      truncated: rawRows.length >= limit,
    };

    // Salva no cache. LRU: se passar de MAX, remove a entrada mais antiga.
    if (this.stockDistCache.size >= this.STOCK_DIST_CACHE_MAX) {
      const oldestKey = this.stockDistCache.keys().next().value;
      if (oldestKey) this.stockDistCache.delete(oldestKey);
    }
    this.stockDistCache.set(cacheKey, { data: result, ts: Date.now() });

    return result;
  }

  /**
   * Cria um novo grupo no Wincred (tabela grupos).
   * Reserva prÃ³ximo CODIGO via MAX+1 dentro de uma transaÃ§Ã£o.
   */
  async inserirGrupo(nome: string): Promise<{ codigo: number; nome: string }> {
    if (!this.isWriteEnabled) {
      throw new Error('ERP_WRITE_ENABLED=false. Setar env=true pra criar grupo no Wincred.');
    }
    if (!this.pool) throw new Error('ERP MySQL nÃ£o estÃ¡ conectado');
    const nomeNormalizado = String(nome || '').trim().toUpperCase().slice(0, 30);
    if (!nomeNormalizado) throw new Error('Nome do grupo vazio');

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [maxRows]: any = await conn.query(
        `SELECT COALESCE(MAX(CODIGO), 0) + 1 AS prox FROM grupos FOR UPDATE`,
      );
      const codigo = Number(maxRows[0]?.prox) || 1;
      await conn.query(
        `INSERT INTO grupos (CODIGO, GRUPO) VALUES (?, ?)`,
        [codigo, nomeNormalizado],
      );
      await conn.commit();
      return { codigo, nome: nomeNormalizado };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  /**
   * Cria um novo subgrupo dentro de um grupo existente (tabela subgrupos).
   */
  async inserirSubgrupo(grupoCodigo: number, nome: string): Promise<{ codigo: number; nome: string; grupo: number }> {
    if (!this.isWriteEnabled) {
      throw new Error('ERP_WRITE_ENABLED=false. Setar env=true pra criar subgrupo no Wincred.');
    }
    if (!this.pool) throw new Error('ERP MySQL nÃ£o estÃ¡ conectado');
    if (!grupoCodigo) throw new Error('grupoCodigo Ã© obrigatÃ³rio');
    const nomeNormalizado = String(nome || '').trim().toUpperCase().slice(0, 30);
    if (!nomeNormalizado) throw new Error('Nome do subgrupo vazio');

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [maxRows]: any = await conn.query(
        `SELECT COALESCE(MAX(CODIGO), 0) + 1 AS prox FROM subgrupos FOR UPDATE`,
      );
      const codigo = Number(maxRows[0]?.prox) || 1;
      await conn.query(
        `INSERT INTO subgrupos (CODIGO, SUBGRUPO, GRUPO) VALUES (?, ?, ?)`,
        [codigo, nomeNormalizado, grupoCodigo],
      );
      await conn.commit();
      return { codigo, nome: nomeNormalizado, grupo: grupoCodigo };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  /**
   * Lista cores distintas usadas nos produtos. Ãštil pra preencher o modal
   * de cores com sugestÃµes + permitir digitar nova.
   */
  async listarCoresDistintas(limit = 200): Promise<string[]> {
    if (!this.pool) return [];
    try {
      const [rows] = await this.pool.query(
        `SELECT COR, COUNT(*) AS qtd
           FROM produtos
          WHERE COR IS NOT NULL AND COR <> ''
          GROUP BY COR
          ORDER BY qtd DESC
          LIMIT ?`,
        [limit],
      );
      return (rows as any[]).map((r) => String(r.COR || '').trim()).filter(Boolean);
    } catch (e) {
      this.logger.error(`listarCoresDistintas falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Lista tamanhos distintos usados nos produtos. Ãštil pra preencher o modal
   * de tamanhos com sugestÃµes.
   */
  async listarTamanhosDistintos(limit = 200): Promise<string[]> {
    if (!this.pool) return [];
    try {
      const [rows] = await this.pool.query(
        `SELECT TAMANHO, COUNT(*) AS qtd
           FROM produtos
          WHERE TAMANHO IS NOT NULL AND TAMANHO <> ''
          GROUP BY TAMANHO
          ORDER BY qtd DESC
          LIMIT ?`,
        [limit],
      );
      return (rows as any[]).map((r) => String(r.TAMANHO || '').trim()).filter(Boolean);
    } catch (e) {
      this.logger.error(`listarTamanhosDistintos falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Busca CNPJ de fornecedor pelo nome (RAZAOSOCIAL ou FANTASIA).
   * Retorna null se nÃ£o achar. Match exato case-insensitive primeiro,
   * fallback LIKE.
   */
  async findFornecedorCnpjByNome(nome: string): Promise<string | null> {
    if (!this.pool || !nome?.trim()) return null;
    const n = nome.trim();
    try {
      // Match exato (FANTASIA ou RAZAOSOCIAL)
      const [rows1] = await this.pool.query(
        `SELECT CNPJ FROM fornecedores
          WHERE TRIM(UPPER(FANTASIA)) = TRIM(UPPER(?))
             OR TRIM(UPPER(RAZAOSOCIAL)) = TRIM(UPPER(?))
          LIMIT 1`,
        [n, n],
      );
      if ((rows1 as any[]).length > 0) {
        const cnpj = String((rows1 as any[])[0].CNPJ || '').trim();
        if (cnpj) return cnpj;
      }
      // Fallback LIKE
      const [rows2] = await this.pool.query(
        `SELECT CNPJ FROM fornecedores
          WHERE FANTASIA LIKE ? OR RAZAOSOCIAL LIKE ?
          ORDER BY LENGTH(FANTASIA), LENGTH(RAZAOSOCIAL)
          LIMIT 1`,
        [`%${n}%`, `%${n}%`],
      );
      if ((rows2 as any[]).length > 0) {
        const cnpj = String((rows2 as any[])[0].CNPJ || '').trim();
        if (cnpj) return cnpj;
      }
    } catch (e: any) {
      this.logger.warn(`findFornecedorCnpjByNome falhou: ${e?.message}`);
    }
    return null;
  }

  /**
   * Lista fornecedores cadastrados em produtos (CNPJ + nome se disponÃ­vel).
   */
  async listarFornecedores(limit = 5000): Promise<Array<{ cnpj: string; nome: string; fantasia?: string }>> {
    if (!this.pool) return [];
    // FANTASIA = MARCA no Lurd's â€” preferir FANTASIA na exibicao quando houver.
    // SCHEMA REAL: fornecedores tem CNPJ + RAZAOSOCIAL + FANTASIA (nao CGC nem NOME)
    // Tentativa 1: schema Lurd's (CNPJ/RAZAOSOCIAL/FANTASIA)
    try {
      const [rows] = await this.pool.query(
        `SELECT CNPJ AS cnpj, RAZAOSOCIAL AS nome, FANTASIA AS fantasia
           FROM fornecedores
          WHERE (RAZAOSOCIAL IS NOT NULL AND RAZAOSOCIAL <> '')
             OR (FANTASIA IS NOT NULL AND FANTASIA <> '')
          ORDER BY COALESCE(NULLIF(FANTASIA,''), RAZAOSOCIAL)
          LIMIT ?`,
        [limit],
      );
      const result = (rows as any[]).map((r) => {
        const fant = r.fantasia ? String(r.fantasia).trim() : '';
        const nomeReal = String(r.nome || '').trim();
        return {
          cnpj: String(r.cnpj || '').trim(),
          nome: fant || nomeReal,
          fantasia: fant || undefined,
        };
      }).filter((f) => f.nome);
      if (result.length) {
        this.logger.log(`listarFornecedores NOME+FANTASIA OK (${result.length})`);
        return result;
      }
    } catch (e: any) {
      this.logger.warn(`listarFornecedores tent1 falhou: ${e?.message}`);
    }
    // Tentativa 2: schema antigo (CGC/NOME)
    try {
      const [rows] = await this.pool.query(
        `SELECT CGC AS cnpj, NOME AS nome FROM fornecedores
          WHERE NOME IS NOT NULL AND NOME <> ''
          ORDER BY NOME LIMIT ?`,
        [limit],
      );
      const result = (rows as any[]).map((r) => ({
        cnpj: String(r.cnpj || '').trim(),
        nome: String(r.nome || '').trim(),
      })).filter((f) => f.nome);
      if (result.length) {
        this.logger.log(`listarFornecedores NOME OK (${result.length})`);
        return result;
      }
    } catch (e: any) {
      this.logger.warn(`listarFornecedores tent2 falhou: ${e?.message}`);
    }
    // Tentativa 3: JOIN com produtos (schema Lurd's)
    try {
      const [rows] = await this.pool.query(
        `SELECT DISTINCT p.FORNECEDOR AS cnpj,
                COALESCE(NULLIF(TRIM(f.FANTASIA),''), NULLIF(TRIM(f.RAZAOSOCIAL),''), p.FORNECEDOR) AS nome,
                f.FANTASIA AS fantasia
           FROM produtos p
           LEFT JOIN fornecedores f ON f.CNPJ = p.FORNECEDOR
          WHERE p.FORNECEDOR IS NOT NULL AND p.FORNECEDOR <> ''
          ORDER BY nome LIMIT ?`,
        [limit],
      );
      const result = (rows as any[]).map((r) => ({
        cnpj: String(r.cnpj || '').trim(),
        nome: String(r.nome || r.cnpj || '').trim(),
        fantasia: r.fantasia ? String(r.fantasia).trim() : undefined,
      })).filter((f) => f.cnpj);
      if (result.length) {
        this.logger.log(`listarFornecedores JOIN OK (${result.length})`);
        return result;
      }
    } catch (e: any) {
      this.logger.warn(`listarFornecedores JOIN falhou: ${e?.message}`);
    }
    // Ultimo recurso: so CNPJ
    try {
      const [rows] = await this.pool.query(
        `SELECT DISTINCT FORNECEDOR AS cnpj FROM produtos
          WHERE FORNECEDOR IS NOT NULL AND FORNECEDOR <> ''
          ORDER BY FORNECEDOR LIMIT ?`,
        [limit],
      );
      return (rows as any[]).map((r) => ({
        cnpj: String(r.cnpj || '').trim(),
        nome: String(r.cnpj || '').trim(),
      })).filter((f) => f.cnpj);
    } catch (e: any) {
      this.logger.error(`listarFornecedores TOTAL fail: ${e?.message}`);
      return [];
    }
  }

  /**
   * Busca produto(s) no Wincred por codigo (EAN, REF ou CODIGO).
   * Usado pra imprimir etiquetas avulsas â€” aceita codigos misturados.
   *
   * BUG FIX: colunas reais do Wincred sÃ£o REF / VENDAUN / DESCRICAOCOMPLETA /
   * MARCA (e NÃƒO REFERENCIA / PRECOVENDA / DESCRICAO / FORNECEDOR). Antes a
   * query nunca encontrava pesquisa por REF â€” sÃ³ achava pelo CODIGO exato.
   */
  async buscarProdutoPorCodigo(codigo: string): Promise<Array<any>> {
    if (!this.pool || !codigo) return [];
    const c = codigo.trim().toUpperCase();
    if (!c) return [];
    try {
      // Busca por CODIGO exato OU REF exata OU EAN exato (com LPAD)
      // â€” todas as variantes em UPPER+TRIM pra tolerar lixo nas cÃ©lulas do ERP.
      // LIMIT alto (1000) pra cobrir REF com muitas cores Ã— tamanhos.
      // Exemplo: REF com 12 cores Ã— 8 tamanhos = 96 SKUs; LIMIT 50 antes cortava.
      const [rows] = await this.pool.query(
        `SELECT CODIGO AS codigo, REF AS referencia, COR AS cor,
                TAMANHO AS tamanho, VENDAUN AS preco,
                DESCRICAOCOMPLETA AS descricao,
                MARCA AS marca
           FROM produtos
          WHERE UPPER(TRIM(CODIGO)) = ?
             OR UPPER(TRIM(REF)) = ?
             OR CODIGO = LPAD(?, 13, '0')
          ORDER BY REF, COR, TAMANHO
          LIMIT 1000`,
        [c, c, c],
      );
      return (rows as any[]).map((r) => ({
        codigo: String(r.codigo || '').trim(),
        referencia: String(r.referencia || '').trim(),
        cor: String(r.cor || '').trim(),
        tamanho: String(r.tamanho || '').trim(),
        preco: Number(r.preco || 0),
        descricao: String(r.descricao || '').trim(),
        fornecedor: null,
        marca: r.marca ? String(r.marca).trim() : null,
      }));
    } catch (e: any) {
      this.logger.warn(`buscarProdutoPorCodigo ${c} falhou: ${e?.message}`);
      return [];
    }
  }

  /**
   * Pega o prÃ³ximo CODIGO de grupo livre na tabela `grupos` (MAX+1).
   */
  async proximoGrupoCodigo(): Promise<number> {
    if (!this.pool) throw new Error('ERP MySQL nÃ£o estÃ¡ conectado');
    const [rows] = await this.pool.query(
      `SELECT COALESCE(MAX(CODIGO), 0) + 1 AS proximo FROM grupos`,
    );
    return Number((rows as any[])[0]?.proximo) || 1;
  }

  /**
   * Verifica se um CODIGO jÃ¡ existe na tabela produtos.
   */
  async produtoExiste(codigo: string): Promise<boolean> {
    if (!this.pool) return false;
    const [rows] = await this.pool.query(
      `SELECT 1 FROM produtos WHERE CODIGO = ? LIMIT 1`,
      [codigo],
    );
    return (rows as any[]).length > 0;
  }

  /**
   * Insere N produtos na tabela `produtos` do Wincred em uma Ãºnica
   * transaÃ§Ã£o (ACID). Todos caem ou nada cai. IdempotÃªncia: se o CODIGO
   * jÃ¡ existir, ignora (insert ignore).
   *
   * Requer ERP_WRITE_ENABLED='true'. SenÃ£o lanÃ§a erro sem tocar no banco.
   */
  /**
   * EDITOR DE PRODUTOS (/retaguarda/editor-produtos): UPDATE de campos do
   * cadastro direto no Giga (fonte da verdade) - REF/descricao/marca/cor/
   * tamanho/preco. DESCRICAOPDV acompanha a descricao completa (50 chars),
   * igual ao cadastro. DATAALT=CURDATE() SEMPRE: e o campo que o sync
   * incremental do espelho usa pra enxergar a mudanca.
   * Transacao unica: ou grava o lote inteiro, ou nada (nunca meio-gravado).
   * WHERE por CODIGO EXATO (string vinda da propria busca) - sem CAST, porque
   * padding inconsistente poderia casar outra linha.
   */
  async updateProdutosCampos(rows: Array<{
    codigo: string;
    set: {
      ref?: string;
      descricaoCompleta?: string;
      marca?: string;
      cor?: string;
      tamanho?: string;
      vendaUn?: number;
    };
  }>): Promise<{ atualizados: number }> {
    if (!this.isWriteEnabled) {
      throw new Error('ERP_WRITE_ENABLED=false. Setar env=true pra liberar edicao de produtos.');
    }
    if (!this.pool) throw new Error('ERP MySQL nao esta conectado');
    if (!rows.length) return { atualizados: 0 };

    // PERF (13/07): agrupa por payload IGUAL de SET → ação em bloco (ex: marca
    // igual em 400 variações) vira UMA query "UPDATE ... WHERE CODIGO IN (...)"
    // em vez de 400 roundtrips WAN ao MySQL (era o "preenchimento lento").
    const grupos = new Map<string, { sets: string[]; params: any[]; codigos: string[] }>();
    for (const r of rows) {
      const sets: string[] = [];
      const params: any[] = [];
      const s = r.set || {};
      if (s.ref !== undefined) { sets.push('REF = ?'); params.push(String(s.ref).slice(0, 10)); }
      if (s.descricaoCompleta !== undefined) {
        sets.push('DESCRICAOCOMPLETA = ?'); params.push(String(s.descricaoCompleta).slice(0, 100));
        sets.push('DESCRICAOPDV = ?'); params.push(String(s.descricaoCompleta).slice(0, 50));
      }
      if (s.marca !== undefined) { sets.push('MARCA = ?'); params.push(String(s.marca).slice(0, 30)); }
      if (s.cor !== undefined) { sets.push('COR = ?'); params.push(String(s.cor).slice(0, 15)); }
      if (s.tamanho !== undefined) { sets.push('TAMANHO = ?'); params.push(String(s.tamanho).slice(0, 20)); }
      if (s.vendaUn !== undefined) { sets.push('VENDAUN = ?'); params.push(Number(s.vendaUn)); }
      if (!sets.length) continue;
      const key = JSON.stringify([sets, params]);
      const g = grupos.get(key);
      if (g) g.codigos.push(r.codigo);
      else grupos.set(key, { sets, params, codigos: [r.codigo] });
    }
    if (!grupos.size) return { atualizados: 0 };

    const conn = await this.pool.getConnection();
    let atualizados = 0;
    try {
      await conn.beginTransaction();
      for (const g of grupos.values()) {
        // ⚠️ INCIDENTE 14/07: NUNCA tocar DATAALT aqui. DATAALT é a DATA DE
        // CADASTRO que a promoção "Liquida antigos" usa pra decidir quem é
        // antigo — carimbar CURDATE() tirou milhares de peças da promo.
        // O espelho/nativa são atualizados direto pelo editor; não precisamos
        // do DATAALT pro sync enxergar a mudança.
        const sets = [...g.sets, `OPERADOR = 'FLOWOPS'`];
        // Lotes de 500 códigos por IN() pra não estourar tamanho de query.
        for (let i = 0; i < g.codigos.length; i += 500) {
          const chunk = g.codigos.slice(i, i + 500);
          const placeholders = chunk.map(() => '?').join(',');
          const [result]: any = await conn.query(
            `UPDATE produtos SET ${sets.join(', ')} WHERE CODIGO IN (${placeholders})`,
            [...g.params, ...chunk],
          );
          atualizados += Number(result.affectedRows) || 0;
        }
      }
      await conn.commit();
      this.logger.log(
        `updateProdutosCampos: ${atualizados}/${rows.length} produtos atualizados no Giga (${grupos.size} grupo(s) de UPDATE)`,
      );
      return { atualizados };
    } catch (e) {
      await conn.rollback();
      this.logger.error(`updateProdutosCampos falhou - rollback: ${(e as Error).message}`);
      throw e;
    } finally {
      conn.release();
    }
  }

  /**
   * RESTAURAÇÃO DO INCIDENTE 14/07: devolve a DATA DE CADASTRO (DATAALT)
   * original de produtos que o editor carimbou com a data da edição —
   * o que tirou peças antigas da promoção Liquida Antigos.
   * Agrupa por data (poucos UPDATEs) e cobre variantes de zero-padding.
   */
  async restoreDataAlt(pairs: Array<{ codigo: string; dataAlt: string }>): Promise<{ atualizados: number }> {
    if (!this.isWriteEnabled) {
      throw new Error('ERP_WRITE_ENABLED=false. Setar env=true pra liberar restauração.');
    }
    if (!this.pool) throw new Error('ERP MySQL nao esta conectado');
    const clean = pairs.filter((p) => p.codigo && /^\d{4}-\d{2}-\d{2}$/.test(String(p.dataAlt || '')));
    if (!clean.length) return { atualizados: 0 };

    // Agrupa por DATA → 1 UPDATE por data (com IN de todas as variantes).
    const porData = new Map<string, string[]>();
    for (const p of clean) {
      const list = porData.get(p.dataAlt) || [];
      for (const v of this.skuVariants(String(p.codigo).trim())) list.push(v);
      porData.set(p.dataAlt, list);
    }

    // AUTOCOMMIT por statement (SEM transação gigante): incidente 14/07 mostrou
    // que 88k updates numa transação única = commit invisível + timeout de
    // gateway + lock gigante. Cada UPDATE commita sozinho — progresso visível
    // e re-execução é idempotente (regrava o mesmo valor).
    let atualizados = 0;
    for (const [dataAlt, codigos] of porData.entries()) {
      for (let i = 0; i < codigos.length; i += 500) {
        const chunk = codigos.slice(i, i + 500);
        const placeholders = chunk.map(() => '?').join(',');
        const [result]: any = await this.pool.query(
          `UPDATE produtos SET DATAALT = ? WHERE CODIGO IN (${placeholders})`,
          [dataAlt, ...chunk],
        );
        atualizados += Number(result.affectedRows) || 0;
      }
    }
    this.logger.log(`restoreDataAlt: ${atualizados} produtos restaurados no Giga (${porData.size} data(s))`);
    return { atualizados };
  }

  /** Leva 4 (incidente DATAALT): a caixa tem índice em CODIGO? Sem índice a
   *  varredura por chunks viraria full-scan repetido — aí só usamos o espelho. */
  async caixaCodigoIndexed(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>({ sql: 'SHOW INDEX FROM caixa', timeout: 15_000 });
      return (rows as any[]).some((r) => String(r.Column_name || '').toUpperCase() === 'CODIGO');
    } catch {
      return false;
    }
  }

  /** Leva 4: primeira venda (MIN(DATA)) por código na caixa do Giga, em um
   *  chunk pequeno. Read-only, IN-list com variantes de zero-padding. */
  async getFirstSaleDatesChunk(codigos: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.pool || !codigos.length) return out;
    const { allVariants, variantToOriginal } = this.expandSkus(codigos);
    if (!allVariants.length) return out;
    const placeholders = allVariants.map(() => '?').join(',');
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      {
        sql: `SELECT CODIGO, DATE_FORMAT(MIN(DATA), '%Y-%m-%d') AS d
                FROM caixa
               WHERE CODIGO IN (${placeholders})
               GROUP BY CODIGO`,
        timeout: 30_000,
      },
      allVariants,
    );
    for (const r of rows as any[]) {
      const orig = variantToOriginal.get(String(r.CODIGO || '').trim());
      const d = String(r.d || '');
      if (!orig || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      const prev = out.get(orig);
      if (!prev || d < prev) out.set(orig, d);
    }
    return out;
  }

  async inserirProdutosBatch(produtos: Array<{
    codigo: string;
    grupo: number;
    nomeGrupo: string;
    subgrupo?: number;
    descricaoCompleta: string;
    descricaoPdv?: string;
    custo: number;
    precoVenda: number;
    margem: number;
    fornecedor: string;
    cor: string;
    tamanho: string;
    ref: string;
    plusSize: boolean;
    ncm?: string;
    cfop?: number;
    tributo?: string;
    marca?: string;
    estoqueInicial?: number;
  }>): Promise<{ inseridos: number; ignorados: number }> {
    if (!this.isWriteEnabled) {
      throw new Error('ERP_WRITE_ENABLED=false. Setar env=true pra liberar inserÃ§Ã£o em produtos.');
    }
    if (!this.pool) throw new Error('ERP MySQL nÃ£o estÃ¡ conectado');
    if (!produtos.length) return { inseridos: 0, ignorados: 0 };

    const conn = await this.pool.getConnection();
    let inseridos = 0;
    let ignorados = 0;
    try {
      await conn.beginTransaction();
      for (const p of produtos) {
        // INSERT IGNORE: se CODIGO jÃ¡ existe (PK collision), ignora a linha
        // sem dar rollback do batch inteiro.
        const [result]: any = await conn.query(
          `INSERT IGNORE INTO produtos (
             CODIGO, GRUPO, NOMEGRUPO, DESCRICAOPDV, DESCRICAOCOMPLETA,
             CUSTO, VENDAUN, MARGEM, FORNECEDOR, UNIDADE, ESTOQUE,
             SUBGRUPO, COR, TAMANHO, MARCA, REF,
             TRIBUTO, NCM, PLUS_SIZE, CFOP, DATAALT, OPERADOR
           ) VALUES (
             ?, ?, ?, ?, ?,
             ?, ?, ?, ?, 'UN', ?,
             ?, ?, ?, ?, ?,
             ?, ?, ?, ?, CURDATE(), 'FLOWOPS'
           )`,
          [
            p.codigo,
            p.grupo,
            (p.nomeGrupo || '').slice(0, 30),
            (p.descricaoPdv || p.descricaoCompleta).slice(0, 50),
            p.descricaoCompleta.slice(0, 100),
            p.custo,
            p.precoVenda,
            p.margem,
            (p.fornecedor || '').slice(0, 18),
            p.estoqueInicial ?? 0,
            p.subgrupo ?? null,
            (p.cor || '').slice(0, 15),
            (p.tamanho || '').slice(0, 20),
            (p.marca || '').slice(0, 30),
            (p.ref || '').slice(0, 10),
            (p.tributo || '').slice(0, 4),
            (p.ncm || '').slice(0, 8),
            p.plusSize ? 1 : 0,
            p.cfop ?? null,
          ],
        );
        if (result.affectedRows && result.affectedRows > 0) inseridos++;
        else ignorados++;
      }
      await conn.commit();
      this.logger.log(`inserirProdutosBatch: ${inseridos} inseridos, ${ignorados} ignorados (jÃ¡ existiam)`);
      return { inseridos, ignorados };
    } catch (e) {
      await conn.rollback();
      this.logger.error(`inserirProdutosBatch falhou â€” rollback: ${(e as Error).message}`);
      throw e;
    } finally {
      conn.release();
    }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // PDV â€” GravaÃ§Ã£o de venda na tabela `caixa` do Wincred (gigasistemas21)
  //
  // Replica o que o PDV antigo do Wincred faz: 1 linha por ITEM da venda.
  // O nÃºmero da venda (NUMERO) Ã© compartilhado com o PDV antigo â€” usamos
  // MAX(NUMERO)+1 com FOR UPDATE pra evitar colisÃ£o.
  //
  // Modo SHADOW (PDV_ERP_WRITE_ENABLED=false, default): sÃ³ LOGA os SQLs
  // que SERIAM executados, sem tocar no banco. Permite validar geraÃ§Ã£o
  // de SQL antes de ligar real.
  //
  // Modo REAL (PDV_ERP_WRITE_ENABLED=true): executa em transaÃ§Ã£o ACID.
  // Se qualquer item falhar â†’ rollback total â†’ retorna erro.
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Busca o CODIGO de um funcionÃ¡rio no Wincred pelo nome (ou apelido)
   * filtrando pela loja. Usado pra preencher VENDEDOR/OPERADOR na tabela
   * `caixa` quando flowops PDV finaliza venda.
   *
   * EstratÃ©gia (em ordem de prioridade):
   * 1. APELIDO exato (case-insensitive) + LOJA
   * 2. NOME exato (case-insensitive) + LOJA
   * 3. Primeiro nome (atÃ© primeiro espaÃ§o) + LOJA
   * 4. APELIDO sem filtro de loja (fallback)
   *
   * Retorna 0 se nÃ£o achou (caller deve aceitar 0 como "sem mapeamento").
   */
  async lookupFuncionarioCode(nome: string, lojaCode?: string): Promise<number> {
    if (!this.pool || !nome) return 0;
    const nomeNormalizado = String(nome).trim().toUpperCase();
    if (!nomeNormalizado) return 0;
    const loja = lojaCode ? String(lojaCode).padStart(2, '0').slice(-2) : null;
    const primeiroNome = nomeNormalizado.split(/\s+/)[0];

    try {
      // 1. Tenta APELIDO exato + LOJA
      if (loja) {
        const [r1] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO FROM funcionarios WHERE UPPER(APELIDO) = ? AND LOJA = ? LIMIT 1`,
          [nomeNormalizado, loja],
        );
        if (r1.length) return Number(r1[0].CODIGO) || 0;
      }
      // 2. Tenta NOME exato + LOJA
      if (loja) {
        const [r2] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO FROM funcionarios WHERE UPPER(NOME) = ? AND LOJA = ? LIMIT 1`,
          [nomeNormalizado, loja],
        );
        if (r2.length) return Number(r2[0].CODIGO) || 0;
      }
      // 3. Primeiro nome + LOJA (NOME ou APELIDO comeÃ§a com)
      if (loja && primeiroNome.length >= 3) {
        const [r3] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO FROM funcionarios
            WHERE LOJA = ?
              AND (UPPER(APELIDO) = ? OR UPPER(NOME) LIKE ?)
            LIMIT 1`,
          [loja, primeiroNome, primeiroNome + '%'],
        );
        if (r3.length) return Number(r3[0].CODIGO) || 0;
      }
      // 4. Fallback: APELIDO sem filtro de loja
      const [r4] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO FROM funcionarios WHERE UPPER(APELIDO) = ? LIMIT 1`,
        [nomeNormalizado],
      );
      if (r4.length) return Number(r4[0].CODIGO) || 0;
      return 0;
    } catch (e) {
      this.logger.warn(`lookupFuncionarioCode("${nome}", "${loja}") falhou: ${(e as Error).message}`);
      return 0;
    }
  }

  /**
   * Busca o CODIGO de um cliente no Wincred por CPF (prioridade) ou NOME.
   * Usado pra preencher CLIENTE na tabela `caixa` quando flowops PDV
   * finaliza venda com cliente identificado.
   *
   * EstratÃ©gia (em ordem):
   * 1. CPF exato (limpo de pontuaÃ§Ã£o)
   * 2. NOME completo exato (case-insensitive)
   * 3. NOME LIKE (primeiras 3 palavras)
   *
   * Retorna 0 se nÃ£o achou.
   */
  async lookupClienteCode(input: { cpf?: string; nome?: string; telefone?: string }): Promise<number> {
    if (!this.pool) return 0;
    const cpf = String(input.cpf || '').replace(/\D/g, '').trim();
    const nome = String(input.nome || '').trim().toUpperCase();
    const tel = String(input.telefone || '').replace(/\D/g, '').trim();
    if (!cpf && !nome && !tel) return 0;

    try {
      // 1. CPF exato (limpo)
      if (cpf && cpf.length >= 11) {
        const [r1] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO FROM clientes
            WHERE REPLACE(REPLACE(REPLACE(CPF, '.', ''), '-', ''), '/', '') = ?
            LIMIT 1`,
          [cpf],
        );
        if (r1.length) return Number(r1[0].CODIGO) || 0;
      }
      // 2. NOME exato
      if (nome) {
        const [r2] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO FROM clientes WHERE UPPER(NOME) = ? LIMIT 1`,
          [nome],
        );
        if (r2.length) return Number(r2[0].CODIGO) || 0;
      }
      // 3. TELEFONE (FONECEL ou FONERES) â€” Ãºtil quando nome diferente mas mesma cliente
      if (tel && tel.length >= 8) {
        const last9 = tel.slice(-9); // Ãºltimos 9 dÃ­gitos cobrem celular sem DDD
        const [r3] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO FROM clientes
            WHERE REPLACE(REPLACE(REPLACE(REPLACE(FONECEL, '(', ''), ')', ''), '-', ''), ' ', '') LIKE CONCAT('%', ?, '%')
               OR REPLACE(REPLACE(REPLACE(REPLACE(FONERES, '(', ''), ')', ''), '-', ''), ' ', '') LIKE CONCAT('%', ?, '%')
            LIMIT 2`,
          [last9, last9],
        );
        if (r3.length === 1) return Number(r3[0].CODIGO) || 0;
      }
      // 4. NOME LIKE â€” primeira+Ãºltima palavra (cobre "MARIA DA SILVA" vs "MARIA SILVA")
      if (nome) {
        const palavras = nome.split(/\s+/).filter((w) => w.length > 1);
        if (palavras.length >= 2) {
          const primeiro = palavras[0];
          const ultimo = palavras[palavras.length - 1];
          const [r4] = await this.pool.query<mysql.RowDataPacket[]>(
            `SELECT CODIGO, NOME FROM clientes
              WHERE UPPER(NOME) LIKE ? AND UPPER(NOME) LIKE ?
              LIMIT 3`,
            [`${primeiro}%`, `%${ultimo}%`],
          );
          if (r4.length === 1) return Number(r4[0].CODIGO) || 0;
          if (r4.length > 1) {
            this.logger.warn(`[lookupClienteCode] NOME "${nome}" ambÃ­guo (${r4.length} matches): ${r4.map((r: any) => r.NOME).join(' | ')}`);
          }
        }
      }
      // 5. NOME LIKE prefix (3 primeiras palavras) â€” fallback antigo
      if (nome) {
        const palavras = nome.split(/\s+/).filter((w) => w.length > 1);
        if (palavras.length >= 2) {
          const prefix = palavras.slice(0, Math.min(3, palavras.length)).join(' ');
          const [r5] = await this.pool.query<mysql.RowDataPacket[]>(
            `SELECT CODIGO FROM clientes WHERE UPPER(NOME) LIKE ? LIMIT 2`,
            [prefix + '%'],
          );
          if (r5.length === 1) return Number(r5[0].CODIGO) || 0;
        }
      }
      // NÃ£o achou â€” loga pra debug
      this.logger.warn(
        `[lookupClienteCode] NÃƒO ACHOU cliente: cpf="${cpf}" nome="${nome}" tel="${tel}"`,
      );
      return 0;
    } catch (e) {
      this.logger.warn(`lookupClienteCode falhou: ${(e as Error).message}`);
      return 0;
    }
  }

  /**
   * Mapeia mÃ©todo de pagamento do flowops pro par (FORMA, coluna_especÃ­fica)
   * da tabela `fechamento` do Wincred. PIX nÃ£o tem coluna especÃ­fica.
   *
   * Retorna {forma: string, coluna: string|null}. Coluna null = sÃ³ FORMA+VALOR.
   */
  private mapPagamentoFechamento(metodo: string): { forma: string; coluna: string | null } {
    const m = String(metodo || '').toUpperCase().trim();
    // Mapeamento real do flowops (cliente confirmou em 07/05/2026):
    // - Aceitas todas as variaÃ§Ãµes comuns do nome (lowercase, com/sem acento, com/sem espaÃ§o)
    // - Removidas: CIELODEBITO, CHEQUE_VISTA, CHEQUE_PRE, SOROCRED, CREDSYSTEM, DEBITO, MARCADO (nÃ£o existem mais no PDV)
    // Mapeamento real do flowops (cliente confirmou em 07/05/2026):
    // - Aceitas todas as variaÃ§Ãµes comuns do nome (lowercase, com/sem acento, com/sem espaÃ§o)
    // - Removidas: CIELODEBITO, CHEQUE_VISTA, CHEQUE_PRE, SOROCRED, CREDSYSTEM, DEBITO, MARCADO (nÃ£o existem mais no PDV)
    const map: Record<string, { forma: string; coluna: string | null }> = {
      // DINHEIRO
      'DINHEIRO': { forma: 'DINHEIRO', coluna: 'DINHEIRO' },
      'CASH': { forma: 'DINHEIRO', coluna: 'DINHEIRO' },
      // PIX (sem coluna especÃ­fica em fechamento â€” sÃ³ FORMA + VALOR)
      'PIX': { forma: 'PIX', coluna: null },
      // CIELO (cartÃ£o crÃ©dito Cielo)
      'CIELO': { forma: 'CIELO', coluna: 'CIELO' },
      'CIELO_CREDITO': { forma: 'CIELO', coluna: 'CIELO' },
      // MASTERCARD
      'MASTERCARD': { forma: 'MASTERCARD', coluna: 'MASTERCARD' },
      // VISA â†’ VISANET (Visa crÃ©dito)
      'VISA': { forma: 'VISANET', coluna: 'VISANET' },
      'VISANET': { forma: 'VISANET', coluna: 'VISANET' },
      // VISA ELECTRON (Visa dÃ©bito)
      'VISA ELECTRON': { forma: 'VISA_ELECTRON', coluna: 'VISA_ELECTRON' },
      'VISA_ELECTRON': { forma: 'VISA_ELECTRON', coluna: 'VISA_ELECTRON' },
      'VISAELECTRON': { forma: 'VISA_ELECTRON', coluna: 'VISA_ELECTRON' },
      // ELO
      'ELO': { forma: 'ELO', coluna: 'ELO' },
      // AMERICAN EXPRESS â†’ AMEX
      'AMERICAN EXPRESS': { forma: 'AMEX', coluna: 'AMEX' },
      'AMEX': { forma: 'AMEX', coluna: 'AMEX' },
      // HIPERCARD
      'HIPERCARD': { forma: 'HIPERCARD', coluna: 'HIPERCARD' },
      // CREDIÃRIO (tambÃ©m gera parcelas em movimento)
      'CREDIARIO': { forma: 'CREDIARIO', coluna: 'CREDIARIO' },
      'CREDIÃRIO': { forma: 'CREDIARIO', coluna: 'CREDIARIO' },
      // REDE SHOP
      'REDE SHOP': { forma: 'REDE_SHOP', coluna: 'REDE_SHOP' },
      'REDESHOP': { forma: 'REDE_SHOP', coluna: 'REDE_SHOP' },
      'REDE_SHOP': { forma: 'REDE_SHOP', coluna: 'REDE_SHOP' },
      // VENDA ONLINE â€” Plus Size vende muito via WhatsApp/Instagram. Pagamento
      // jÃ¡ chegou na conta (PIX direto / link externo). PDV sÃ³ registra a venda
      // pra ter histÃ³rico, comissÃ£o e baixa de estoque. Vai em FORMA dedicada
      // pra separar no fechamento Wincred (nÃ£o conta no fÃ­sico de dinheiro).
      'VENDA_ONLINE': { forma: 'VENDA_ONLINE', coluna: null },
      'VENDA ONLINE': { forma: 'VENDA_ONLINE', coluna: null },
      'VENDA_ONLINE_PIX': { forma: 'VENDA_ONLINE', coluna: null },
      'VENDA_ONLINE_LINK': { forma: 'VENDA_ONLINE', coluna: null },
    };
    return map[m] || { forma: m || 'OUTROS', coluna: null };
  }

  /**
   * Admin corrige bandeira de um pagamento jÃ¡ gravado no Wincred (operadora errou).
   * Usa OBS_PEDIDO da tabela `caixa` (formato 'flowops-XXXXXXXX') pra achar o NUMERO
   * da venda, e entÃ£o faz UPDATE em `fechamento`:
   *   - SET FORMA = newBandeira
   *   - SET coluna_antiga = 0/NULL
   *   - SET coluna_nova = valor
   */
  async atualizarBandeiraFechamento(input: {
    saleId: string;
    storeCode: string;
    oldBandeira: string;
    newBandeira: string;
    valor: number;
  }): Promise<{ ok: boolean; mode: 'shadow' | 'real'; numero?: number; error?: string; sqlExecuted: string[] }> {
    const sqlExecuted: string[] = [];
    const mode: 'shadow' | 'real' = this.isPdvWriteEnabled ? 'real' : 'shadow';

    if (!this.pool) {
      return { ok: false, mode, sqlExecuted, error: 'Pool ERP nÃ£o inicializado' };
    }
    if (!input.saleId) return { ok: false, mode, sqlExecuted, error: 'saleId obrigatÃ³rio' };
    if (!input.storeCode) return { ok: false, mode, sqlExecuted, error: 'storeCode obrigatÃ³rio' };
    if (!input.newBandeira) return { ok: false, mode, sqlExecuted, error: 'newBandeira obrigatÃ³ria' };

    const lojaCode = String(input.storeCode).padStart(2, '0').slice(-2);
    const saleIdShort = input.saleId.slice(0, 8);
    const obsPedido = `flowops-${saleIdShort}`;
    const oldMap = this.mapPagamentoFechamento(input.oldBandeira || '');
    const newMap = this.mapPagamentoFechamento(input.newBandeira);
    const valor = Number(input.valor) || 0;

    // Acha o NUMERO da venda no Wincred via OBS_PEDIDO + LOJA
    const sqlBusca = `SELECT NUMERO FROM caixa WHERE OBS_PEDIDO = '${obsPedido}' AND LOJA = '${lojaCode}' LIMIT 1`;
    sqlExecuted.push(sqlBusca);

    if (mode === 'shadow') {
      this.logger.warn(`[atualizarBandeiraFechamento SHADOW] obsPedido=${obsPedido} loja=${lojaCode} ${input.oldBandeira}â†’${input.newBandeira} valor=${valor}`);
      return { ok: true, mode, sqlExecuted };
    }

    try {
      const [rows] = await this.pool.query<any[]>(sqlBusca);
      const r = (rows as any[])[0];
      if (!r?.NUMERO) {
        this.logger.warn(`atualizarBandeiraFechamento: venda nÃ£o achada no Wincred (${obsPedido}/${lojaCode})`);
        return { ok: false, mode, sqlExecuted, error: `Venda nÃ£o localizada no Wincred (${obsPedido})` };
      }
      const numero = Number(r.NUMERO);

      // Monta UPDATE: zera coluna antiga (se tinha) + popula coluna nova (se tem)
      const sets: string[] = [`FORMA = '${newMap.forma.replace(/'/g, "''")}'`];
      if (oldMap.coluna && oldMap.coluna !== newMap.coluna) {
        sets.push(`\`${oldMap.coluna}\` = 0`);
      }
      if (newMap.coluna) {
        sets.push(`\`${newMap.coluna}\` = ${valor}`);
      }
      // WHERE: match estrito por VENDA + LOJA + VALOR + FORMA antiga (nÃ£o pega linha errada)
      const whereForma = oldMap.forma ? `AND FORMA = '${oldMap.forma.replace(/'/g, "''")}'` : '';
      const sqlUpdate =
        `UPDATE fechamento SET ${sets.join(', ')} ` +
        `WHERE VENDA = ${numero} AND LOJA = '${lojaCode}' ` +
        `AND ABS(VALOR - ${valor}) < 0.01 ${whereForma} LIMIT 1`;
      sqlExecuted.push(sqlUpdate);

      const [updRes] = await this.pool.query<any>(sqlUpdate);
      const affected = (updRes as any)?.affectedRows ?? 0;
      if (affected === 0) {
        this.logger.warn(`UPDATE fechamento nÃ£o afetou linhas (NUMERO=${numero} LOJA=${lojaCode} FORMA=${oldMap.forma})`);
        return { ok: false, mode, numero, sqlExecuted, error: 'Linha de fechamento nÃ£o encontrada (FORMA antiga nÃ£o bate)' };
      }
      this.logger.log(`atualizarBandeiraFechamento OK: NUMERO=${numero} LOJA=${lojaCode} ${oldMap.forma}â†’${newMap.forma} valor=${valor} (${affected} linha)`);
      return { ok: true, mode, numero, sqlExecuted };
    } catch (e: any) {
      this.logger.error(`atualizarBandeiraFechamento ERRO: ${e?.message}`);
      return { ok: false, mode, sqlExecuted, error: e?.message };
    }
  }

  /**
   * Grava uma venda do PDV flowops na tabela `caixa` do Wincred.
   * TambÃ©m grava 1 linha em `fechamento` por pagamento (com FORMA+VALOR).
   * Idempotente por venda? NÃƒO â€” cada chamada gera novo NUMERO.
   */
  async gravarVendaPdv(input: {
    storeCode: string;          // ex: '01' (ITANHAEM, char(2))
    items: Array<{
      sku: string;              // CODIGO Giga (ou EAN â€” resolveSkuInfo na ponta)
      qty: number;
      valorUnit: number;        // valor unitÃ¡rio sem desconto
      desconto: number;         // valor R$ do desconto (nÃ£o percentual)
      descricao: string;
      grupo?: number;
      subgrupo?: number;
      fornecedor?: string;      // CNPJ
      tributo?: string;
    }>;
    pagamentos?: Array<{        // pagamentos da venda â€” 1 linha por mÃ©todo
      metodo: string;           // 'PIX', 'DINHEIRO', 'MASTERCARD', etc.
      valor: number;
    }>;
    operadorCode?: number;      // 0 se sem mapeamento
    operadorName?: string;      // nome do operador â€” faz lookup automÃ¡tico se code nÃ£o vier
    vendedorCode?: number;      // codigo do funcionÃ¡rio vendedor
    vendedorName?: string;      // nome da vendedora â€” faz lookup automÃ¡tico se code nÃ£o vier
    clienteCode?: number;       // 0 se sem cadastro
    clienteCpf?: string;        // CPF â€” faz lookup em clientes pra resolver clienteCode
    nomeCliente?: string;       // vai pra coluna NOMECLIENTE em caixa (e usado no fallback do lookup)
    obsPedido?: string;
  }): Promise<{
    ok: boolean;
    mode: 'shadow' | 'real';
    numero?: number;
    registros?: number[];
    sqlExecuted: string[];
    error?: string;
  }> {
    const sqlExecuted: string[] = [];
    const mode: 'shadow' | 'real' = this.isPdvWriteEnabled ? 'real' : 'shadow';

    if (!this.pool) {
      return { ok: false, mode, sqlExecuted, error: 'Pool ERP nÃ£o inicializado' };
    }
    if (!input.items?.length) {
      return { ok: false, mode, sqlExecuted, error: 'Sem itens pra gravar' };
    }
    if (!input.storeCode) {
      return { ok: false, mode, sqlExecuted, error: 'storeCode obrigatÃ³rio' };
    }

    // Normaliza storeCode pra char(2)
    const lojaCode = String(input.storeCode).padStart(2, '0').slice(-2);

    // â”€â”€â”€ MODO SHADOW: sÃ³ monta SQL e loga, sem executar â”€â”€â”€
    if (mode === 'shadow') {
      sqlExecuted.push(`SELECT @numero := COALESCE(MAX(NUMERO), 0) + 1 FROM caixa FOR UPDATE`);
      for (const it of input.items) {
        const valorTotal = (it.valorUnit * it.qty) - (it.desconto || 0);
        sqlExecuted.push(
          `INSERT INTO caixa (NUMERO, CODIGO, DATA, DATAFEC, CLIENTE, DESCRICAO, ` +
          `GRUPO, QUANTIDADE, VALOR, DESCONTO, VALORTOTAL, VALORDESCONTO, ` +
          `OPERADOR, VENDEDOR, FORNECEDOR, SUBGRUPO, HORA, TRIBUTO, ` +
          `NOMECLIENTE, OBS_PEDIDO, LOJA) VALUES (` +
          `@numero, '${it.sku}', CURDATE(), CURDATE(), ${input.clienteCode || 0}, ` +
          `'${(it.descricao || '').replace(/'/g, "''").slice(0, 100)}', ` +
          `${it.grupo || 0}, ${it.qty}, ${it.valorUnit}, ${it.desconto || 0}, ` +
          `${valorTotal}, ${valorTotal}, ${input.operadorCode || 0}, ` +
          `${input.vendedorCode || 0}, '${(it.fornecedor || '').slice(0, 18)}', ` +
          `${it.subgrupo || 0}, CURTIME(), '${(it.tributo || '').slice(0, 4)}', ` +
          `'${(input.nomeCliente || '').replace(/'/g, "''").slice(0, 50)}', ` +
          `'${(input.obsPedido || '').replace(/'/g, "''").slice(0, 50)}', '${lojaCode}')`
        );
      }
      // Adiciona SQLs de fechamento (1 por pagamento) tambÃ©m em SHADOW
      const pagamentos = input.pagamentos || [];
      for (const p of pagamentos) {
        const map = this.mapPagamentoFechamento(p.metodo);
        const valor = Number(p.valor) || 0;
        if (valor <= 0) continue;
        const colExtra = map.coluna ? `, ${map.coluna}` : '';
        const valExtra = map.coluna ? `, ${valor}` : '';
        sqlExecuted.push(
          `INSERT INTO fechamento (VENDA, DATA, FORMA, VALOR${colExtra}, LOJA) ` +
          `VALUES (@numero, CURDATE(), '${map.forma}', ${valor}${valExtra}, '${lojaCode}')`
        );
      }
      this.logger.warn(
        `[gravarVendaPdv SHADOW] LOJA=${lojaCode} items=${input.items.length} pagamentos=${pagamentos.length} | ` +
        `total=R$${input.items.reduce((s, i) => s + (i.valorUnit * i.qty - (i.desconto || 0)), 0).toFixed(2)} | ` +
        `SQLs gerados: ${sqlExecuted.length}`,
      );
      // Loga SQL de fechamento (mais Ãºtil pra debug que o INSERT em caixa)
      const sqlFechamento = sqlExecuted.find((s) => s.includes('INTO fechamento'));
      this.logger.warn(`[gravarVendaPdv SHADOW] sample fechamento: ${sqlFechamento || sqlExecuted[1] || sqlExecuted[0]}`);
      return { ok: true, mode, sqlExecuted };
    }

    // â”€â”€â”€ MODO REAL: executa em transaÃ§Ã£o ACID â”€â”€â”€
    // Lookup automÃ¡tico de VENDEDOR/OPERADOR/CLIENTE se sÃ³ veio o nome/cpf
    let vendedorCodeFinal = input.vendedorCode || 0;
    let operadorCodeFinal = input.operadorCode || 0;
    let clienteCodeFinal = input.clienteCode || 0;
    if (!vendedorCodeFinal && input.vendedorName) {
      vendedorCodeFinal = await this.lookupFuncionarioCode(input.vendedorName, lojaCode);
      if (vendedorCodeFinal) {
        this.logger.log(`[gravarVendaPdv] vendedor "${input.vendedorName}" â†’ CODIGO=${vendedorCodeFinal} (loja ${lojaCode})`);
      } else {
        this.logger.warn(`[gravarVendaPdv] vendedor "${input.vendedorName}" nÃ£o encontrado em funcionarios`);
      }
    }
    if (!operadorCodeFinal && input.operadorName) {
      operadorCodeFinal = await this.lookupFuncionarioCode(input.operadorName, lojaCode);
    }
    if (!clienteCodeFinal && (input.clienteCpf || input.nomeCliente)) {
      clienteCodeFinal = await this.lookupClienteCode({
        cpf: input.clienteCpf,
        nome: input.nomeCliente,
        telefone: (input as any).clientePhone,
      });
      if (clienteCodeFinal) {
        this.logger.log(`[gravarVendaPdv] cliente "${input.nomeCliente || input.clienteCpf}" â†’ CODIGO=${clienteCodeFinal}`);
      }
    }

    const conn = await this.pool.getConnection();
    const registros: number[] = [];
    let numero: number = 0;
    try {
      await conn.beginTransaction();

      // 1. Pega prÃ³ximo NUMERO global com FOR UPDATE pra evitar race
      const [maxRows]: any = await conn.query(
        `SELECT COALESCE(MAX(NUMERO), 0) + 1 AS prox FROM caixa FOR UPDATE`,
      );
      numero = Number(maxRows[0]?.prox) || 1;

      // 2. INSERT cada item
      for (const it of input.items) {
        const valorTotal = (it.valorUnit * it.qty) - (it.desconto || 0);
        const [result]: any = await conn.query(
          `INSERT INTO caixa (
            NUMERO, CODIGO, DATA, DATAFEC, CLIENTE, DESCRICAO,
            GRUPO, QUANTIDADE, VALOR, DESCONTO, VALORTOTAL, VALORDESCONTO,
            OPERADOR, VENDEDOR, FORNECEDOR, SUBGRUPO, HORA, TRIBUTO,
            NOMECLIENTE, OBS_PEDIDO, LOJA
          ) VALUES (
            ?, ?, CURDATE(), CURDATE(), ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, CURTIME(), ?,
            ?, ?, ?
          )`,
          [
            numero,
            String(it.sku || '').slice(0, 13),
            clienteCodeFinal,
            String(it.descricao || '').slice(0, 100),
            it.grupo || 0,
            it.qty,
            it.valorUnit,
            it.desconto || 0,
            valorTotal,
            valorTotal,
            operadorCodeFinal,
            vendedorCodeFinal,
            String(it.fornecedor || '').slice(0, 18),
            it.subgrupo || 0,
            String(it.tributo || '').slice(0, 4),
            String(input.nomeCliente || '').slice(0, 50),
            String(input.obsPedido || '').slice(0, 50),
            lojaCode,
          ],
        );
        registros.push(Number(result.insertId));
        sqlExecuted.push(`INSERT caixa NUMERO=${numero} CODIGO=${it.sku} â†’ REGISTRO=${result.insertId}`);
      }

      // INSERT em `fechamento` (1 linha por pagamento) â€” registra forma de pgto
      // por venda. Sem isso, "Movimento DiÃ¡rio de Caixa" do Wincred mostra 0
      // em DINHEIRO/PIX/etc.
      const pagamentos = input.pagamentos || [];
      for (const p of pagamentos) {
        const map = this.mapPagamentoFechamento(p.metodo);
        const valor = Number(p.valor) || 0;
        if (valor <= 0) continue;
        // Monta INSERT dinamicamente: sempre seta FORMA e VALOR, e se houver
        // coluna especÃ­fica (DINHEIRO, MASTERCARD, etc.) seta ela tambem.
        const cols = ['VENDA', 'DATA', 'FORMA', 'VALOR', 'LOJA'];
        const vals: any[] = [numero, new Date(), map.forma, valor, lojaCode];
        const placeholders = ['?', '?', '?', '?', '?'];
        if (map.coluna) {
          cols.splice(4, 0, map.coluna); // antes de LOJA
          vals.splice(4, 0, valor);
          placeholders.splice(4, 0, '?');
        }
        await conn.query(
          `INSERT INTO fechamento (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
          vals,
        );
        sqlExecuted.push(`INSERT fechamento VENDA=${numero} FORMA=${map.forma} VALOR=${valor}`);
        // Nota: NÃƒO fazemos UPDATE em caixa_diario â€” o "Processa Movimento" do
        // Wincred lÃª de fechamento (DINHEIRO/PIX/CREDIARIO funcionam) e de outra
        // fonte interna (cartÃµes â€” ainda nÃ£o rastreada). Qualquer UPDATE direto
        // em caixa_diario Ã© sobrescrito pelo Processa.
      }

      await conn.commit();
      this.logger.log(
        `[gravarVendaPdv REAL OK] LOJA=${lojaCode} NUMERO=${numero} ` +
        `items=${input.items.length} registros=${registros.length} pagamentos=${pagamentos.length}`,
      );
      return { ok: true, mode, numero, registros, sqlExecuted };
    } catch (e: any) {
      try { await conn.rollback(); } catch { /* ignore */ }
      const msg = String(e?.message || e);
      this.logger.error(`[gravarVendaPdv REAL FALHOU rollback] ${msg}`);
      return { ok: false, mode, sqlExecuted, error: msg };
    } finally {
      conn.release();
    }
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     Sprint 4 â€” Vendas histÃ³ricas por REF + loja.
     Usado pra escolher loja consolidadora (top vendedora ganha desempate).
     Default: Ãºltimos 180 dias. JOIN caixa Ã— produtos por REF.
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
  async getSalesByRef(ref: string, dias: number = 180): Promise<{
    vendas: Array<{ loja: string; qty: number; valor: number }>;
    totalQty: number;
    totalValor: number;
    dias: number;
  }> {
    const empty = { vendas: [], totalQty: 0, totalValor: 0, dias };
    if (!this.pool || !ref?.trim()) return empty;
    const refClean = String(ref).trim();
    const diasClamped = Math.max(7, Math.min(730, Math.round(dias) || 180));

    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT c.LOJA AS loja,
                SUM(c.QUANTIDADE) AS qty,
                SUM(c.VALORTOTAL) AS valor
           FROM caixa c
           INNER JOIN produtos p ON CAST(c.CODIGO AS UNSIGNED) = CAST(p.CODIGO AS UNSIGNED)
          WHERE p.REF = ?
            AND c.DATA >= DATE_SUB(NOW(), INTERVAL ? DAY)
            AND (c.MARCADO IS NULL OR c.MARCADO <> 'SIM')
          GROUP BY c.LOJA
          ORDER BY qty DESC`,
        [refClean, diasClamped],
      );
      const vendas: Array<{ loja: string; qty: number; valor: number }> = [];
      let totalQty = 0;
      let totalValor = 0;
      for (const r of rows as any[]) {
        const loja = String(r.loja || '').trim().toUpperCase();
        if (!loja || ['SITE', 'PF'].includes(loja)) continue;
        const qty = Number(r.qty) || 0;
        const valor = Number(r.valor) || 0;
        vendas.push({ loja, qty, valor });
        totalQty += qty;
        totalValor += valor;
      }
      return { vendas, totalQty, totalValor, dias: diasClamped };
    } catch (e) {
      this.logger.warn(`getSalesByRef falhou pra ref=${refClean}: ${(e as Error).message}`);
      return empty;
    }
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     Sprint 1 â€” VisÃ£o RAIZ (REF + COR), uma linha por referÃªncia.
     Endpoint usado pela tela /retaguarda/distribuicao-estoque (modo "raiz").
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

     DiferenÃ§a pro getStockDistribution clÃ¡ssico (que retorna 1 linha por
     CODIGO = REF+COR+TAMANHO):
       - aqui agrupa por REF+COR
       - traz DATAALT, GRUPO, SUBGRUPO pra alimentar o classificador
       - soma estoque por loja (somando todos os tamanhos)
       - conta variaÃ§Ãµes + tamanhos distintos pra detectar fragmentaÃ§Ã£o

     Performance: faz 2 queries sÃ³ (produtos + estoque), agrupa em memÃ³ria.
     Limite alto (default 3000 REFs) â€” controlÃ¡vel via filters.limit.
  */
  async getStockDistributionByRef(filters: {
    grupoCodigo?: number | null;
    subgrupoCodigo?: number | null;
    search?: string | null;
    tamanhos?: string[] | null;
    diasMaximos?: number | null;   // DATAALT >= NOW() - X dias
    diasMinimos?: number | null;   // DATAALT <= NOW() - X dias  (peÃ§as "velhas")
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
      tamanhos: string[];        // tamanhos distintos com estoque > 0 na rede
      variacoes: number;          // qtde de CODIGOs (REF+COR+TAM) com estoque > 0
      lojasComEstoque: number;
      estoquePorLoja: Record<string, number>;
      total: number;
    }>;
    lojas: string[];
    totalRows: number;
    truncated: boolean;
  }> {
    if (!this.pool) {
      return { refs: [], lojas: [], totalRows: 0, truncated: false };
    }

    const limit = Math.max(50, Math.min(5000, filters.limit || 3000));
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

    // Detecta colunas opcionais
    const dataCol = (await this.pickCol([
      'DATAALT', 'DATA_ALT', 'DT_ALT', 'DATAALTERACAO', 'DATA_ALTERACAO',
      'DATACADASTRO', 'DT_CADASTRO',
    ])) as string | null;
    const subgrupoCol = (await this.pickCol(['SUBGRUPO', 'SUB_GRUPO'])) as string | null;
    const grupoCol = (await this.pickCol(['GRUPO'])) as string | null;

    // â”€â”€ 1) Query principal: produtos agrupados por REF+COR â”€â”€
    const conds: string[] = [
      `TRIM(UPPER(COALESCE(p.TAMANHO, ''))) IN (${tamanhos.map(() => '?').join(',')})`,
      `COALESCE(p.REF, '') <> ''`,
    ];
    const vals: any[] = [...tamanhos];

    if (filters.grupoCodigo && grupoCol) {
      conds.push(`p.\`${grupoCol}\` = ?`);
      vals.push(filters.grupoCodigo);
    }
    if (filters.subgrupoCodigo && subgrupoCol) {
      conds.push(`p.\`${subgrupoCol}\` = ?`);
      vals.push(filters.subgrupoCodigo);
    }
    if (filters.search?.trim()) {
      const tokens = filters.search.trim().toUpperCase().split(/\s+/).filter(Boolean);
      for (const tok of tokens) {
        const term = `%${tok}%`;
        conds.push(
          `(UPPER(p.REF) LIKE ? OR UPPER(COALESCE(p.DESCRICAOCOMPLETA, '')) LIKE ? OR p.CODIGO LIKE ?)`,
        );
        vals.push(term, term, term);
      }
    }
    if (filters.diasMaximos != null && dataCol) {
      // peÃ§as "novas": DATAALT > NOW() - diasMaximos
      conds.push(`p.\`${dataCol}\` >= DATE_SUB(NOW(), INTERVAL ? DAY)`);
      vals.push(Math.max(1, Math.round(filters.diasMaximos)));
    }
    if (filters.diasMinimos != null && dataCol) {
      // peÃ§as "velhas": DATAALT < NOW() - diasMinimos
      conds.push(`p.\`${dataCol}\` <= DATE_SUB(NOW(), INTERVAL ? DAY)`);
      vals.push(Math.max(1, Math.round(filters.diasMinimos)));
    }

    // SELECTs opcionais
    const selectExtras: string[] = [];
    if (dataCol) selectExtras.push(`MAX(p.\`${dataCol}\`) AS data_alt`);
    if (grupoCol) selectExtras.push(`MAX(p.\`${grupoCol}\`) AS grupo_codigo`);
    if (subgrupoCol) selectExtras.push(`MAX(p.\`${subgrupoCol}\`) AS subgrupo_codigo`);

    const sqlMain = `
      SELECT
        p.REF AS ref,
        COALESCE(p.COR, '') AS cor,
        MAX(COALESCE(p.DESCRICAOCOMPLETA, '')) AS descricao,
        ROUND(AVG(COALESCE(p.VENDAUN, 0)), 2) AS preco,
        GROUP_CONCAT(DISTINCT p.CODIGO ORDER BY p.TAMANHO) AS codigos,
        GROUP_CONCAT(DISTINCT TRIM(p.TAMANHO) ORDER BY p.TAMANHO) AS tamanhos
        ${selectExtras.length > 0 ? ',' + selectExtras.join(',') : ''}
      FROM produtos p
      WHERE ${conds.join(' AND ')}
      GROUP BY p.REF, COALESCE(p.COR, '')
      ORDER BY MAX(COALESCE(p.DESCRICAOCOMPLETA, '')) ASC
      LIMIT ?
    `;
    vals.push(limit);

    this.logger.log(
      `[erp] getStockDistributionByRef mode=${mode} grupo=${filters.grupoCodigo || 'all'} ` +
      `sub=${filters.subgrupoCodigo || 'all'} search=${filters.search || '(none)'} ` +
      `dataCol=${dataCol || 'none'} subgrupoCol=${subgrupoCol || 'none'}`,
    );

    const t0 = Date.now();
    let rawRefs: any[] = [];
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sqlMain, vals);
      rawRefs = rows as any[];
    } catch (e) {
      this.logger.error(`getStockDistributionByRef falhou: ${(e as Error).message}`);
      return { refs: [], lojas: [], totalRows: 0, truncated: false };
    }
    this.logger.log(
      `[erp] getStockDistributionByRef: ${rawRefs.length} refs em ${Date.now() - t0}ms`,
    );

    if (rawRefs.length === 0) {
      return { refs: [], lojas: [], totalRows: 0, truncated: false };
    }

    // â”€â”€ 2) Pega estoque agregado de todos os CODIGOs envolvidos â”€â”€
    const allCodigos = new Set<string>();
    for (const r of rawRefs) {
      const csv = String(r.codigos || '');
      for (const c of csv.split(',')) {
        const trimmed = c.trim();
        if (trimmed) allCodigos.add(trimmed);
      }
    }
    const codigosArr = Array.from(allCodigos);
    const estoquePorCodigo = new Map<string, Record<string, number>>();
    const lojasSet = new Set<string>();

    if (codigosArr.length > 0) {
      const CHUNK = 5000;
      for (let i = 0; i < codigosArr.length; i += CHUNK) {
        const slice = codigosArr.slice(i, i + CHUNK);
        const ph = slice.map(() => '?').join(',');
        const sqlEst = `
          SELECT CODIGO, LOJA, SUM(ESTOQUE) AS est
            FROM estoque
           WHERE CAST(CODIGO AS UNSIGNED) IN (${slice.map(() => 'CAST(? AS UNSIGNED)').join(',')})
           GROUP BY CODIGO, LOJA
        `;
        try {
          const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sqlEst, slice);
          for (const r of rows as any[]) {
            const cod = String(r.CODIGO).trim();
            const loja = String(r.LOJA || '').trim().toUpperCase();
            if (!loja || ignoredLojas.has(loja)) continue;
            const qty = Number(r.est) || 0;
            if (qty === 0) continue;
            if (!estoquePorCodigo.has(cod)) estoquePorCodigo.set(cod, {});
            const mapa = estoquePorCodigo.get(cod)!;
            mapa[loja] = (mapa[loja] || 0) + qty;
            lojasSet.add(loja);
          }
        } catch (e) {
          this.logger.warn(`getStockDistributionByRef chunk estoque falhou: ${(e as Error).message}`);
        }
      }
    }

    // â”€â”€ 3) Resolve nomes de grupo/subgrupo (1 query batch) â”€â”€
    const grupoCodes = new Set<number>();
    const subgrupoCodes = new Set<number>();
    for (const r of rawRefs) {
      if (r.grupo_codigo != null) grupoCodes.add(Number(r.grupo_codigo));
      if (r.subgrupo_codigo != null) subgrupoCodes.add(Number(r.subgrupo_codigo));
    }
    const grupoNames = new Map<number, string>();
    const subgrupoNames = new Map<number, string>();
    if (grupoCodes.size > 0) {
      try {
        const arr = Array.from(grupoCodes);
        const ph = arr.map(() => '?').join(',');
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO, GRUPO FROM grupos WHERE CODIGO IN (${ph})`,
          arr,
        );
        for (const r of rows as any[]) {
          grupoNames.set(Number(r.CODIGO), String(r.GRUPO || '').trim());
        }
      } catch (e) {
        this.logger.warn(`fetch grupos falhou: ${(e as Error).message}`);
      }
    }
    if (subgrupoCodes.size > 0) {
      try {
        const arr = Array.from(subgrupoCodes);
        const ph = arr.map(() => '?').join(',');
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO, SUBGRUPO FROM subgrupos WHERE CODIGO IN (${ph})`,
          arr,
        );
        for (const r of rows as any[]) {
          subgrupoNames.set(Number(r.CODIGO), String(r.SUBGRUPO || '').trim());
        }
      } catch (e) {
        // Subgrupo tem CODIGO composto (GRUPO+CODIGO) em alguns schemas â€” ignora se falhar
        this.logger.warn(`fetch subgrupos falhou: ${(e as Error).message}`);
      }
    }

    // â”€â”€ 4) Monta a lista final â”€â”€
    type RefRow = {
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
    };
    const out: RefRow[] = [];

    for (const r of rawRefs) {
      const codigos = String(r.codigos || '').split(',').map((c) => c.trim()).filter(Boolean);
      const estoquePorLoja: Record<string, number> = {};
      let total = 0;
      const variacoesComEstoque = new Set<string>();
      const tamanhosComEstoque = new Set<string>();

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

      // tamanhos com estoque = sÃ³ os que aparecem em variacoesComEstoque
      // (precisa puxar TAMANHO de cada codigo â€” usa a lista do GROUP_CONCAT)
      const tamanhosCsv = String(r.tamanhos || '');
      const todosTamanhos = tamanhosCsv.split(',').map((t) => t.trim()).filter(Boolean);
      // NÃ£o temos mapeamento codigoâ†’tamanho aqui sem extra query.
      // SoluÃ§Ã£o barata: marcar todos como "potenciais" e refinar no frontend
      // se necessÃ¡rio. Por ora, lista os tamanhos da REF+COR (independente de estoque).
      for (const t of todosTamanhos) tamanhosComEstoque.add(t);

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
        tamanhos: Array.from(tamanhosComEstoque).sort((a, b) => {
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

    // â”€â”€ 5) Filtra: REFs sem estoque (total=0) ou abaixo do minTotal â”€â”€
    let filtered = out.filter((r) => r.total > 0);
    if (minTotal > 0) {
      filtered = filtered.filter((r) => r.total >= minTotal);
    }
    if (mode === 'imbalanced') {
      // "desequilibrada" no nÃ­vel raiz = tem alguma loja com 0 E outra com 2+
      filtered = filtered.filter((r) => {
        const vals = Object.values(r.estoquePorLoja);
        if (vals.length === 0) return false;
        const max = Math.max(...vals);
        const min = Math.min(0, ...vals);
        return max >= 2 && min === 0;
      });
    }

    const lojas = Array.from(lojasSet).filter((l) => !ignoredLojas.has(l)).sort();

    return {
      refs: filtered,
      lojas,
      totalRows: filtered.length,
      truncated: rawRefs.length >= limit,
    };
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     DevoluÃ§Ã£o manual Giga (opÃ§Ã£o C).
     Verifica se uma peÃ§a (SKU) foi vendida numa loja especÃ­fica nos Ãºltimos
     N dias. Usado pra autorizar devoluÃ§Ã£o de venda antiga sem cupom flowops.

     Regra: vendedora SÃ“ pode aceitar devoluÃ§Ã£o de peÃ§a que foi vendida
     naquela loja (anti-fraude). Se SKU nunca passou pelo caixa daquela
     loja na janela, bloqueia.
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
  async lookupSaleHistoryByStoreAndSku(
    storeCode: string,
    sku: string,
    dias: number = 60,
  ): Promise<{
    found: boolean;
    salesCount: number;
    vendas: Array<{ data: string; numero: string; valor: number; quantidade: number }>;
    produto: { codigo: string; descricao: string; cor: string | null; tamanho: string | null; preco: number } | null;
  }> {
    const empty = { found: false, salesCount: 0, vendas: [], produto: null };
    if (!storeCode?.trim() || !sku?.trim()) return empty;
    const lojaClean = String(storeCode).trim().toUpperCase();
    const diasClamped = Math.max(1, Math.min(3650, Math.round(dias) || 60));
    try {
      if (await this.caixaMovUsable(new Date(Date.now() - diasClamped * 86400_000))) {
        return await this.lookupSaleHistoryFromMirror(lojaClean, sku.trim(), diasClamped) as any;
      }
    } catch (e) {
      this.logger.warn(`[mirror-reads] lookupSaleHistoryByStoreAndSku: ${(e as Error).message} → Giga ao vivo`);
    }
    if (!this.pool) return empty;

    // Gera variantes de zero-padding (igual ao resto do sistema)
    const variants = this.skuVariants(sku.trim());
    if (variants.length === 0) return empty;

    try {
      // 1) Busca produto + preÃ§o atual no Giga
      const ph = variants.map(() => '?').join(',');
      const [prodRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO, COALESCE(DESCRICAOCOMPLETA, '') AS descricao,
                COR, TAMANHO,
                ROUND(COALESCE(VENDAUN, 0), 2) AS preco
         FROM produtos
         WHERE CODIGO IN (${ph})
         LIMIT 1`,
        variants,
      );
      const prodRow = (prodRows as any[])[0];
      const produto = prodRow
        ? {
            codigo: String(prodRow.CODIGO).trim(),
            descricao: String(prodRow.descricao || '').trim(),
            cor: prodRow.COR ? String(prodRow.COR).trim() : null,
            tamanho: prodRow.TAMANHO ? String(prodRow.TAMANHO).trim() : null,
            preco: Number(prodRow.preco) || 0,
          }
        : null;

      // 2) Busca histÃ³rico de vendas dessa peÃ§a nessa loja na janela
      const [salesRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT
            DATE_FORMAT(c.DATA, '%Y-%m-%d') AS data,
            c.NUMERO AS numero,
            c.QUANTIDADE AS quantidade,
            c.VALORTOTAL AS valor
         FROM caixa c
         WHERE c.LOJA = ?
           AND c.CODIGO IN (${ph})
           AND c.DATA >= DATE_SUB(NOW(), INTERVAL ? DAY)
           AND (c.MARCADO IS NULL OR c.MARCADO <> 'SIM')
           AND c.QUANTIDADE > 0
         ORDER BY c.DATA DESC
         LIMIT 20`,
        [lojaClean, ...variants, diasClamped],
      );

      const vendas = (salesRows as any[]).map((r) => ({
        data: String(r.data || ''),
        numero: String(r.numero || ''),
        quantidade: Number(r.quantidade) || 0,
        valor: Number(r.valor) || 0,
      }));

      return {
        found: vendas.length > 0,
        salesCount: vendas.length,
        vendas,
        produto,
      };
    } catch (e: any) {
      this.logger.warn(
        `lookupSaleHistoryByStoreAndSku falhou (loja=${lojaClean}, sku=${sku}): ${e?.message || e}`,
      );
      return empty;
    }
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     FATURAMENTO POR LOJA â€” usado pela tela /retaguarda/faturamento.

     Agrega caixa.VALORTOTAL + caixa.QUANTIDADE + COUNT(DISTINCT NUMERO)
     por loja num intervalo de datas. Ignora MARCADO='SIM' (linhas canceladas).

     Resultado: lista de { storeCode, faturamento, cupons, pecas, ticketMedio }.

     NÃ£o inclui composiÃ§Ã£o SITE (Giga + Flowops) â€” quem combina Ã© o caller
     (controller), pra deixar service genÃ©rico.
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
  async getFaturamentoPorLoja(inicio: Date, fim: Date): Promise<
    Array<{ storeCode: string; faturamento: number; cupons: number; pecas: number; ticketMedio: number }>
  > {
    if (!this.pool) return [];
    try {
      // IMPORTANTE: usa DATAFEC (data de fechamento do cupom), nÃ£o DATA.
      // O Wincred filtra por DATAFEC nas telas Vendas e Ranking. Vendas
      // feitas tarde da noite (lanÃ§adas com DATA do dia X mas sÃ³ fechadas
      // no dia X+1) ficavam fora no antigo filtro por DATA. Trocando pra
      // DATAFEC, bate exato com Wincred em todas as lojas.
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT
            c.LOJA AS storeCode,
            COUNT(DISTINCT c.NUMERO) AS cupons,
            SUM(c.QUANTIDADE) AS pecas,
            SUM(c.VALORTOTAL) AS faturamento
         FROM caixa c
         WHERE c.DATAFEC >= ?
           AND c.DATAFEC <  ?
           AND (c.MARCADO IS NULL OR c.MARCADO <> 'SIM')
         GROUP BY c.LOJA
         ORDER BY faturamento DESC`,
        [inicio, fim],
      );
      return (rows as any[]).map((r) => {
        const faturamento = Number(r.faturamento) || 0;
        const cupons = Number(r.cupons) || 0;
        const pecas = Number(r.pecas) || 0;
        return {
          storeCode: String(r.storeCode || '').trim().toUpperCase(),
          faturamento,
          cupons,
          pecas,
          ticketMedio: cupons > 0 ? faturamento / cupons : 0,
        };
      });
    } catch (e: any) {
      this.logger.error(`getFaturamentoPorLoja falhou: ${e?.message || e}`);
      return [];
    }
  }

  /**
   * SCHEMA DIAGNOSTIC â€” retorna as colunas da tabela `caixa` + soma de
   * TODAS as colunas numÃ©ricas pra uma loja num perÃ­odo. Usado pra
   * descobrir qual coluna bate com "TOTAL VENDAS R$" do Wincred.
   *
   * O Wincred mostra "produtos vendidos" â€” provavelmente Ã© uma coluna
   * tipo VALORUNITARIO*QUANTIDADE ou VALORLIQUIDO, nÃ£o o VALORTOTAL
   * (que pode incluir acrÃ©scimos/juros do crediÃ¡rio).
   */
  /**
   * Lista funcionÃ¡rios (vendedoras) ATIVAS de uma loja no Wincred.
   * Filtra por status ativo + LOJA. Usado pelo sync /retaguarda/vendedoras
   * pra popular PdvActiveSeller.
   */
  /**
   * FONTE DO ESPELHO giga_caixa_mov: linhas cruas da `caixa` num intervalo
   * [from, to). Usado SÓ pelo GigaMirrorService (janela de 3 dias no cron +
   * backfill mensal no boot).
   */
  /** Colunas realmente existentes na `caixa` (o schema Wincred varia por
   *  instalação — ex.: CONTROLE não existe na da Lurd's e derrubou o backfill
   *  de 14/07). Sonda uma vez e monta o SELECT só com o que existe. */
  private caixaColsCache: { cols: Set<string>; at: number } | null = null;
  private async caixaColumns(): Promise<Set<string>> {
    const now = Date.now();
    if (this.caixaColsCache && now - this.caixaColsCache.at < 6 * 3600_000) {
      return this.caixaColsCache.cols;
    }
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(`SHOW COLUMNS FROM caixa`);
    const cols = new Set((rows as any[]).map((c) => String(c.Field || '').toUpperCase()));
    this.caixaColsCache = { cols, at: now };
    return cols;
  }

  async getCaixaMovRows(from: Date, to: Date): Promise<any[]> {
    if (!this.pool) return [];
    const cols = await this.caixaColumns();
    const wanted = [
      'REGISTRO', 'NUMERO', 'CONTROLE', 'CODIGO', 'DATA', 'DATAFEC', 'HORA', 'DESCRICAO',
      'QUANTIDADE', 'VALOR', 'VALORTOTAL', 'OPERADOR', 'VENDEDOR', 'CLIENTE', 'LOJA', 'MARCADO',
      // v2 — colunas ricas do schema Lurd's (tela de vendas do caixa etc.)
      'CODCLIENTE', 'NOMECLIENTE', 'CPF', 'VENDEDORA', 'VENDEDORACODE', 'FPAG',
      'OBS_PEDIDO', 'VALORUNITARIO',
    ];
    const present = wanted.filter((c) => cols.has(c));
    for (const req of ['REGISTRO', 'CODIGO', 'DATA', 'LOJA']) {
      if (!present.includes(req)) {
        throw new Error(`caixa sem coluna obrigatória ${req} — espelho caixa_mov não suportado neste schema`);
      }
    }
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT ${present.join(', ')}
         FROM caixa
        WHERE DATA >= ? AND DATA < ?`,
      [from, to],
    );
    return rows as any[];
  }

  /**
   * FONTE DO ESPELHO wincred_funcionarios: todas as vendedoras (com flag de
   * inatividade quando a coluna existir). Usado SÓ pelo GigaMirrorService.
   */
  async getFuncionariosRawAll(): Promise<Array<{ codigo: string; nome: string | null; apelido: string | null; loja: string | null; inativo: boolean }>> {
    if (!this.pool) return [];
    let rows: mysql.RowDataPacket[] = [];
    let hasFlag = true;
    try {
      const [r] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO, NOME, APELIDO, LOJA, FLAG_INATIVO FROM funcionarios`,
      );
      rows = r;
    } catch {
      hasFlag = false;
      const [r] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO, NOME, APELIDO, LOJA FROM funcionarios`,
      );
      rows = r;
    }
    return (rows as any[])
      .map((r) => ({
        codigo: String(r.CODIGO || '').trim(),
        nome: r.NOME ? String(r.NOME).trim() : null,
        apelido: r.APELIDO ? String(r.APELIDO).trim() : null,
        loja: r.LOJA ? String(r.LOJA).trim().toUpperCase() : null,
        inativo: hasFlag
          ? !(r.FLAG_INATIVO == null || r.FLAG_INATIVO === 'N' || r.FLAG_INATIVO === 0 || r.FLAG_INATIVO === '0')
          : false,
      }))
      .filter((r) => r.codigo);
  }

  async getFuncionariosAtivosByLoja(storeCodes: string[]): Promise<Array<{
    codigo: string;
    nome: string;
    apelido: string | null;
    storeCode: string;
  }>> {
    const codes = storeCodes.filter(Boolean);
    if (codes.length === 0) return [];
    if (this.mirrorReadsEnabled) {
      try {
        if (await this.mirrorFuncReady()) {
          // Lojas com e sem zero à esquerda (mesma tolerância dos outros paths).
          const lojaSet = new Set<string>();
          for (const c of codes) {
            const s = String(c).trim().toUpperCase();
            lojaSet.add(s);
            if (/^\d{1,2}$/.test(s)) {
              lojaSet.add(s.padStart(2, '0'));
              lojaSet.add(s.replace(/^0+/, '') || s);
            }
          }
          const rows: any[] = await (this.prismaFlow as any).wincredFuncionario.findMany({
            where: { loja: { in: Array.from(lojaSet) }, inativo: false },
            orderBy: [{ loja: 'asc' }, { nome: 'asc' }],
          });
          return rows
            .map((r) => ({
              codigo: String(r.codigo || '').trim(),
              nome: String(r.nome || '').trim(),
              apelido: r.apelido ? String(r.apelido).trim() : null,
              storeCode: String(r.loja || '').trim().toUpperCase(),
            }))
            .filter((r) => r.codigo && r.nome);
        }
      } catch (e) {
        this.logger.warn(`[mirror-reads] getFuncionariosAtivosByLoja: ${(e as Error).message} → Giga ao vivo`);
      }
    }
    if (!this.pool) return [];
    try {
      // Tenta primeiro com FLAG_INATIVO (estrutura comum do Wincred).
      // Se nÃ£o existir essa coluna, cai pro select sem filtro e o caller filtra.
      let rows: mysql.RowDataPacket[] = [];
      try {
        const [r] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO, NOME, APELIDO, LOJA
             FROM funcionarios
            WHERE LOJA IN (?)
              AND (FLAG_INATIVO IS NULL OR FLAG_INATIVO = 'N' OR FLAG_INATIVO = 0)
            ORDER BY LOJA, NOME`,
          [codes],
        );
        rows = r;
      } catch {
        const [r] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO, NOME, APELIDO, LOJA
             FROM funcionarios
            WHERE LOJA IN (?)
            ORDER BY LOJA, NOME`,
          [codes],
        );
        rows = r;
      }
      return (rows as any[]).map((r) => ({
        codigo: String(r.CODIGO || '').trim(),
        nome: String(r.NOME || '').trim(),
        apelido: r.APELIDO ? String(r.APELIDO).trim() : null,
        storeCode: String(r.LOJA || '').trim().toUpperCase(),
      })).filter((r) => r.codigo && r.nome);
    } catch (e: any) {
      this.logger.error(`getFuncionariosAtivosByLoja falhou: ${e?.message || e}`);
      return [];
    }
  }

  /**
   * Lista TODO o estoque (sku â†’ qty) das lojas dadas no Wincred.
   * Usado pelo StockMirrorService pra sync inicial e periÃ³dico.
   * Filtra ESTOQUE > 0 pra evitar trazer 200k linhas zeradas inÃºteis.
   */
  async getEstoqueFullByLoja(storeCodes: string[]): Promise<Array<{
    sku: string;
    storeCode: string;
    qty: number;
  }>> {
    if (!this.pool) return [];
    const codes = storeCodes.filter(Boolean);
    if (codes.length === 0) return [];
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO AS sku, LOJA AS storeCode, ESTOQUE AS qty
           FROM estoque
          WHERE LOJA IN (?)
            AND ESTOQUE > 0`,
        [codes],
      );
      return (rows as any[]).map((r) => ({
        sku: String(r.sku || '').trim(),
        storeCode: String(r.storeCode || '').trim().toUpperCase(),
        qty: Number(r.qty) || 0,
      }));
    } catch (e: any) {
      this.logger.error(`getEstoqueFullByLoja falhou: ${e?.message || e}`);
      return [];
    }
  }

  /**
   * Marca uma venda do Wincred como CANCELADA (MARCADO='SIM').
   * Usada no fluxo de estorno do flowops â€” remove a venda do faturamento + caixa
   * sem deletar fisicamente (audit trail preservado).
   *
   * Match pela coluna OBS_PEDIDO = 'flowops-{saleIdShort}'.
   * saleIdShort = primeiros 8 chars do UUID do PdvSale.
   */
  async marcarVendaWincredCancelada(input: {
    saleId: string;
    storeCode: string;
  }): Promise<{ ok: boolean; mode: 'shadow' | 'real'; affected?: number; error?: string }> {
    const mode: 'shadow' | 'real' = this.isPdvWriteEnabled ? 'real' : 'shadow';
    if (!this.pool) return { ok: false, mode, error: 'Pool nÃ£o inicializado' };
    const saleIdShort = input.saleId.replace(/-/g, '').slice(0, 8);
    const obsPedido = `flowops-${saleIdShort}`;
    const lojaCode = String(input.storeCode).padStart(2, '0').slice(-2);
    const sql = `UPDATE caixa SET MARCADO='SIM' WHERE OBS_PEDIDO = ? AND LOJA = ?`;
    if (mode === 'shadow') {
      this.logger.warn(`[wincred SHADOW] cancelar venda obsPedido=${obsPedido} loja=${lojaCode}`);
      return { ok: true, mode };
    }
    try {
      const [result] = await this.pool.query<mysql.ResultSetHeader>(sql, [obsPedido, lojaCode]);
      const affected = result.affectedRows;
      this.logger.log(`[wincred] CANCELADO obsPedido=${obsPedido} loja=${lojaCode} (${affected} linhas)`);
      return { ok: true, mode, affected };
    } catch (e: any) {
      this.logger.error(`marcarVendaWincredCancelada falhou: ${e?.message || e}`);
      return { ok: false, mode, error: e?.message || String(e) };
    }
  }

  /**
   * Lista vendas DETALHADAS de uma loja no Wincred (tabela caixa) num perÃ­odo.
   * Usado pelo drill-down da tela /retaguarda/faturamento pra lojas que ainda
   * nÃ£o usam o PDV flowops (vendas direto no Wincred legado).
   *
   * Agrupa por NUMERO (cupom fiscal) â€” cada cupom Ã© uma "venda" mesmo tendo
   * mÃºltiplos itens na tabela caixa.
   */
  async getVendasCaixa(loja: string, from: string, toExclusive: string): Promise<any[]> {
    try {
      if (await this.caixaMovUsable(new Date(`${from}T00:00:00`))) {
        return await this.vendasCaixaFromMirror(loja, from, toExclusive);
      }
    } catch (e) {
      this.logger.warn(`[mirror-reads] getVendasCaixa: ${(e as Error).message} → Giga ao vivo`);
    }
    if (!this.pool) return [];
    // Tenta com o code passado E com padding pra 2 dÃ­gitos (cobre "6" vs "06")
    const codeAsIs = String(loja).trim().toUpperCase();
    const codePadded = String(loja).padStart(2, '0').slice(-2);
    const possibleCodes = Array.from(new Set([codeAsIs, codePadded]));

    try {
      // IMPORTANTE: usa DATAFEC igual ao ranking (getFaturamentoPorLoja).
      // Antes usava DATA â€” vendas tarde da noite ficavam fora porque DATAFEC
      // sÃ³ Ã© preenchido quando fecha o cupom (pode ser dia seguinte).
      const sql = `
        SELECT
          NUMERO,
          DATAFEC,
          DATA,
          LOJA,
          MAX(NOMECLIENTE) as NOME_CLIENTE,
          MAX(CPF) as CPFCNPJ,
          MAX(VENDEDORA) as VENDEDORA,
          MAX(FPAG) as FPAG,
          MAX(VENDEDORACODE) as CODFUNCIONARIO,
          MAX(OBS_PEDIDO) as OBS_PEDIDO,
          ROUND(SUM(VALORUNITARIO * QUANTIDADE), 2) as VALOR_TOTAL,
          SUM(QUANTIDADE) as QTD_ITENS,
          COUNT(*) as QTD_LINHAS
        FROM caixa
        WHERE LOJA IN (?)
          AND DATAFEC >= ?
          AND DATAFEC <  ?
          AND (MARCADO IS NULL OR MARCADO <> 'SIM')
        GROUP BY NUMERO, DATAFEC, DATA, LOJA
        ORDER BY DATAFEC DESC, NUMERO DESC
        LIMIT 500
      `;
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, [possibleCodes, from, toExclusive]);
      this.logger.log(
        `[getVendasCaixa] loja=${possibleCodes.join('|')} period=${from}â†’${toExclusive} â†’ ${rows.length} cupons`,
      );
      return (rows as any[]).map((r) => ({
        numero: r.NUMERO,
        data: r.DATAFEC || r.DATA,
        loja: r.LOJA,
        cliente: r.NOME_CLIENTE,
        cpf: r.CPFCNPJ,
        vendedora: r.VENDEDORA,
        fpag: r.FPAG,
        codFuncionario: r.CODFUNCIONARIO,
        obsPedido: r.OBS_PEDIDO,
        total: Number(r.VALOR_TOTAL) || 0,
        qtdItens: Number(r.QTD_ITENS) || 0,
      }));
    } catch (e: any) {
      this.logger.error(`getVendasCaixa(${loja}) falhou: ${e?.message || e}`);
      return [];
    }
  }

  async getCaixaSchemaDiagnostic(loja: string, from: string, toExclusive: string): Promise<any> {
    if (!this.pool) return { error: 'pool nÃ£o inicializado' };
    try {
      // 1) Lista todas as colunas da tabela
      const [colsRows] = await this.pool.query<mysql.RowDataPacket[]>(`SHOW COLUMNS FROM caixa`);
      const cols = (colsRows as any[]).map((r) => ({
        nome: r.Field,
        tipo: r.Type,
        null: r.Null,
        default: r.Default,
      }));

      // 2) Identifica colunas numÃ©ricas
      const numericTypes = /^(int|tinyint|smallint|mediumint|bigint|decimal|numeric|float|double|real)/i;
      const numericCols = cols.filter((c) => numericTypes.test(c.tipo)).map((c) => c.nome);

      // 3) Soma cada coluna numÃ©rica + combinaÃ§Ãµes comuns
      const sumsParts = numericCols.map((c) => `ROUND(SUM(\`${c}\`), 2) AS \`sum_${c}\``);
      const hasUnit = numericCols.includes('VALORUNITARIO');
      const hasQtd = numericCols.includes('QUANTIDADE');
      if (hasUnit && hasQtd) {
        sumsParts.push(`ROUND(SUM(VALORUNITARIO * QUANTIDADE), 2) AS sum_unitario_x_quantidade`);
      }
      const hasBruto = numericCols.includes('VALORBRUTO');
      const hasDesc = numericCols.includes('DESCONTO');
      if (hasBruto && hasDesc) {
        sumsParts.push(`ROUND(SUM(VALORBRUTO - DESCONTO), 2) AS sum_bruto_menos_desconto`);
      }

      const sql = `
        SELECT
          COUNT(*) AS total_linhas,
          COUNT(DISTINCT NUMERO) AS cupons,
          SUM(QUANTIDADE) AS quantidades,
          ${sumsParts.join(',\n          ')}
        FROM caixa
        WHERE LOJA = ?
          AND DATA >= ?
          AND DATA <  ?
          AND (MARCADO IS NULL OR MARCADO <> 'SIM')
      `;
      const [sumRows] = await this.pool.query<mysql.RowDataPacket[]>(sql, [loja, from, toExclusive]);

      // 4) Amostra de 3 linhas pra ver dados reais
      const [sampleRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT * FROM caixa
         WHERE LOJA = ?
           AND DATA >= ?
           AND DATA <  ?
           AND (MARCADO IS NULL OR MARCADO <> 'SIM')
         ORDER BY DATA DESC, NUMERO DESC
         LIMIT 3`,
        [loja, from, toExclusive],
      );

      return {
        loja,
        from,
        toExclusive,
        colunas: cols,
        colunasNumericas: numericCols,
        somas: (sumRows as any[])[0],
        amostra: sampleRows,
      };
    } catch (e: any) {
      this.logger.error(`getCaixaSchemaDiagnostic falhou: ${e?.message || e}`);
      return { error: String(e?.message || e) };
    }
  }

  /**
   * DiagnÃ³stico DETALHADO de faturamento por loja â€” usado pra debugar
   * divergÃªncia com o Wincred. Quebra cada loja em:
   *  - total de linhas no perÃ­odo
   *  - quantas com MARCADO em cada estado (null, '', 'SIM', outros)
   *  - quantas com VALORTOTAL negativo (devoluÃ§Ãµes/estornos)
   *  - 2 variaÃ§Ãµes de soma com filtros diferentes pra ver o impacto
   */
  async diagnosticoFaturamento(
    from: string,
    toExclusive: string,
    lojas: string[] | null,
  ): Promise<any[]> {
    if (!this.pool) return [];
    const filtroLojas = lojas && lojas.length > 0 ? `AND LOJA IN (${lojas.map(() => '?').join(',')})` : '';
    const params: any[] = [from, toExclusive];
    if (lojas) params.push(...lojas);
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `
        SELECT
          LOJA,
          COUNT(*) AS total_linhas,
          COUNT(CASE WHEN MARCADO IS NULL THEN 1 END) AS marcado_null,
          COUNT(CASE WHEN MARCADO = '' THEN 1 END) AS marcado_vazio,
          COUNT(CASE WHEN MARCADO = 'SIM' THEN 1 END) AS marcado_sim,
          COUNT(CASE WHEN MARCADO IS NOT NULL AND MARCADO NOT IN ('SIM','') THEN 1 END) AS marcado_outros,
          COUNT(CASE WHEN VALORTOTAL < 0 THEN 1 END) AS linhas_negativas,
          ROUND(SUM(VALORTOTAL), 2) AS sum_total,
          ROUND(SUM(CASE WHEN MARCADO IS NULL OR MARCADO <> 'SIM' THEN VALORTOTAL ELSE 0 END), 2) AS sum_excluindo_sim,
          ROUND(SUM(CASE WHEN MARCADO IS NULL THEN VALORTOTAL ELSE 0 END), 2) AS sum_so_null,
          ROUND(SUM(CASE WHEN MARCADO = '' THEN VALORTOTAL ELSE 0 END), 2) AS sum_so_vazio
        FROM caixa
        WHERE DATAFEC >= ? AND DATAFEC < ?
          ${filtroLojas}
        GROUP BY LOJA
        ORDER BY sum_excluindo_sim DESC
        `,
        params,
      );
      return rows as any[];
    } catch (e: any) {
      this.logger.error(`diagnosticoFaturamento falhou: ${e?.message || e}`);
      return [{ error: String(e?.message || e) }];
    }
  }

  /**
   * Time series do faturamento agregado (todas as lojas somadas) ou
   * separado por loja. Granularidade: day | week | month.
   *
   * Retorno:
   *   [{ bucket: '2026-05-01', storeCode: 'SITE', faturamento: 4200 }, ...]
   * Frontend agrupa por bucket pra montar grÃ¡fico de linhas.
   */
  async getFaturamentoTimeseries(
    inicio: Date,
    fim: Date,
    granularity: 'day' | 'week' | 'month' = 'day',
  ): Promise<Array<{ bucket: string; storeCode: string; faturamento: number }>> {
    if (this.mirrorReadsEnabled) {
      try {
        if ((await this.mirrorCaixaReady()) && (await this.mirrorCaixaCovers(inicio))) {
          return await this.getFaturamentoTimeseriesFromMirror(inicio, fim, granularity);
        }
      } catch (e) {
        this.logger.warn(`[mirror-reads] getFaturamentoTimeseries: ${(e as Error).message} → Giga ao vivo`);
      }
    }
    if (!this.pool) return [];
    // MySQL DATE_FORMAT pra agrupar
    const fmt =
      granularity === 'month' ? '%Y-%m-01' :
      granularity === 'week'  ? '%x-W%v' :   // ISO week (segunda-domingo)
                                '%Y-%m-%d';   // day
    try {
      // Usa DATAFEC pra bater com Wincred (mesmo motivo do getFaturamentoPorLoja)
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT
            DATE_FORMAT(c.DATAFEC, ?) AS bucket,
            c.LOJA AS storeCode,
            SUM(c.VALORTOTAL) AS faturamento
         FROM caixa c
         WHERE c.DATAFEC >= ?
           AND c.DATAFEC <  ?
           AND (c.MARCADO IS NULL OR c.MARCADO <> 'SIM')
         GROUP BY bucket, c.LOJA
         ORDER BY bucket ASC`,
        [fmt, inicio, fim],
      );
      return (rows as any[]).map((r) => ({
        bucket: String(r.bucket || ''),
        storeCode: String(r.storeCode || '').trim().toUpperCase(),
        faturamento: Number(r.faturamento) || 0,
      }));
    } catch (e: any) {
      this.logger.error(`getFaturamentoTimeseries falhou: ${e?.message || e}`);
      return [];
    }
  }
}
