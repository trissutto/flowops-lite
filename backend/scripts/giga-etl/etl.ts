/**
 * ETL COMPLETO GIGA (MySQL) -> FLOW (Postgres)
 *
 * Decisão do dono (31/07/2026): "independente do Giga tocar, vamos trazer
 * todas as tabelas e dados pois em algum momento vamos precisar."
 *
 * Copia o banco INTEIRO — todas as tabelas, todo o histórico — pro schema
 * `giga_raw` do Postgres do Flow.
 *
 * POR QUE UM SCHEMA SEPARADO (`giga_raw`) E NÃO TABELAS SOLTAS:
 *   1. Não colide com os 20 espelhos que já existem (`wincred_*`, `giga_*`),
 *      que são CURADOS — têm regra de negócio, normalização de código sem zero
 *      à esquerda, filtro de MARCADO. Este aqui é cópia CRUA, sem opinião.
 *   2. `DROP SCHEMA giga_raw CASCADE` desfaz tudo numa linha se der errado.
 *   3. Deixa explícito pra quem ler depois: dado daqui é arquivo, não é fonte
 *      da verdade de nada — quem manda continua sendo o espelho curado.
 *
 * SEGURANÇA: só faz SELECT no MySQL. Nada é escrito no Giga.
 *
 * RETOMÁVEL: grava o progresso em `giga_raw._etl_controle`. Se cair na tabela
 * 40 de 60, roda de novo e continua da 40 — carga de horas não pode recomeçar
 * do zero por causa de uma queda de rede.
 *
 * USO:
 *   cd backend
 *   set GIGA_ETL_MYSQL_URL=mysql://user:senha@162.215.213.154:3306/banco
 *   set GIGA_ETL_PG_URL=postgresql://user:senha@host:5432/railway
 *   npx ts-node scripts/giga-etl/etl.ts                 # tudo
 *   npx ts-node scripts/giga-etl/etl.ts --tabela caixa  # uma só
 *   npx ts-node scripts/giga-etl/etl.ts --refazer       # ignora o progresso
 *   npx ts-node scripts/giga-etl/etl.ts --so-listar     # inventário, não copia
 */

