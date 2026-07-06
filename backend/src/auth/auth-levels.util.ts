import { ForbiddenException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';

/**
 * Niveis de senha — hierarquia descendente.
 * Senha de nivel SUPERIOR sempre passa em validacao de nivel INFERIOR.
 *
 * Senhas configuradas via env:
 *   SUPREMA_PASSWORD     — CEO/dono (irrestrito)
 *   MASTER_PASSWORD      — admin financeiro (ajustes caixa, deletar venda)
 *   GERENTE_PASSWORD     — operacional senior (descontos, fechar caixa de outra loja)
 *   SUPERVISOR_PASSWORD  — visualizacao/conferencia (super-painel)
 *   CAIXA_PASSWORD       — operadora de caixa (override pequeno no PDV)
 *
 * VENDEDOR nao tem senha por nivel — eh o default sem privilegios extras.
 */
export type AccessLevel = 'SUPREMA' | 'MASTER' | 'GERENTE' | 'SUPERVISOR' | 'CAIXA' | 'VENDEDOR';

export const LEVELS_DESC: AccessLevel[] = [
  'SUPREMA',
  'MASTER',
  'GERENTE',
  'SUPERVISOR',
  'CAIXA',
  'VENDEDOR',
];

export const LEVEL_RANK: Record<AccessLevel, number> = {
  SUPREMA: 100,
  MASTER: 80,
  GERENTE: 60,
  SUPERVISOR: 40,
  CAIXA: 20,
  VENDEDOR: 0,
};

const ENV_BY_LEVEL: Record<Exclude<AccessLevel, 'VENDEDOR'>, string> = {
  SUPREMA: 'SUPREMA_PASSWORD',
  MASTER: 'MASTER_PASSWORD',
  GERENTE: 'GERENTE_PASSWORD',
  SUPERVISOR: 'SUPERVISOR_PASSWORD',
  CAIXA: 'CAIXA_PASSWORD',
};

// ── Senhas configuradas pela TELA (Postgres), com precedência sobre o env ──
// A tela /retaguarda/descontos-senhas grava aqui via setPasswordOverrides().
// Guardamos só o HASH (sha256 com salt), nunca a senha em claro — nem no banco,
// nem em memória. A validação continua SÍNCRONA (sha256 é sync), então todos os
// call-sites de validateMinLevel seguem funcionando sem virar async.
export interface LevelSecret {
  salt: string;
  hash: string;
}
type OverrideMap = Partial<Record<Exclude<AccessLevel, 'VENDEDOR'>, LevelSecret>>;
let secretOverrides: OverrideMap = {};

/** Hash determinístico (sync) de uma senha com salt. */
export function hashSecret(salt: string, password: string): string {
  return createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

/** Gera {salt, hash} pra uma senha nova (usado ao salvar na tela). */
export function makeSecret(password: string): LevelSecret {
  const salt = randomBytes(9).toString('hex');
  return { salt, hash: hashSecret(salt, password) };
}

/**
 * Substitui o conjunto de senhas vindas do banco. Chamado no boot e a cada
 * gravação da tela. Passar {} volta 100% pro fallback de env.
 */
export function setPasswordOverrides(map: OverrideMap | null | undefined): void {
  secretOverrides = map ? { ...map } : {};
}

/**
 * Retorna o nivel da senha digitada, ou null se nao bater com nenhuma.
 * Procura do nivel mais ALTO pro mais BAIXO — primeira correspondencia ganha.
 *
 * Precedência por nível: se há senha cadastrada no BANCO pra aquele nível,
 * ela manda (o env daquele nível é ignorado). Sem cadastro no banco, cai no env.
 */
export function detectPasswordLevel(password?: string): AccessLevel | null {
  if (!password || password.length < 3) return null;
  for (const level of LEVELS_DESC) {
    if (level === 'VENDEDOR') continue;
    const lvl = level as Exclude<AccessLevel, 'VENDEDOR'>;
    const override = secretOverrides[lvl];
    if (override) {
      // Banco tem precedência: bateu → esse nível; não bateu → NÃO cai no env.
      if (hashSecret(override.salt, password) === override.hash) return level;
      continue;
    }
    const stored = (process.env[ENV_BY_LEVEL[lvl]] || '').trim();
    if (stored && stored.length >= 3 && stored === password) {
      return level;
    }
  }
  return null;
}

/** Quais níveis têm senha cadastrada no banco (pra status na tela). */
export function levelsWithOverride(): Record<Exclude<AccessLevel, 'VENDEDOR'>, boolean> {
  const out = {} as Record<Exclude<AccessLevel, 'VENDEDOR'>, boolean>;
  for (const level of LEVELS_DESC) {
    if (level === 'VENDEDOR') continue;
    const lvl = level as Exclude<AccessLevel, 'VENDEDOR'>;
    out[lvl] = !!secretOverrides[lvl];
  }
  return out;
}

/** Quais níveis têm senha no env (pra status na tela). */
export function levelsWithEnv(): Record<Exclude<AccessLevel, 'VENDEDOR'>, boolean> {
  const out = {} as Record<Exclude<AccessLevel, 'VENDEDOR'>, boolean>;
  for (const level of LEVELS_DESC) {
    if (level === 'VENDEDOR') continue;
    const lvl = level as Exclude<AccessLevel, 'VENDEDOR'>;
    const stored = (process.env[ENV_BY_LEVEL[lvl]] || '').trim();
    out[lvl] = stored.length >= 3;
  }
  return out;
}

/**
 * Valida que a senha digitada eh de NIVEL >= minLevel.
 * Lanca ForbiddenException se senha invalida ou nivel insuficiente.
 * Retorna o nivel detectado (pra log/audit).
 */
export function validateMinLevel(password: string | undefined, minLevel: AccessLevel): AccessLevel {
  const level = detectPasswordLevel(password);
  if (!level) {
    throw new ForbiddenException('Senha invalida');
  }
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) {
    throw new ForbiddenException(
      `Nivel insuficiente — exigido ${minLevel} (ou superior), recebido ${level}`,
    );
  }
  return level;
}

/**
 * Retorna a lista de niveis configurados (que tem env preenchida).
 * Util pra diagnostico/healthcheck.
 */
export function listConfiguredLevels(): AccessLevel[] {
  const out: AccessLevel[] = [];
  for (const level of LEVELS_DESC) {
    if (level === 'VENDEDOR') continue;
    const envKey = ENV_BY_LEVEL[level as Exclude<AccessLevel, 'VENDEDOR'>];
    const stored = (process.env[envKey] || '').trim();
    if (stored && stored.length >= 3) out.push(level);
  }
  return out;
}
