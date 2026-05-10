import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

function resolveAssetPath(...parts: string[]): string | null {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'assets', ...parts),
    path.resolve(__dirname, '..', '..', '..', 'assets', ...parts),
    path.resolve(process.cwd(), 'assets', ...parts),
    path.resolve(process.cwd(), 'dist', '..', 'assets', ...parts),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {/* ignora */}
  }
  return null;
}

const OVERRIDE_PATH = '/tmp/carne-coords-override.json';

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

  read(): CarneCoords {
    try {
      if (fs.existsSync(OVERRIDE_PATH)) {
        const raw = fs.readFileSync(OVERRIDE_PATH, 'utf-8');
        return JSON.parse(raw) as CarneCoords;
      }
    } catch (e: any) {
      this.logger.warn(`[carne-coords] override invalido: ${e?.message}`);
    }
    const cfgPath = resolveAssetPath('config', 'carne-coords.json');
    if (!cfgPath || !fs.existsSync(cfgPath)) {
      throw new BadRequestException('carne-coords.json nao encontrado');
    }
    try {
      const raw = fs.readFileSync(cfgPath, 'utf-8');
      return JSON.parse(raw) as CarneCoords;
    } catch (e: any) {
      throw new BadRequestException(`Falha ao ler carne-coords.json: ${e?.message}`);
    }
  }

  write(input: Partial<CarneCoords>): CarneCoords {
    let current: CarneCoords | null = null;
    try { current = this.read(); } catch { current = null; }
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

    try {
      fs.writeFileSync(OVERRIDE_PATH, JSON.stringify(merged, null, 2), 'utf-8');
      this.logger.log(`[carne-coords] override salvo em ${OVERRIDE_PATH}`);
    } catch (e: any) {
      throw new BadRequestException(`Falha ao salvar: ${e?.message}`);
    }
    return merged;
  }

  reset(): CarneCoords {
    try {
      if (fs.existsSync(OVERRIDE_PATH)) fs.unlinkSync(OVERRIDE_PATH);
    } catch {/* ignora */}
    return this.read();
  }
}
