import { Injectable, Logger } from '@nestjs/common';
import { ErpService } from '../erp/erp.service';
import { MemoryCacheService } from '../common/memory-cache.service';

/**
 * SalesStatsService — fornece estatísticas de venda por loja (últimos 30d)
 * pro routing engine aplicar PROPORCIONALIDADE INVERSA no desempate:
 *   loja que VENDEU MAIS → cede MENOS pro e-commerce
 *   loja que VENDEU MENOS → cede MAIS pro e-commerce
 *
 * Por que aqui e não no ErpService:
 *   - ErpService é stateless (query direta). Aqui tem cache agressivo (1h)
 *     porque venda de 30d muda devagar — não faz sentido bater no ERP a cada pedido.
 *   - Calcula o `targetQuotaByStore` (o ALVO de cessão de cada loja), que é a
 *     derivada matemática do share de venda, não um dado bruto.
 *
 * Fórmula (vide regra do CEO 21/04/26):
 *   salesShare[i]    = units[i] / Σ units    (0..1)
 *   cedePotential[i] = 1 - salesShare[i]     (quanto essa loja PODE ceder relativamente)
 *   targetQuota[i]   = cedePotential[i] / Σ cedePotential   (normaliza pra somar 1)
 *
 * Isso garante Σ targetQuota = 1 e que loja com share alto (vende muito) tem
 * quota BAIXA (cede pouco), loja com share 0 tem quota máxima.
 *
 * Caso especial:
 *   - N=1 loja: targetQuota=1 (sem alternativa, ela cede tudo).
 *   - Σ units = 0: todas as lojas empatam (1/N cada).
 */
@Injectable()
export class SalesStatsService {
  private readonly logger = new Logger(SalesStatsService.name);
  private readonly CACHE_KEY = 'sales-stats:last-30d';
  private readonly TTL_SECONDS = 60 * 60; // 1h — venda de 30d muda devagar

  constructor(
    private readonly erp: ErpService,
    private readonly cache: MemoryCacheService,
  ) {}

  /**
   * Retorna vendas brutas por loja nos últimos N dias (default 30).
   * Cached em memória (1h) pra não socar o ERP a cada pedido.
   */
  async getSalesByStore(
    days: number = 30,
  ): Promise<Array<{ storeCode: string; units: number; orders: number }>> {
    const key = `${this.CACHE_KEY}:${days}`;
    const cached = this.cache.get(key);
    if (cached !== null) {
      try {
        return JSON.parse(cached) as Array<{ storeCode: string; units: number; orders: number }>;
      } catch {
        // cache corrompido — refaz
      }
    }
    const rows = await this.erp.getSalesByStoreLastDays(days);
    this.cache.set(key, JSON.stringify(rows), this.TTL_SECONDS);
    return rows;
  }

  /**
   * Calcula as METAS DE CESSÃO (targetQuota) pra um conjunto de lojas elegíveis.
   *
   * Recebe os códigos das lojas candidatas (as que PODEM cobrir o pedido no
   * cenário avaliado). Importante passar só quem é elegível pro cálculo, senão
   * a meta fica distorcida incluindo loja que nem entrou no jogo.
   *
   * @param eligibleStoreCodes códigos das lojas que vão concorrer pela cessão
   * @param days janela de análise (default 30d)
   *
   * Retorna:
   *   - targetQuotaByStore: share IDEAL de cessão de cada loja (soma=1)
   *   - salesShareByStore: share de VENDAS de cada loja (pra debug/UI)
   *   - totalUnits: total de unidades vendidas no período (soma dos candidatos)
   */
  async getCedeQuotas(
    eligibleStoreCodes: string[],
    days: number = 30,
  ): Promise<{
    targetQuotaByStore: Record<string, number>;
    salesShareByStore: Record<string, number>;
    totalUnits: number;
    windowDays: number;
  }> {
    const uniqueCodes = Array.from(new Set(eligibleStoreCodes.map((c) => String(c).trim()).filter(Boolean)));
    const targetQuotaByStore: Record<string, number> = {};
    const salesShareByStore: Record<string, number> = {};

    if (uniqueCodes.length === 0) {
      return { targetQuotaByStore, salesShareByStore, totalUnits: 0, windowDays: days };
    }

    // Caso degenerado — 1 loja só, ela cede tudo
    if (uniqueCodes.length === 1) {
      const c = uniqueCodes[0];
      targetQuotaByStore[c] = 1;
      salesShareByStore[c] = 1;
      return { targetQuotaByStore, salesShareByStore, totalUnits: 0, windowDays: days };
    }

    const rows = await this.getSalesByStore(days);
    const unitsByStore: Record<string, number> = {};
    for (const c of uniqueCodes) unitsByStore[c] = 0;
    for (const r of rows) {
      if (unitsByStore[r.storeCode] !== undefined) {
        unitsByStore[r.storeCode] = r.units;
      }
    }

    const totalUnits = Object.values(unitsByStore).reduce((s, n) => s + n, 0);

    // Edge case: nenhuma das lojas elegíveis vendeu nada no período.
    // Distribui IGUAL (1/N) — não há base pra proporcionalidade.
    if (totalUnits <= 0) {
      const equal = 1 / uniqueCodes.length;
      for (const c of uniqueCodes) {
        targetQuotaByStore[c] = equal;
        salesShareByStore[c] = 0;
      }
      return { targetQuotaByStore, salesShareByStore, totalUnits: 0, windowDays: days };
    }

    // PASSO 1: salesShare de cada loja dentro do conjunto elegível
    for (const c of uniqueCodes) {
      salesShareByStore[c] = unitsByStore[c] / totalUnits;
    }

    // PASSO 2: cedePotential = 1 - salesShare  (quanto ELA PODE ceder)
    // PASSO 3: normaliza pra somar 1 (targetQuota)
    const potentialByStore: Record<string, number> = {};
    let totalPotential = 0;
    for (const c of uniqueCodes) {
      const p = 1 - salesShareByStore[c];
      potentialByStore[c] = p;
      totalPotential += p;
    }

    // Raríssimo: totalPotential=0 quando 1 loja tem share=1 e outras share=0 mas
    // entraram como elegíveis. Blindagem: quota igual.
    if (totalPotential <= 0) {
      const equal = 1 / uniqueCodes.length;
      for (const c of uniqueCodes) targetQuotaByStore[c] = equal;
      return { targetQuotaByStore, salesShareByStore, totalUnits, windowDays: days };
    }

    for (const c of uniqueCodes) {
      targetQuotaByStore[c] = potentialByStore[c] / totalPotential;
    }

    return { targetQuotaByStore, salesShareByStore, totalUnits, windowDays: days };
  }

  /**
   * Invalida manualmente o cache — usado se o CEO quiser forçar refresh da base
   * (ex: após correção grande no WinCred).
   */
  invalidate(days: number = 30) {
    this.cache.del(`${this.CACHE_KEY}:${days}`);
  }
}
