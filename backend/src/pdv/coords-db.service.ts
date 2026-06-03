import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as fs from 'fs';

/**
 * Persistência das coordenadas da promissória no Postgres (tabela AppConfig).
 *
 * Funcionamento:
 *   1. Usuário ajusta na tela /retaguarda/promissoria-config → POST /pdv-diag/coords
 *   2. Endpoint chama saveCoords() → grava NO BANCO + escreve no /tmp
 *   3. CrediarioPrintService continua lendo do /tmp normalmente (sem alteração)
 *   4. No boot do app, restoreFromDb() lê do banco e popula o /tmp
 *      → garante que ajustes sobrevivem ao redeploy do Railway
 *
 * Por que esse design? Pra NÃO mexer no crediario-print.service.ts gigante
 * (1248 linhas — risco de Edits truncarem). Esse service é separado e curto.
 */
const OVERRIDE_PATH = '/tmp/promissoria-coords.json';
const APP_CONFIG_KEY = 'promissoria-coords';

@Injectable()
export class CoordsDbService implements OnModuleInit {
  private readonly logger = new Logger(CoordsDbService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** No boot, restaura o /tmp a partir do banco (se houver salvo). */
  async onModuleInit(): Promise<void> {
    await this.restoreFromDb().catch((e) =>
      this.logger.warn(`[coords-db] restoreFromDb falhou: ${e?.message}`),
    );
  }

  /**
   * Salva o JSON de coords no Postgres E no /tmp.
   * Persiste em redeploy (banco) e tem efeito imediato pra próxima impressão (/tmp).
   */
  async saveCoords(json: any): Promise<void> {
    const text = JSON.stringify(json, null, 2);
    // 1. Banco — fonte definitiva
    await (this.prisma as any).appConfig.upsert({
      where: { key: APP_CONFIG_KEY },
      create: { key: APP_CONFIG_KEY, valueJson: text },
      update: { valueJson: text },
    });
    // 2. /tmp — pra crediario-print.service.ts pegar imediatamente
    try {
      fs.writeFileSync(OVERRIDE_PATH, text, 'utf8');
    } catch (e: any) {
      this.logger.warn(`[coords-db] escrever /tmp falhou: ${e?.message}`);
    }
    this.logger.log(`[coords-db] coords salvas no banco + ${OVERRIDE_PATH}`);
  }

  /** Apaga banco E /tmp — volta pro asset deployado. */
  async resetCoords(): Promise<void> {
    try {
      await (this.prisma as any).appConfig.delete({ where: { key: APP_CONFIG_KEY } });
    } catch { /* não tinha — ok */ }
    try {
      if (fs.existsSync(OVERRIDE_PATH)) fs.unlinkSync(OVERRIDE_PATH);
    } catch { /* ok */ }
    this.logger.log(`[coords-db] reset — banco e /tmp limpos`);
  }

  /**
   * Lê do banco e ESCREVE no /tmp. Chamado no boot pra restaurar config
   * que sobrevivia a redeploy.
   */
  async restoreFromDb(): Promise<{ restaurado: boolean }> {
    const row = await (this.prisma as any).appConfig.findUnique({
      where: { key: APP_CONFIG_KEY },
    });
    if (!row?.valueJson) {
      this.logger.log(`[coords-db] nada no banco — usa asset deployado`);
      return { restaurado: false };
    }
    try {
      fs.writeFileSync(OVERRIDE_PATH, row.valueJson, 'utf8');
      this.logger.log(`[coords-db] /tmp restaurado do banco`);
      return { restaurado: true };
    } catch (e: any) {
      this.logger.warn(`[coords-db] escrever /tmp no restore falhou: ${e?.message}`);
      return { restaurado: false };
    }
  }
}
