import { ForbiddenException } from '@nestjs/common';

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

/**
 * Retorna o nivel da senha digitada, ou null se nao bater com nenhuma.
 * Procura do nivel mais ALTO pro mais BAIXO — primeira correspondencia ganha.
 */
export function detectPasswordLevel(password?: string): AccessLevel | null {
  if (!password || password.length < 3) return null;
  for (const level of LEVELS_DESC) {
    if (level === 'VENDEDOR') continue;
    const envKey = ENV_BY_LEVEL[level as Exclude<AccessLevel, 'VENDEDOR'>];
    const stored = (process.env[envKey] || '').trim();
    if (stored && stored.length >= 3 && stored === password) {
      return level;
    }
  }
  return null;
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
