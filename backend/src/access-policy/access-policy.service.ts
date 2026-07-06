import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  AccessLevel,
  LevelSecret,
  makeSecret,
  setPasswordOverrides,
  levelsWithOverride,
  levelsWithEnv,
} from '../auth/auth-levels.util';

const APP_CONFIG_KEY = 'access-policy';

// Níveis que a tela gerencia (VENDEDOR não tem senha).
export const MANAGED_LEVELS: Exclude<AccessLevel, 'VENDEDOR'>[] = [
  'CAIXA',
  'GERENTE',
  'SUPERVISOR',
  'MASTER',
  'SUPREMA',
];

/**
 * Faixas de desconto do PDV (% sobre o BRUTO):
 *   0 .. freeUpToPct           → livre, sem senha
 *   >freeUpToPct .. caixaUpToPct → senha de CAIXA
 *   >caixaUpToPct              → senha de GERENTE + justificativa
 */
export interface DiscountThresholds {
  freeUpToPct: number;
  caixaUpToPct: number;
}

export const THRESHOLDS_PADRAO: DiscountThresholds = {
  freeUpToPct: 7,
  caixaUpToPct: 10,
};

// Forma persistida em AppConfig.valueJson. As senhas ficam só como HASH.
interface StoredPolicy {
  freeUpToPct: number;
  caixaUpToPct: number;
  secrets: Partial<Record<Exclude<AccessLevel, 'VENDEDOR'>, LevelSecret>>;
}

// Entrada do POST: senha em claro (write-only). '' = limpar (volta pro env);
// ausente = não mexe.
export interface AccessPolicyUpdate {
  freeUpToPct?: number;
  caixaUpToPct?: number;
  passwords?: Partial<Record<Exclude<AccessLevel, 'VENDEDOR'>, string>>;
}

/**
 * Config unificada de DESCONTO (faixas) + SENHAS por nível.
 *
 * Faixas: lidas pelo PdvService.requireDiscountAuth (substitui o 7/10 fixo).
 * Senhas: hasheadas no Postgres; no boot e a cada gravação são empurradas pro
 * auth-levels.util (setPasswordOverrides), que dá precedência ao banco sobre o
 * env — sem quebrar nenhum call-site de validateMinLevel (segue síncrono).
 */
@Injectable()
export class AccessPolicyService implements OnModuleInit {
  private readonly logger = new Logger(AccessPolicyService.name);
  private _cache: StoredPolicy | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Carrega do banco e injeta as senhas no util assim que o app sobe. */
  async onModuleInit(): Promise<void> {
    try {
      const p = await this.load();
      this.pushSecrets(p);
      this.logger.log(
        `[access-policy] carregado: faixas ${p.freeUpToPct}/${p.caixaUpToPct}, ` +
          `senhas no banco: [${MANAGED_LEVELS.filter((l) => p.secrets[l]).join(', ') || 'nenhuma'}]`,
      );
    } catch (e: any) {
      this.logger.warn(`[access-policy] boot falhou (usando env/padrão): ${e?.message}`);
    }
  }

  private async load(): Promise<StoredPolicy> {
    if (this._cache) return this._cache;
    let stored: Partial<StoredPolicy> = {};
    try {
      const row = await (this.prisma as any).appConfig.findUnique({
        where: { key: APP_CONFIG_KEY },
      });
      if (row?.valueJson) stored = JSON.parse(row.valueJson);
    } catch (e: any) {
      this.logger.warn(`[access-policy] ler banco falhou: ${e?.message}`);
    }
    const merged: StoredPolicy = {
      freeUpToPct: numOr(stored.freeUpToPct, THRESHOLDS_PADRAO.freeUpToPct),
      caixaUpToPct: numOr(stored.caixaUpToPct, THRESHOLDS_PADRAO.caixaUpToPct),
      secrets: stored.secrets && typeof stored.secrets === 'object' ? stored.secrets : {},
    };
    this._cache = merged;
    return merged;
  }

  private pushSecrets(p: StoredPolicy): void {
    setPasswordOverrides(p.secrets || {});
  }

  /** Faixas de desconto (cacheadas). Usado pelo PdvService. */
  async getThresholds(): Promise<DiscountThresholds> {
    const p = await this.load();
    return { freeUpToPct: p.freeUpToPct, caixaUpToPct: p.caixaUpToPct };
  }

  /** Status pra tela: faixas + quais níveis têm senha (banco/env). NUNCA a senha. */
  async getStatus() {
    const p = await this.load();
    // Garante que o util reflete o cache (defensivo se boot falhou).
    this.pushSecrets(p);
    return {
      freeUpToPct: p.freeUpToPct,
      caixaUpToPct: p.caixaUpToPct,
      levels: MANAGED_LEVELS.map((level) => ({
        level,
        inDb: !!levelsWithOverride()[level],
        inEnv: !!levelsWithEnv()[level],
      })),
    };
  }

  /** Grava faixas e/ou senhas. Retorna o status atualizado. */
  async update(input: AccessPolicyUpdate) {
    const atual = await this.load();
    const next: StoredPolicy = {
      freeUpToPct: input.freeUpToPct != null ? Number(input.freeUpToPct) : atual.freeUpToPct,
      caixaUpToPct: input.caixaUpToPct != null ? Number(input.caixaUpToPct) : atual.caixaUpToPct,
      secrets: { ...atual.secrets },
    };

    // Valida faixas: 0 ≤ livre ≤ caixa ≤ 100.
    if (!isFinite(next.freeUpToPct) || !isFinite(next.caixaUpToPct)) {
      throw new BadRequestException('Faixas inválidas');
    }
    if (next.freeUpToPct < 0 || next.caixaUpToPct > 100) {
      throw new BadRequestException('Faixas fora do intervalo 0–100%');
    }
    if (next.freeUpToPct > next.caixaUpToPct) {
      throw new BadRequestException(
        'A faixa livre não pode ser maior que a faixa do CAIXA (livre ≤ caixa)',
      );
    }

    // Senhas: string não-vazia = define (hash); '' = limpa (volta pro env).
    if (input.passwords) {
      for (const level of MANAGED_LEVELS) {
        if (!(level in input.passwords)) continue;
        const raw = input.passwords[level];
        if (raw == null) continue;
        const senha = String(raw);
        if (senha === '') {
          delete next.secrets[level];
        } else {
          if (senha.trim().length < 3) {
            throw new BadRequestException(`Senha de ${level} muito curta (mín. 3 caracteres)`);
          }
          next.secrets[level] = makeSecret(senha);
        }
      }
    }

    await (this.prisma as any).appConfig.upsert({
      where: { key: APP_CONFIG_KEY },
      create: { key: APP_CONFIG_KEY, valueJson: JSON.stringify(next) },
      update: { valueJson: JSON.stringify(next) },
    });
    this._cache = next;
    this.pushSecrets(next);
    this.logger.log(
      `[access-policy] atualizado: faixas ${next.freeUpToPct}/${next.caixaUpToPct}, ` +
        `senhas no banco: [${MANAGED_LEVELS.filter((l) => next.secrets[l]).join(', ') || 'nenhuma'}]`,
    );
    return this.getStatus();
  }
}

function numOr(v: any, fallback: number): number {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}
