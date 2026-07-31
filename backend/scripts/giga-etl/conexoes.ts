/**
 * CONEXÕES — monta as duas URLs a partir do `.env` que o backend já tem.
 *
 * Por que existe: o `.env` do backend já guarda ERP_HOST/PORT/USER/PASSWORD/
 * DATABASE e a DATABASE_URL do Postgres. Obrigar a redigitar isso em variável
 * de ambiente na hora de rodar só cria chance de errar senha e de a senha
 * vazar pro histórico do shell.
 *
 * Precedência: variável de ambiente explícita vence o `.env` — dá pra apontar
 * pra outro banco (um Postgres de teste, por exemplo) sem editar arquivo.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

/** Carrega o .env do backend uma vez. */
function carregarEnv(): void {
  // scripts/giga-etl/ -> backend/
  const raiz = path.resolve(__dirname, '..', '..');
  for (const nome of ['.env.local', '.env']) {
    const p = path.join(raiz, nome);
    // `override: false` = o primeiro a definir ganha, e variável já exportada
    // no shell continua vencendo o arquivo.
    if (fs.existsSync(p)) dotenv.config({ path: p, override: false });
  }
}

function exigir(nome: string): string {
  const v = process.env[nome];
  if (!v || !v.trim()) {
    throw new Error(
      `Faltou ${nome}. Defina no backend/.env ou exporte no shell antes de rodar.`,
    );
  }
  return v.trim();
}

/** URL do MySQL do Giga. Usa GIGA_ETL_MYSQL_URL se existir; senão monta do .env. */
export function urlMysql(): string {
  const direta = process.env.GIGA_ETL_MYSQL_URL;
  if (direta?.trim()) return direta.trim();

  carregarEnv();
  const host = exigir('ERP_HOST');
  const port = process.env.ERP_PORT?.trim() || '3306';
  const user = exigir('ERP_USER');
  const senha = exigir('ERP_PASSWORD');
  const db = exigir('ERP_DATABASE');

  // encodeURIComponent na senha: senha de ERP costuma ter @ # / :, e sem
  // escapar a URL quebra no lugar errado e o erro fala de host inválido.
  return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(senha)}@${host}:${port}/${db}`;
}

/**
 * URL do Postgres do Flow, na ordem de preferência:
 *
 *   1. GIGA_ETL_PG_URL      — quem quer apontar pra outro banco de propósito
 *   2. DATABASE_PUBLIC_URL  — é o que o `railway run -s Postgres` injeta, e é
 *                             a que funciona DE FORA do Railway
 *   3. DATABASE_URL         — do .env local
 *
 * A DATABASE_URL do Railway aponta pra `*.railway.internal`, que só resolve
 * DENTRO da rede deles. Rodando daqui ela dá timeout sem explicar por quê —
 * por isso a pública vem antes.
 */
export function urlPostgres(): string {
  const direta = process.env.GIGA_ETL_PG_URL;
  if (direta?.trim()) return direta.trim();

  const publica = process.env.DATABASE_PUBLIC_URL;
  if (publica?.trim()) return publica.trim();

  carregarEnv();
  const url = exigir('DATABASE_URL');
  if (/\.railway\.internal/.test(url)) {
    throw new Error(
      'A DATABASE_URL aponta pra rede interna do Railway (*.railway.internal), ' +
        'que nao resolve daqui. Rode com "railway run -s Postgres -- ..." ou ' +
        'informe a URL publica em GIGA_ETL_PG_URL.',
    );
  }
  return url;
}

/** Nome do database MySQL, pra consultar o information_schema. */
export function nomeDatabaseMysql(url: string): string {
  const semQuery = url.split('?')[0];
  return semQuery.substring(semQuery.lastIndexOf('/') + 1);
}

/** Versão sem senha, pra log — nunca imprima a URL crua. */
export function mascarar(url: string): string {
  return url.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@');
}
