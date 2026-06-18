import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const CFG_KEY = 'etiqueta-config';

/**
 * Defaults — espelha o que esta hardcoded no EtiquetaPrint.tsx hoje.
 * Quando o user nunca salvou nada, retornamos isso.
 */
export const DEFAULT_ETIQUETA_CONFIG = {
  pageWidthMm: 108,
  cellWidthMm: 48,
  cellHeightMm: 30,
  gridColumnGapMm: 6,
  paddingTopMm: 21,
  paddingLeftMm: 3,
  cellPadTopMm: 1.2,
  cellPadRightMm: 1.5,
  cellPadBottomMm: 0.8,
  cellPadLeftMm: 1.5,
  barcodeWidth: 1.8,
  barcodeHeightPx: 32,
  barcodeFontSize: 18,
  refMaxFontPx: 12,
  descMaxHeightMm: 5.2,
};

export type EtiquetaConfig = typeof DEFAULT_ETIQUETA_CONFIG;

/**
 * Persistencia da configuracao da etiqueta no Postgres (AppConfig.key='etiqueta-config').
 * Sobrevive a redeploys do Railway/Vercel.
 */
@Injectable()
export class EtiquetaConfigService {
  private readonly logger = new Logger(EtiquetaConfigService.name);
  constructor(private readonly prisma: PrismaService) {}

  async read(): Promise<EtiquetaConfig> {
    try {
      const row = await (this.prisma as any).appConfig.findUnique({ where: { key: CFG_KEY } });
      if (row?.valueJson) {
        const saved = JSON.parse(row.valueJson);
        return { ...DEFAULT_ETIQUETA_CONFIG, ...saved };
      }
    } catch (e: any) {
      this.logger.warn(`[etiqueta-config] DB read falhou: ${e?.message}`);
    }
    return { ...DEFAULT_ETIQUETA_CONFIG };
  }

  async write(input: Partial<EtiquetaConfig>): Promise<EtiquetaConfig> {
    const current = await this.read();
    const merged: EtiquetaConfig = { ...current, ...input };
    try {
      await (this.prisma as any).appConfig.upsert({
        where: { key: CFG_KEY },
        update: { valueJson: JSON.stringify(merged) },
        create: { key: CFG_KEY, valueJson: JSON.stringify(merged) },
      });
      this.logger.log(`[etiqueta-config] salvo no Postgres`);
    } catch (e: any) {
      this.logger.error(`[etiqueta-config] FALHA salvar: ${e?.message}`);
      throw e;
    }
    return merged;
  }

  async reset(): Promise<EtiquetaConfig> {
    try {
      await (this.prisma as any).appConfig.delete({ where: { key: CFG_KEY } });
    } catch { /* nao existia */ }
    return this.read();
  }
}
