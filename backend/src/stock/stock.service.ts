import { Injectable, Logger } from '@nestjs/common';
import { ErpService } from '../erp/erp.service';
import { MemoryCacheService } from '../common/memory-cache.service';
import { StockEntry } from '../routing/types';

/**
 * Wrapper sobre o ERP com cache em memória (30s).
 * Na versão Lite, o cache é in-process (sem Redis).
 */
@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name);
  private readonly TTL_SECONDS = 30;

  constructor(
    private readonly erp: ErpService,
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
    const fresh = await this.erp.getStock(uniqueSkus, uniqueStores);

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
}
