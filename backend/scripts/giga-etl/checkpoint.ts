/**
 * PONTO DE RESTAURAÇÃO — congela o estado atual do `giga_raw` antes de mexer
 * em qualquer coisa.
 *
 * Pedido do dono (31/07/2026), antes da Fase 1: "crie um ponto de check onde
 * possamos voltar caso algo dê errado, tipo uma reversão."
 *
 * COMO FUNCIONA: copia o schema `giga_raw` inteiro pra um schema novo com
 * carimbo de data (`giga_ckpt_20260731_2345`), usando `CREATE TABLE ... AS
 * SELECT`. Fica tudo no mesmo Postgres, então restaurar é instantâneo — não
 * depende de arquivo, de rede, nem de o Giga estar de pé.
 *
 * POR QUE NÃO É `pg_dump`: dump é arquivo, e arquivo se perde, corrompe e
 * demora pra restaurar. Um schema irmão dentro do mesmo banco volta em
 * segundos e não pode ser "esquecido numa pasta".
 *
 * ⚠️ O QUE ELE **NÃO** PROTEGE: as tabelas da operação (`orders`, `customers`,
 * `pdv_sales`…) e os espelhos curados (`wincred_*`, `giga_*`). Esses são
 * responsabilidade do backup do próprio Railway — que tem PITR ligado (o
 * volume `Postgres-PITR`), e é ele que salva se alguém apagar dado de venda.
 * Este checkpoint cobre o `giga_raw`, que é o que a migração vai mexer.
 *
 * USO:
 *   railway run --service Postgres -- npx ts-node scripts/giga-etl/checkpoint.ts criar
 *   railway run --service Postgres -- npx ts-node scripts/giga-etl/checkpoint.ts listar
 *   railway run --service Postgres -- npx ts-node scripts/giga-etl/checkpoint.ts restaurar giga_ckpt_20260731_2345
 *   railway run --service Postgres -- npx ts-node scripts/giga-etl/checkpoint.ts apagar giga_ckpt_20260731_2345
 */

import { Client as PgClient } from 'pg';
import { mascarar, urlPostgres } from './conexoes';

const ORIGEM = 'giga_raw';
const PREFIXO = 'giga_ckpt_';

async function main() {
  const acao = (process.argv[2] || '').toLowerCase();
  const alvo = process.argv[3];

  if (!['criar', 'listar', 'restaurar', 'apagar'].includes(acao)) {
    console.log('Uso: checkpoint.ts criar | listar | restaurar <schema> | apagar <schema>');
    process.exit(1);
  }

  const url = urlPostgres();
  console.log(`Postgres: ${mascarar(url)}`);
  const pg = new PgClient({ connectionString: url });
  await pg.connect();

  if (acao === 'criar') await criar(pg);
  else if (acao === 'listar') await listar(pg);
  else if (acao === 'restaurar') await restaurar(pg, alvo);
  else await apagar(pg, alvo);

  await pg.end();
}

