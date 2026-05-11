import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';

function resolveAssetPath(...parts: string[]): string | null {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'assets', ...parts),
    path.resolve(__dirname, '..', '..', '..', 'assets', ...parts),
    path.resolve(process.cwd(), 'assets', ...parts),
    path.resolve(process.cwd(), 'dist', '..', 'assets', ...parts),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {/* ignora */}
  }
  return null;
}

const CFG_KEY = 'carne-coords';
const FALLBACK_TMP = '/tmp/carne-coords-override.json';

export type CarneCoords = {
  blocoY: number[];
  blocoH: number;
  fields: Record<string, { x: number; dy: number; w?: number }>;
  parcelaEsq: { xValor: number; xData: number; dy0: number; dyStep: number };
  parcelaDir: { xValor: number; xData: number; dy0: number; dyStep: number };
  totalAVencer: {
    col1: { x: number; yStart: number; dyStep: number };
    col2: { x: number; yStart: number; dyStep: number };
    col3: { x: number; yStart: number; dyStep: number };
  };
};

@Injectable()
export class CarneCoordsService {
  private readonly logger = new Logger(CarneCoordsService.name);
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lê coords. Prioridade:
   *  1. Postgres AppConfig.key='carne-coords' (sobrevive a redeploys)
   *  2. /tmp/carne-coords-override.json (fallback legado)
   *  3. assets/config/carne-coords.json (bundled)
   */
  async read(): Promise<CarneCoords> {
    // 1. Postgres
    try {
      const row = await (this.prisma as any).appConfig.findUnique({ where: { key: CFG_KEY } });
      if (row?.valueJson) {
        return JSON.parse(row.valueJson) as CarneCoords;
      }
    } catch (e: any) {
      this.logger.warn(`[carne-coords] DB read falhou: ${e?.message}. Caindo no /tmp.`);
    }

    // 2. /tmp
    try {
      if (fs.existsSync(FALLBACK_TMP)) {
        return JSON.parse(fs.readFileSync(FALLBACK_TMP, 'utf-8')) as CarneCoords;
      }
    } catch {/* segue */}

    // 3. Bundled
    const cfgPath = resolveAssetPath('config', 'carne-coords.json');
    if (!cfgPath || !fs.existsSync(cfgPath)) {
      throw new BadRequestException('carne-coords.json nao encontrado');
    }
    return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as CarneCoords;
  }

  /**
   * Salva no Postgres (persiste em redeploys) + /tmp (fallback rapido).
   */
  async write(input: Partial<CarneCoords>): Promise<CarneCoords> {
    let current: CarneCoords | null = null;
    try { current = await this.read(); } catch { current = null; }
    if (!current) throw new BadRequestException('Nao consigo ler coords atuais');

    const merged: CarneCoords = {
      blocoY: input.blocoY ?? current.blocoY,
      blocoH: input.blocoH ?? current.blocoH,
      fields: { ...current.fields, ...(input.fields || {}) },
      parcelaEsq: input.parcelaEsq ?? current.parcelaEsq,
      parcelaDir: input.parcelaDir ?? current.parcelaDir,
      totalAVencer: input.totalAVencer ?? current.totalAVencer,
    };

    if (!Array.isArray(merged.blocoY) || merged.blocoY.length !== 2) {
      throw new BadRequestException('blocoY precisa ser array com 2 valores');
    }
    if (typeof merged.blocoH !== 'number' || merged.blocoH <= 0) {
      throw new BadRequestException('blocoH precisa ser numero > 0');
    }

    const json = JSON.stringify(merged);

    // 1. Postgres (FONTE PRIMARIA - sobrevive a redeploys)
    try {
      await (this.prisma as any).appConfig.upsert({
        where: { key: CFG_KEY },
        update: { valueJson: json },
        create: { key: CFG_KEY, valueJson: json },
      });
      this.logger.log(`[carne-coords] salvo no Postgres (key=${CFG_KEY})`);
    } catch (e: any) {
      this.logger.error(`[carne-coords] FALHA salvar no Postgres: ${e?.message}`);
      throw new BadRequestException(`Falha ao salvar no banco: ${e?.message}`);
    }

    // 2. /tmp (cache pra hot-reload sem hit no DB)
    try {
      fs.writeFileSync(FALLBACK_TMP, json, 'utf-8');
    } catch {/* ignora */}

    return merged;
  }

  /** Reset → apaga do Postgres + /tmp. Volta pro JSON bundled. */
  async reset(): Promise<CarneCoords> {
    try {
      await (this.prisma as any).appConfig.delete({ where: { key: CFG_KEY } });
    } catch {/* nao existia, OK */}
    try {
      if (fs.existsSync(FALLBACK_TMP)) fs.unlinkSync(FALLBACK_TMP);
    } catch {/* ignora */}
    return this.read();
  }
}