import * as mysql from 'mysql2/promise';
import { Client as PgClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { ColunaMysql, limparValor, nomeSeguro, tipoPostgres } from './tipos';

const SCHEMA = 'giga_raw';
/** Linhas por lote no COPY. 5k equilibra memória e round-trip. */
const LOTE = 5_000;

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const valor = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const SO_LISTAR = flag('--so-listar');
const REFAZER = flag('--refazer');
const SO_TABELA = valor('--tabela');

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function main() {
  const mysqlUrl = process.env.GIGA_ETL_MYSQL_URL;
  const pgUrl = process.env.GIGA_ETL_PG_URL;
  if (!mysqlUrl || !pgUrl) {
    console.error('Faltam GIGA_ETL_MYSQL_URL e/ou GIGA_ETL_PG_URL no ambiente.');
    console.error('Ex.: mysql://user:senha@162.215.213.154:3306/banco');
    console.error('     postgresql://user:senha@host:5432/railway');
    process.exit(1);
  }

  const my = await mysql.createConnection({
    uri: mysqlUrl,
    // Sem isso o driver converte DATETIME pra Date do JS no fuso da máquina —
    // e a hora da venda muda dependendo de onde o script rodou.
    dateStrings: true,
    // Tabela grande não cabe na memória: o mysql2 só streama com isso.
    rowsAsArray: false,
  });

  const pg = new PgClient({ connectionString: pgUrl });
  await pg.connect();

  const dbNome = (mysqlUrl.split('/').pop() || '').split('?')[0];
  log(`MySQL: ${dbNome}`);

  /* ── 1. Inventário ─────────────────────────────────────────────────────── */

  const [tabelasRaw] = await my.query<any[]>(
    `SELECT TABLE_NAME AS nome, ENGINE AS engine, TABLE_ROWS AS linhas,
            ROUND((DATA_LENGTH+INDEX_LENGTH)/1024/1024,1) AS mb
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY (DATA_LENGTH+INDEX_LENGTH) DESC`,
    [dbNome],
  );

  const totalMb = tabelasRaw.reduce((s, t) => s + Number(t.mb || 0), 0);
  log(`${tabelasRaw.length} tabelas · ${(totalMb / 1024).toFixed(2)} GB`);
  console.log('');
  console.log('  TABELA                          ENGINE      LINHAS(est)      MB');
  for (const t of tabelasRaw) {
    console.log(
      `  ${String(t.nome).padEnd(30)} ${String(t.engine || '-').padEnd(10)} ` +
        `${String(t.linhas ?? '-').padStart(12)} ${String(t.mb ?? '-').padStart(8)}`,
    );
  }
  console.log('');

  if (SO_LISTAR) {
    const engines = [...new Set(tabelasRaw.map((t) => t.engine).filter(Boolean))];
    log(`Engines: ${engines.join(', ')}`);
    await my.end();
    await pg.end();
    return;
  }

  /* ── 2. Schema e controle ──────────────────────────────────────────────── */

  await pg.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}._etl_controle (
      tabela      text PRIMARY KEY,
      linhas      bigint,
      concluido_em timestamptz,
      duracao_s   integer,
      erro        text
    )`);

  if (REFAZER) {
    log('--refazer: limpando o controle de progresso');
    await pg.query(`TRUNCATE ${SCHEMA}._etl_controle`);
  }

  const { rows: feitas } = await pg.query<{ tabela: string }>(
    `SELECT tabela FROM ${SCHEMA}._etl_controle WHERE erro IS NULL`,
  );
  const jaFeitas = new Set(feitas.map((r) => r.tabela));

  const alvo = SO_TABELA
    ? tabelasRaw.filter((t) => String(t.nome).toLowerCase() === SO_TABELA.toLowerCase())
    : tabelasRaw;

  if (SO_TABELA && !alvo.length) {
    console.error(`Tabela "${SO_TABELA}" não existe em ${dbNome}.`);
    process.exit(1);
  }

  /* ── 3. Copiar ─────────────────────────────────────────────────────────── */

  let copiadas = 0;
  let puladas = 0;
  let falhas = 0;

  for (const t of alvo) {
    const nome = String(t.nome);
    const destino = nomeSeguro(nome);

    if (jaFeitas.has(destino) && !SO_TABELA) {
      puladas++;
      continue;
    }

    const inicio = Date.now();
    try {
      const linhas = await copiarTabela(my, pg, dbNome, nome, destino);
      const dur = Math.round((Date.now() - inicio) / 1000);
      await pg.query(
        `INSERT INTO ${SCHEMA}._etl_controle (tabela, linhas, concluido_em, duracao_s, erro)
         VALUES ($1,$2,now(),$3,NULL)
         ON CONFLICT (tabela) DO UPDATE SET
           linhas=$2, concluido_em=now(), duracao_s=$3, erro=NULL`,
        [destino, linhas, dur],
      );
      log(`OK  ${destino.padEnd(30)} ${String(linhas).padStart(10)} linhas em ${dur}s`);
      copiadas++;
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 500);
      await pg.query(
        `INSERT INTO ${SCHEMA}._etl_controle (tabela, linhas, concluido_em, duracao_s, erro)
         VALUES ($1,NULL,now(),NULL,$2)
         ON CONFLICT (tabela) DO UPDATE SET erro=$2, concluido_em=now()`,
        [destino, msg],
      );
      log(`ERRO ${destino}: ${msg}`);
      falhas++;
      // Não aborta: uma tabela problemática não pode impedir as outras 59.
      // O controle guarda o erro e o resumo final lista o que faltou.
    }
  }

  /* ── 4. Resumo ─────────────────────────────────────────────────────────── */

  console.log('');
  log(`Copiadas: ${copiadas} · Puladas (já feitas): ${puladas} · Falhas: ${falhas}`);

  const { rows: resumo } = await pg.query<{ tabela: string; linhas: string; erro: string | null }>(
    `SELECT tabela, linhas, erro FROM ${SCHEMA}._etl_controle ORDER BY tabela`,
  );
  const comErro = resumo.filter((r) => r.erro);
  if (comErro.length) {
    console.log('');
    console.log('TABELAS COM ERRO (rode de novo pra tentar só elas):');
    for (const r of comErro) console.log(`  ${r.tabela}: ${r.erro}`);
  }

  const totalLinhas = resumo.reduce((s, r) => s + Number(r.linhas || 0), 0);
  log(`Total no ${SCHEMA}: ${totalLinhas.toLocaleString('pt-BR')} linhas`);

  await my.end();
  await pg.end();

  if (falhas) process.exit(1);
}

/**
 * Copia uma tabela. Cria o destino do zero (DROP + CREATE) pra o retry ser
 * sempre limpo — carga parcial de tabela é pior que carga nenhuma, porque
 * parece completa.
 */
async function copiarTabela(
  my: mysql.Connection,
  pg: PgClient,
  dbNome: string,
  origem: string,
  destino: string,
): Promise<number> {
  const [colsRaw] = await my.query<any[]>(
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType,
            IS_NULLABLE AS isNullable, NUMERIC_PRECISION AS numericPrecision,
            NUMERIC_SCALE AS numericScale
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [dbNome, origem],
  );

  const cols: ColunaMysql[] = colsRaw.map((c) => ({
    name: String(c.name),
    dataType: String(c.dataType),
    columnType: String(c.columnType),
    isNullable: String(c.isNullable).toUpperCase() === 'YES',
    numericPrecision: c.numericPrecision === null ? null : Number(c.numericPrecision),
    numericScale: c.numericScale === null ? null : Number(c.numericScale),
  }));

  if (!cols.length) throw new Error('tabela sem colunas legíveis');

  const tiposPg = cols.map(tipoPostgres);
  const defs = cols
    .map((c, i) => `"${nomeSeguro(c.name)}" ${tiposPg[i]}`)
    .join(', ');

  // Sem NOT NULL nem chave: é arquivo. Restrição aqui só cria motivo pra a
  // carga falhar em dado que o MySQL já aceitou por 20 anos.
  await pg.query(`DROP TABLE IF EXISTS ${SCHEMA}."${destino}"`);
  await pg.query(`CREATE TABLE ${SCHEMA}."${destino}" (${defs})`);

  const listaCols = cols.map((c) => `"${nomeSeguro(c.name)}"`).join(', ');
  const copyStream = pg.query(
    copyFrom(`COPY ${SCHEMA}."${destino}" (${listaCols}) FROM STDIN WITH (FORMAT text)`),
  );

  // Stream do MySQL: `.stream()` não carrega a tabela inteira na memória.
  // A `caixa` do Giga tem milhões de linhas — sem isso o Node estoura.
  //
  // O wrapper `mysql2/promise` não expõe `.stream()`; quem tem é a conexão
  // core por baixo (`.connection`). O cast é necessário porque o tipo público
  // do pacote esconde esse campo.
  const core = (my as any).connection;
  const queryStream = core.query(`SELECT * FROM \`${origem}\``).stream();

  let n = 0;
  const origemNode = new Readable({
    objectMode: false,
    read() {},
  });

  queryStream.on('data', (row: any) => {
    const linha = cols
      .map((c, i) => paraCopy(limparValor(row[c.name], tiposPg[i])))
      .join('\t');
    origemNode.push(linha + '\n');
    n++;
    if (n % 100_000 === 0) log(`  ${destino}: ${n.toLocaleString('pt-BR')} linhas...`);
  });
  queryStream.on('end', () => origemNode.push(null));
  queryStream.on('error', (e: Error) => origemNode.destroy(e));

  await pipeline(origemNode, copyStream);
  return n;
}

/**
 * Serializa pro formato TEXT do COPY do Postgres.
 * As sequências de escape são obrigatórias: TAB e newline dentro de uma
 * descrição de produto quebrariam a linha do COPY e desalinhariam a tabela
 * inteira a partir dali.
 */
function paraCopy(v: unknown): string {
  if (v === null || v === undefined) return '\\N';
  if (Buffer.isBuffer(v)) return '\\\\x' + v.toString('hex');
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace('Z', '');

  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

main().catch((e) => {
  console.error('ETL falhou:', e);
  process.exit(1);
});