/** Nome do checkpoint: prefixo + data/hora, pra ordenar sozinho na listagem. */
function nomeNovo(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${PREFIXO}${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

async function criar(pg: PgClient) {
  const existe = await pg.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
    [ORIGEM],
  );
  if (!existe.rowCount) {
    console.log(`Schema ${ORIGEM} não existe — rode o etl.ts antes.`);
    process.exit(1);
  }

  const destino = nomeNovo();
  console.log(`Criando checkpoint ${destino} a partir de ${ORIGEM}...`);
  await pg.query(`CREATE SCHEMA "${destino}"`);

  const { rows: tabelas } = await pg.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
    [ORIGEM],
  );

  let total = 0;
  for (const { tablename } of tabelas) {
    // CTAS copia estrutura e dados de uma vez, sem passar pela rede.
    await pg.query(
      `CREATE TABLE "${destino}"."${tablename}" AS TABLE "${ORIGEM}"."${tablename}"`,
    );
    const r = await pg.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM "${destino}"."${tablename}"`,
    );
    const n = Number(r.rows[0].n);
    total += n;
    console.log(`  ${tablename.padEnd(28)} ${String(n).padStart(10)} linhas`);
  }

  // Carimbo de identidade do checkpoint — quem olhar daqui a um mês precisa
  // saber de quando é e o que tinha dentro, sem adivinhar pelo nome.
  await pg.query(`
    CREATE TABLE "${destino}"._checkpoint (
      criado_em timestamptz DEFAULT now(),
      origem    text,
      tabelas   integer,
      linhas    bigint
    )`);
  await pg.query(
    `INSERT INTO "${destino}"._checkpoint (origem, tabelas, linhas) VALUES ($1,$2,$3)`,
    [ORIGEM, tabelas.length, total],
  );

  console.log('');
  console.log(`Checkpoint criado: ${destino}`);
  console.log(`  ${tabelas.length} tabelas · ${total.toLocaleString('pt-BR')} linhas`);
  console.log('');
  console.log('Pra voltar a este ponto:');
  console.log(`  npx ts-node scripts/giga-etl/checkpoint.ts restaurar ${destino}`);
}

async function listar(pg: PgClient) {
  const { rows } = await pg.query<{ schema_name: string }>(
    `SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE $1 ORDER BY schema_name DESC`,
    [`${PREFIXO}%`],
  );

  if (!rows.length) {
    console.log('Nenhum checkpoint. Crie com: checkpoint.ts criar');
    return;
  }

  console.log('');
  console.log('CHECKPOINTS (mais recente primeiro):');
  for (const { schema_name } of rows) {
    try {
      const r = await pg.query<{ criado_em: Date; tabelas: number; linhas: string }>(
        `SELECT criado_em, tabelas, linhas FROM "${schema_name}"._checkpoint LIMIT 1`,
      );
      const c = r.rows[0];
      console.log(
        `  ${schema_name}  ${c.criado_em.toISOString().slice(0, 16).replace('T', ' ')}` +
          `  ${c.tabelas} tabelas  ${Number(c.linhas).toLocaleString('pt-BR')} linhas`,
      );
    } catch {
      console.log(`  ${schema_name}  (sem carimbo — checkpoint incompleto?)`);
    }
  }
}

async function restaurar(pg: PgClient, alvo?: string) {
  if (!alvo?.startsWith(PREFIXO)) {
    console.log(`Informe o schema do checkpoint (começa com ${PREFIXO}).`);
    console.log('Veja os disponíveis com: checkpoint.ts listar');
    process.exit(1);
  }

  const existe = await pg.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
    [alvo],
  );
  if (!existe.rowCount) {
    console.log(`Checkpoint ${alvo} não existe.`);
    process.exit(1);
  }

  // Antes de sobrescrever, guarda o estado ATUAL. Restaurar por engano não
  // pode ser irreversível — senão o mecanismo de segurança vira o acidente.
  const antes = `${PREFIXO}antes_restauro_${Date.now().toString(36)}`;
  console.log(`Guardando o estado atual em ${antes} (rede de segurança do próprio restauro)...`);
  await pg.query(`ALTER SCHEMA "${ORIGEM}" RENAME TO "${antes}"`);

  console.log(`Restaurando ${alvo} -> ${ORIGEM}...`);
  await pg.query(`CREATE SCHEMA "${ORIGEM}"`);

  const { rows: tabelas } = await pg.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_checkpoint' ORDER BY tablename`,
    [alvo],
  );
  for (const { tablename } of tabelas) {
    await pg.query(`CREATE TABLE "${ORIGEM}"."${tablename}" AS TABLE "${alvo}"."${tablename}"`);
  }

  console.log('');
  console.log(`Restaurado: ${tabelas.length} tabelas de ${alvo}.`);
  console.log(`O estado anterior ficou em ${antes} — apague quando tiver certeza:`);
  console.log(`  npx ts-node scripts/giga-etl/checkpoint.ts apagar ${antes}`);
}

async function apagar(pg: PgClient, alvo?: string) {
  if (!alvo?.startsWith(PREFIXO)) {
    console.log(`Só apago schema que comece com ${PREFIXO} — proteção contra apagar o banco por engano.`);
    process.exit(1);
  }
  await pg.query(`DROP SCHEMA IF EXISTS "${alvo}" CASCADE`);
  console.log(`Apagado: ${alvo}`);
}

main().catch((e) => {
  console.error('Checkpoint falhou:', e.message);
  process.exit(1);
});
