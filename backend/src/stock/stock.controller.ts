import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { StockService } from './stock.service';
import { ErpService } from '../erp/erp.service';
import { PrismaService } from '../prisma/prisma.service';
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
  ) {}

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
}
