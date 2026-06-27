import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const APP_CONFIG_KEY = 'promo-config';

/**
 * Configuração das promoções automáticas do PDV.
 *
 * As promoções em si continuam codificadas no PdvService.applyAutoDiscounts
 * (YEAR_BASED 50% e FOUR_FOR_THREE). Aqui ficam só os AJUSTES que a matriz
 * controla sem mexer no código.
 */
export interface PromoConfig {
  /**
   * Promoção 50% (YEAR_BASED): quando true, NÃO aplica o desconto de 50%
   * nas peças classificadas como BÁSICO (product_classification.tipo_produto = 1).
   * A classificação Básico/Moda é feita na tela "Produtos Loja".
   */
  excluirBasicoNa50: boolean;
}

export const PROMO_CONFIG_PADRAO: PromoConfig = {
  excluirBasicoNa50: true,
};

@Injectable()
export class PromoConfigService {
  private readonly logger = new Logger(PromoConfigService.name);
  private _cache: PromoConfig | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Retorna config atual (do banco ou padrão). Cacheada em memória. */
  async getConfig(): Promise<PromoConfig> {
    if (this._cache) return this._cache;
    try {
      const row = await (this.prisma as any).appConfig.findUnique({
        where: { key: APP_CONFIG_KEY },
      });
      if (row?.valueJson) {
        const parsed = JSON.parse(row.valueJson);
        const merged = { ...PROMO_CONFIG_PADRAO, ...parsed };
        this._cache = merged;
        return merged;
      }
    } catch (e: any) {
      this.logger.warn(`[promo-config] ler banco falhou: ${e?.message}`);
    }
    this._cache = PROMO_CONFIG_PADRAO;
    return PROMO_CONFIG_PADRAO;
  }

  /** Salva nova config no banco e atualiza cache. */
  async setConfig(input: Partial<PromoConfig>): Promise<PromoConfig> {
    const atual = await this.getConfig();
    const novo: PromoConfig = { ...atual, ...input };
    // Normaliza pra boolean (defensivo contra "true"/1 do front)
    novo.excluirBasicoNa50 = !!novo.excluirBasicoNa50;

    await (this.prisma as any).appConfig.upsert({
      where: { key: APP_CONFIG_KEY },
      create: { key: APP_CONFIG_KEY, valueJson: JSON.stringify(novo) },
      update: { valueJson: JSON.stringify(novo) },
    });
    this._cache = novo;
    this.logger.log(`[promo-config] atualizado: ${JSON.stringify(novo)}`);
    return novo;
  }

  /** Invalida cache. */
  clearCache(): void {
    this._cache = null;
  }
}
