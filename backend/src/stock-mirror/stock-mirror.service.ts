import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * StockMirrorService — espelho PERSISTENTE do estoque Wincred no PostgreSQL.
 *
 * Diferente do StockService antigo (que é cache de 30s em memória do Giga),
 * este aqui mantém uma cópia PERSISTENTE no Postgres pras lojas migradas.
 * Suporte à independência total do Giga até 30/06.
 *
 * Estratégia de sync:
 *   - Sync inicial: botão na tela /retaguarda/estoque
 *   - Sync periódico: cron 4x/dia (TODO Fase 5)
 *   - Decremento ao vivo: quando PDV finalize (TODO ativar na Fase 5)
 *
 * Lojas gerenciadas: 5 migradas. Configurável via env STOCK_MANAGED_STORES.
 */
@Injectable()
export class StockMirrorService {
  private readonly logger = new Logger(StockMirrorService.name);
  private readonly MANAGED_STORES: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {
    const env = process.env.STOCK_MANAGED_STORES;
    this.MANAGED_STORES = env
      ? env.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      : ['INDAIATUBA', 'ITANHAEM', 'MOEMA', 'SOROCABA', 'SANTOS'];
  }

  getManagedStores() {
    return [...this.MANAGED_STORES];
  }

  /**
   * Sync full do estoque Giga → Postgres pra uma loja (ou todas as gerenciadas).
   * Pode demorar alguns segundos por loja. Cria StockMovement com reason='sync_giga'
   * pra cada SKU que mudou.
   */
  async fullSyncFromGiga(input?: { storeCodes?: string[] }) {
    const lojas = (input?.storeCodes || this.MANAGED_STORES)
      .map((s) => String(s).trim().toUpperCase())
      .filter(Boolean);

    const resultados: Array<{
      storeCode: string;
      totalSkus: number;
      inserted: number;
      updated: number;
      sameQty: number;
      durationMs: number;
      error?: string;
    }> = [];

    for (const storeCode of lojas) {
      const t0 = Date.now();
      try {
        // Aceita "06" E "6" — Wincred flexível
        const codesToTry = Array.from(
          new Set([storeCode, storeCode.padStart(2, '0').slice(-2)]),
        );
        const gigaRows = await this.erp.getEstoqueFullByLoja(codesToTry);

        // Agrega SKU → qty (caso múltiplas linhas pro mesmo CODIGO)
        const skuQty = new Map<string, number>();
        for (const r of gigaRows) {
          const sku = r.sku;
          const qty = Number(r.qty || 0);
          if (!sku || qty <= 0) continue;
          skuQty.set(sku, (skuQty.get(sku) || 0) + qty);
        }

        // Lê estado atual da loja em uma query só
        const existing = await (this.prisma as any).stock.findMany({
          where: { storeCode },
          select: { sku: true, qty: true },
        });
        const existingMap = new Map<string, number>();
        for (const e of existing) existingMap.set(e.sku, e.qty);

        let inserted = 0;
        let updated = 0;
        let sameQty = 0;
        const movements: any[] = [];
        const now = new Date();
        const unchangedSkus: string[] = [];

        for (const [sku, newQty] of skuQty.entries()) {
          const oldQty = existingMap.get(sku) ?? 0;
          if (oldQty === newQty) {
            sameQty++;
            // SKU não mudou: só precisa bumpar syncedAt. Acumula pra um
            // único updateMany no fim (em vez de 1 UPDATE por SKU).
            unchangedSkus.push(sku);
            continue;
          }

          await (this.prisma as any).stock.upsert({
            where: { storeCode_sku: { storeCode, sku } },
            update: { qty: newQty, syncedAt: now },
            create: { storeCode, sku, qty: newQty, syncedAt: now },
          });

          if (existingMap.has(sku)) updated++;
          else inserted++;

          movements.push({
            storeCode,
            sku,
            delta: newQty - oldQty,
            qtyBefore: oldQty,
            qtyAfter: newQty,
            reason: 'sync_giga',
            note: 'Sync full do Giga',
          });
        }

        // Bump de syncedAt dos SKUs inalterados em lote (chunks pra não estourar o IN).
        for (let i = 0; i < unchangedSkus.length; i += 1000) {
          const chunk = unchangedSkus.slice(i, i + 1000);
          await (this.prisma as any).stock.updateMany({
            where: { storeCode, sku: { in: chunk } },
            data: { syncedAt: now },
          });
        }

        if (movements.length > 0) {
          await (this.prisma as any).stockMovement.createMany({
            data: movements,
          });
        }

        resultados.push({
          storeCode,
          totalSkus: skuQty.size,
          inserted,
          updated,
          sameQty,
          durationMs: Date.now() - t0,
        });
        this.logger.log(
          `[stock-mirror sync] ${storeCode}: ${skuQty.size} SKUs ` +
          `(${inserted} new, ${updated} upd, ${sameQty} same) em ${Date.now() - t0}ms`,
        );
      } catch (e: any) {
        this.logger.error(`[stock-mirror sync] ${storeCode} falhou: ${e?.message || e}`);
        resultados.push({
          storeCode,
          totalSkus: 0, inserted: 0, updated: 0, sameQty: 0,
          durationMs: Date.now() - t0,
          error: e?.message || String(e),
        });
      }
    }

    return { lojas: resultados, when: new Date().toISOString() };
  }

