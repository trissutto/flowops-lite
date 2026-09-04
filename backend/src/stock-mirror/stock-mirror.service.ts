import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

  constructor(private readonly prisma: PrismaService) {
    const env = process.env.STOCK_MANAGED_STORES;
    this.MANAGED_STORES = env
      ? env.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      : ['INDAIATUBA', 'ITANHAEM', 'MOEMA', 'SOROCABA', 'SANTOS'];
  }

  getManagedStores() {
    return [...this.MANAGED_STORES];
  }

  // O fullSyncFromGiga saiu em 09/26. Era o sync full Giga→tabela `stock` de
  // 2026-06, de quando o Giga ainda sabia o saldo. Já vivia bloqueado desde
  // 22/08 atrás de ERP_STOCK_WRITEBACK_GIGA=1 (copiar o número do Giga por
  // cima do Flow foi o que devolveu ao estoque de São José uma peça vendida —
  // BMM-100 VINHO 52), a tela /retaguarda/estoque tinha largado o botão, e o
  // MySQL do Giga morreu em 27/08. O que sobra aqui é tudo Postgres: leitura
  // da tabela `stock`, sumário, decremento e histórico de movimentação.

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

  /**
   * Histórico de movimentações (auditoria).
   *
   * `storeCode` é OPCIONAL desde 21/08: a ficha do produto pergunta "o que
   * aconteceu com esta peça na REDE", e exigir uma loja obrigava a tela a
   * varrer loja por loja. Com `sku` sozinho o índice
   * `[storeCode, sku, createdAt]` não serve, então existe um índice por `sku`
   * pra esse caminho — ver `@@index([sku, createdAt])` no schema.
   */
  async historicoMovimentacoes(input: {
    storeCode?: string;
    sku?: string;
    skus?: string[];
    limit?: number;
  }) {
    const where: any = {};
    if (input.storeCode) where.storeCode = input.storeCode.toUpperCase();

    /* a peça é uma REF com N códigos (cor × tamanho) — a ficha manda todos */
    const lista = (input.skus || []).map((s) => String(s).toUpperCase()).filter(Boolean);
    if (lista.length) where.sku = { in: lista };
    else if (input.sku) where.sku = input.sku.toUpperCase();

    if (!where.storeCode && !where.sku) {
      throw new BadRequestException('Informe storeCode ou sku');
    }

    return (this.prisma as any).stockMovement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(input.limit || 100, 500),
    });
  }
}
