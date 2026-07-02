import { Injectable, Logger } from '@nestjs/common';
import { ErpService } from '../erp/erp.service';
import { WincredCatalogService } from '../wincred-mirror/wincred-catalog.service';
import { MemoryCacheService } from '../common/memory-cache.service';
import { StockEntry } from '../routing/types';

/**
 * Wrapper sobre o ERP com cache em memória (30s).
 * Na versão Lite, o cache é in-process (sem Redis).
 *
 * FALLBACK ESPELHO: se o Giga ao vivo falhar (firewall KingHost derrubou o
 * IP do Railway, timeout, etc), a consulta cai pro espelho Postgres
 * (wincred_estoque, full sync de hora em hora) em vez de estourar erro.
 * Estoque com até ~1h de atraso é melhor que consulta morta.
 */
@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name);
  private readonly TTL_SECONDS = 30;

  constructor(
    private readonly erp: ErpService,
    private readonly catalog: WincredCatalogService,
    private readonly cache: MemoryCacheService,
  ) {}

  async getStockFor(skus: string[], storeCodes: string[]): Promise<StockEntry[]> {
    const missKeys: Array<{ sku: string; storeCode: string; cacheKey: string }> = [];
    const hits: StockEntry[] = [];

    for (const sku of skus) {
      for (const storeCode of storeCodes) {
        const cacheKey = `stock:${storeCode}:${sku}`;
        const cached = this.cache.get(cacheKey);
        if (cached !== null) {
          hits.push({ sku, storeCode, availableQty: Number(cached) });
        } else {
          missKeys.push({ sku, storeCode, cacheKey });
        }
      }
    }

    if (missKeys.length === 0) return hits;

    const uniqueSkus = [...new Set(missKeys.map((k) => k.sku))];
    const uniqueStores = [...new Set(missKeys.map((k) => k.storeCode))];
    let fresh: StockEntry[];
    try {
      fresh = await this.erp.getStock(uniqueSkus, uniqueStores);
    } catch (e: any) {
      this.logger.warn(
        `[stock] Giga ao vivo falhou (${e?.message || e}) — usando espelho wincred_estoque como fallback`,
      );
      fresh = await this.catalog.getStockFromMirror(uniqueSkus, uniqueStores);
    }

    for (const e of fresh) {
      this.cache.set(`stock:${e.storeCode}:${e.sku}`, e.availableQty, this.TTL_SECONDS);
    }
    const freshSet = new Set(fresh.map((e) => `${e.storeCode}:${e.sku}`));
    for (const k of missKeys) {
      if (!freshSet.has(`${k.storeCode}:${k.sku}`)) {
        this.cache.set(k.cacheKey, 0, this.TTL_SECONDS);
      }
    }

    return [...hits, ...fresh];
  }

  async invalidate(storeCode: string, sku: string) {
    this.cache.del(`stock:${storeCode}:${sku}`);
  }

  /**
   * DIAGNÓSTICO: consulta ERP AO VIVO sem usar cache e sem gravar no cache.
   * Usado pra comparar "o que o sistema achou" vs "o que o ERP diz agora".
   * Útil em suspeita de rota incorreta ou duplicata de linha em `estoque`.
   */
  async getStockLive(skus: string[], storeCodes: string[]): Promise<StockEntry[]> {
    if (!skus.length || !storeCodes.length) return [];
    return this.erp.getStock(skus, storeCodes);
  }

  /**
   * Snapshot do cache em memória pra um conjunto de (sku, storeCode).
   * Retorna [] se o item não estiver no cache (indica que será fetchado no próximo hit).
   */
  snapshotCache(skus: string[], storeCodes: string[]) {
    const out: Array<{ sku: string; storeCode: string; cachedQty: number | null }> = [];
    for (const sku of skus) {
      for (const storeCode of storeCodes) {
        const v = this.cache.get(`stock:${storeCode}:${sku}`);
        out.push({ sku, storeCode, cachedQty: v === null ? null : Number(v) });
      }
    }
    return out;
  }
}