  /** Lê estoque com filtro opcional por SKU (substring). */
  async listStock(input: {
    storeCode: string;
    sku?: string;
    onlyAvailable?: boolean;
    limit?: number;
  }) {
    const storeCode = input.storeCode.toUpperCase();
    const where: any = { storeCode };
    if (input.sku && input.sku.trim()) {
      where.sku = { contains: input.sku.toUpperCase() };
    }
    if (input.onlyAvailable) where.qty = { gt: 0 };

    return (this.prisma as any).stock.findMany({
      where,
      orderBy: { sku: 'asc' },
      take: Math.min(input.limit || 500, 2000),
    });
  }

  /** Sumário por loja pra dashboard. */
  async summary() {
    const out: Array<{
      storeCode: string;
      managed: boolean;
      totalSkus: number;
      totalQty: number;
      lastSync: Date | null;
    }> = [];

    for (const storeCode of this.MANAGED_STORES) {
      const agg = await (this.prisma as any).stock.aggregate({
        where: { storeCode },
        _count: { _all: true },
        _sum: { qty: true },
        _max: { syncedAt: true },
      });
      out.push({
        storeCode,
        managed: true,
        totalSkus: agg._count?._all || 0,
        totalQty: Number(agg._sum?.qty || 0),
        lastSync: agg._max?.syncedAt || null,
      });
    }
    return out;
  }

  /**
   * Decrementa estoque pra um conjunto de items.
   * NÃO é chamado automaticamente pelo PDV ainda — preparado pra Fase 5.
   */
  async decrement(input: {
    storeCode: string;
    items: Array<{ sku: string; qty: number }>;
    saleId?: string;
    userId?: string;
  }) {
    const storeCode = input.storeCode.toUpperCase();
    if (!this.MANAGED_STORES.includes(storeCode)) {
      return { ok: true, skipped: true, reason: 'loja_nao_gerenciada' };
    }

    const movements: any[] = [];
    const warnings: string[] = [];

    // Lê todos os SKUs do lote em uma query só (evita N findUnique).
    const wantedSkus = Array.from(
      new Set(input.items.map((it) => String(it.sku).trim()).filter(Boolean)),
    );
    const stockRows = await (this.prisma as any).stock.findMany({
      where: { storeCode, sku: { in: wantedSkus } },
    });
    const stockMap = new Map<string, any>(stockRows.map((s: any) => [s.sku, s]));

    for (const it of input.items) {
      const sku = String(it.sku).trim();
      const qty = Math.abs(Number(it.qty) || 1);
      if (!sku || qty === 0) continue;

      const stock = stockMap.get(sku);

      if (!stock) {
        warnings.push(`SKU ${sku} não existe em ${storeCode}`);
        continue;
      }

      const newQty = Math.max(0, stock.qty - qty);
      await (this.prisma as any).stock.update({
        where: { id: stock.id },
        data: { qty: newQty },
      });

      movements.push({
        storeCode, sku,
        delta: -qty,
        qtyBefore: stock.qty,
        qtyAfter: newQty,
        reason: 'sale',
        refId: input.saleId || null,
        userId: input.userId || null,
      });

      if (stock.qty < qty) {
        warnings.push(`SKU ${sku} estava com ${stock.qty}, vendeu ${qty} (zerado)`);
      }
    }

    if (movements.length > 0) {
      await (this.prisma as any).stockMovement.createMany({ data: movements });
    }

    return { ok: true, decremented: movements.length, warnings };
  }

  /** Histórico de movimentações (auditoria). */
  async historicoMovimentacoes(input: {
    storeCode: string;
    sku?: string;
    limit?: number;
  }) {
    const where: any = { storeCode: input.storeCode.toUpperCase() };
    if (input.sku) where.sku = input.sku.toUpperCase();
    return (this.prisma as any).stockMovement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(input.limit || 100, 500),
    });
  }
}
