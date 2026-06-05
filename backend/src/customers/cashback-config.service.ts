import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const APP_CONFIG_KEY = 'cashback-config';

export interface CashbackConfig {
  /** % do valor da compra que vira cashback (ex: 5 = 5%). */
  creditoPct: number;
  /** % máximo da compra que pode ser pago COM cashback (ex: 30 = até 30%). */
  usoMaxPct: number;
  /** Saldo mínimo pra poder usar (em reais). */
  minimoUsoReais: number;
  /** Dias até cashback creditado expirar. */
  validadeDias: number;
  /** Tier mínimo pra ganhar cashback (bronze/prata/ouro/diamante). 'bronze' = todos. */
  tierMinimo: 'bronze' | 'prata' | 'ouro' | 'diamante';
  /** Se ativo. Quando false, sistema não credita nem deixa resgatar. */
  ativo: boolean;
}

export const CASHBACK_CONFIG_PADRAO: CashbackConfig = {
  creditoPct: 5,         // 5% por padrão
  usoMaxPct: 30,         // até 30% da compra
  minimoUsoReais: 20,    // R$ 20 mínimo
  validadeDias: 90,      // 3 meses pra usar
  tierMinimo: 'bronze',  // todos os tiers
  ativo: true,
};

@Injectable()
export class CashbackConfigService {
  private readonly logger = new Logger(CashbackConfigService.name);
  private _cache: CashbackConfig | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Retorna config atual (do banco ou padrão). Cacheado em memória. */
  async getConfig(): Promise<CashbackConfig> {
    if (this._cache) return this._cache;
    try {
      const row = await (this.prisma as any).appConfig.findUnique({
        where: { key: APP_CONFIG_KEY },
      });
      if (row?.valueJson) {
        const parsed = JSON.parse(row.valueJson);
        const merged = { ...CASHBACK_CONFIG_PADRAO, ...parsed };
        this._cache = merged;
        return merged;
      }
    } catch (e: any) {
      this.logger.warn(`[cashback-config] ler banco falhou: ${e?.message}`);
    }
    this._cache = CASHBACK_CONFIG_PADRAO;
    return CASHBACK_CONFIG_PADRAO;
  }

  /** Salva nova config no banco e atualiza cache. */
  async setConfig(input: Partial<CashbackConfig>): Promise<CashbackConfig> {
    const atual = await this.getConfig();
    const novo: CashbackConfig = { ...atual, ...input };
    // Validação básica
    if (novo.creditoPct < 0 || novo.creditoPct > 100) {
      throw new Error('creditoPct deve estar entre 0 e 100');
    }
    if (novo.usoMaxPct < 0 || novo.usoMaxPct > 100) {
      throw new Error('usoMaxPct deve estar entre 0 e 100');
    }
    if (novo.minimoUsoReais < 0) {
      throw new Error('minimoUsoReais deve ser >= 0');
    }
    if (novo.validadeDias < 1) {
      throw new Error('validadeDias deve ser >= 1');
    }
    await (this.prisma as any).appConfig.upsert({
      where: { key: APP_CONFIG_KEY },
      create: { key: APP_CONFIG_KEY, valueJson: JSON.stringify(novo) },
      update: { valueJson: JSON.stringify(novo) },
    });
    this._cache = novo;
    this.logger.log(`[cashback-config] atualizado: ${JSON.stringify(novo)}`);
    return novo;
  }

  /** Invalida cache (após admin atualizar fora do setConfig). */
  clearCache(): void {
    this._cache = null;
  }
}
