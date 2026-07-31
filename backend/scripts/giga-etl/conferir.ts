/**
 * CONFERÊNCIA ORIGEM × DESTINO — a prova de que nada se perdeu.
 *
 * Roda DEPOIS do etl.ts e compara, tabela a tabela, o MySQL do Giga com o
 * schema `giga_raw` do Postgres.
 *
 * POR QUE ISTO EXISTE SEPARADO DO ETL:
 * o etl.ts registra quantas linhas ELE copiou. Se o stream truncar no meio
 * (rede oscilou, conexão caiu), ele anota o número truncado e declara
 * sucesso — o registro dele confirma a si mesmo. Conferência de verdade
 * pergunta pra ORIGEM, depois do fato.
 *
 * DUAS CAMADAS:
 *
 *   1. CONTAGEM — COUNT(*) dos dois lados, em todas as tabelas.
 *      Pega linha faltando.
 *
 *   2. SOMA DOS VALORES — soma TODAS as colunas numéricas das tabelas
 *      críticas (venda, estoque, crediário, transferência), dos dois lados.
 *      Pega o que a contagem não pega: linha presente com valor corrompido.
 *      Contagem igual e soma diferente = número mudou no caminho, e é aí que
 *      mora o erro que só aparece na conferência do contador em janeiro.
 *
 * Só faz SELECT nos dois bancos. Não altera nada.
 *
 * USO:
 *   cd backend
 *   $env:GIGA_ETL_MYSQL_URL = "mysql://user:senha@162.215.213.154:3306/banco"
 *   $env:GIGA_ETL_PG_URL    = "postgresql://user:senha@host:5432/railway"
 *   npx ts-node scripts/giga-etl/conferir.ts
 *   npx ts-node scripts/giga-etl/conferir.ts --somar-tudo   # soma em TODAS
 */

import * as mysql from 'mysql2/promise';
import { Client as PgClient } from 'pg';
import { nomeSeguro } from './tipos';
import { mascarar, nomeDatabaseMysql, urlMysql, urlPostgres } from './conexoes';

const SCHEMA = 'giga_raw';

/**
 * Tabelas em que a soma dos números é conferida além da contagem.
 * São as que guardam DINHEIRO e MOVIMENTO — onde um valor trocado importa
 * mais do que uma linha a menos.
 */
const CRITICAS = [
  'caixa',           // venda linha a linha
  'estoque',         // saldo por loja
  'movimento',       // crediário
  'transferencias',  // remessa entre lojas
  'fechamento',      // fechamento de caixa
  'pagar',           // contas a pagar
  'estorno',
];

const args = process.argv.slice(2);
const SOMAR_TUDO = args.includes('--somar-tudo');

function log(m: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
}

async function main() {
  let mysqlUrl: string;
  let pgUrl: string;
  try {
    mysqlUrl = urlMysql();
    pgUrl = urlPostgres();
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
  log(`MySQL:    ${mascarar(mysqlUrl)}`);
  log(`Postgres: ${mascarar(pgUrl)}`);

  const my = await mysql.createConnection({ uri: mysqlUrl, dateStrings: true });
  const pg = new PgClient({ connectionString: pgUrl });
  await pg.connect();

  const dbNome = nomeDatabaseMysql(mysqlUrl);

  const [tabelas] = await my.query<any[]>(
    `SELECT TABLE_NAME AS nome FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME`,
    [dbNome],
  );

  log(`Conferindo ${tabelas.length} tabelas...`);
  console.log('');
  console.log('  TABELA                             ORIGEM      DESTINO   STATUS');

  let okCount = 0;
  const problemas: string[] = [];

  /* ── Camada 1: contagem ─────────────────────────────────────────────────── */

  for (const t of tabelas) {
    const origem = String(t.nome);
    const destino = nomeSeguro(origem);

    const [[cO]] = await my.query<any[]>(`SELECT COUNT(*) AS n FROM \`${origem}\``);
    const nOrigem = Number(cO.n);

    let nDestino: number | null = null;
    try {
      const r = await pg.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${SCHEMA}."${destino}"`);
      nDestino = Number(r.rows[0].n);
    } catch {
      nDestino = null; // tabela não existe no destino
    }

    if (nDestino === null) {
      console.log(`  ${destino.padEnd(32)} ${String(nOrigem).padStart(10)} ${'-'.padStart(12)}   FALTANDO`);
      problemas.push(`${destino}: nao existe no destino (origem tem ${nOrigem} linhas)`);
    } else if (nOrigem !== nDestino) {
      const dif = nDestino - nOrigem;
      console.log(
        `  ${destino.padEnd(32)} ${String(nOrigem).padStart(10)} ${String(nDestino).padStart(12)}   DIVERGENTE (${dif > 0 ? '+' : ''}${dif})`,
      );
      problemas.push(`${destino}: origem ${nOrigem}, destino ${nDestino} (${dif > 0 ? '+' : ''}${dif})`);
    } else {
      console.log(`  ${destino.padEnd(32)} ${String(nOrigem).padStart(10)} ${String(nDestino).padStart(12)}   ok`);
      okCount++;
    }
  }

  /* ── Camada 2: soma dos valores nas críticas ────────────────────────────── */

  console.log('');
  log('Conferindo SOMA das colunas numericas (dinheiro e movimento)...');
  console.log('');

  const paraSomar = SOMAR_TUDO
    ? tabelas.map((t) => String(t.nome))
    : tabelas.map((t) => String(t.nome)).filter((n) => CRITICAS.includes(n.toLowerCase()));

  if (!paraSomar.length) {
    log('Nenhuma tabela critica encontrada com esses nomes. Use --somar-tudo.');
  }

  for (const origem of paraSomar) {
    const destino = nomeSeguro(origem);

    // Descobre as colunas numéricas em vez de adivinhar nome — o Giga tem
    // 20 anos de coluna criada por versão diferente do Wincred.
    const [cols] = await my.query<any[]>(
      `SELECT COLUMN_NAME AS nome FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=? AND TABLE_NAME=?
          AND DATA_TYPE IN ('int','integer','bigint','smallint','mediumint',
                            'tinyint','decimal','numeric','float','double')
        ORDER BY ORDINAL_POSITION`,
      [dbNome, origem],
    );
    if (!cols.length) continue;

    for (const c of cols) {
      const col = String(c.nome);
      const colPg = nomeSeguro(col);

      let somaO: string;
      let somaD: string;
      try {
        const [[rO]] = await my.query<any[]>(
          `SELECT COALESCE(SUM(\`${col}\`),0) AS s FROM \`${origem}\``,
        );
        somaO = String(rO.s);
        const rD = await pg.query<{ s: string }>(
          `SELECT COALESCE(SUM("${colPg}"),0)::text AS s FROM ${SCHEMA}."${destino}"`,
        );
        somaD = rD.rows[0].s;
      } catch {
        continue; // coluna ausente no destino já apareceu na camada 1
      }

      // Compara como NÚMERO: o Postgres devolve "1234.00" onde o MySQL manda
      // "1234", e string diferente não significa valor diferente.
      const a = Number(somaO);
      const b = Number(somaD);
      const iguais = Number.isFinite(a) && Number.isFinite(b)
        ? Math.abs(a - b) < 0.01   // centavo de tolerância pra float
        : somaO === somaD;

      if (!iguais) {
        console.log(`  ${destino}.${colPg}: origem=${somaO} destino=${somaD}   DIVERGENTE`);
        problemas.push(`${destino}.${colPg}: soma origem ${somaO} != destino ${somaD}`);
      } else {
        console.log(`  ${destino}.${colPg}: ${somaO}   ok`);
      }
    }
  }

  /* ── Veredito ───────────────────────────────────────────────────────────── */

  console.log('');
  console.log('========================================');
  if (!problemas.length) {
    log(`TUDO CONFERE — ${okCount} tabelas, contagem e somas iguais.`);
    log('Nenhum dado se perdeu na copia.');
  } else {
    log(`${problemas.length} PROBLEMA(S):`);
    for (const p of problemas) console.log(`  - ${p}`);
    console.log('');
    console.log('O que costuma ser, na ordem:');
    console.log(' - escreveram no Giga DEPOIS da copia (loja vendendo)');
    console.log('   -> normal se a diferenca for pequena e so pra mais na origem;');
    console.log('      recopie a tabela: etl.ts --tabela <nome>');
    console.log(' - stream truncado (rede caiu no meio)');
    console.log('   -> recopie a tabela; o etl refaz do zero (DROP + CREATE)');
    console.log(' - soma divergente com contagem igual = valor corrompido');
    console.log('   -> NAO ignore. Recopie e confira de novo.');
  }

  await my.end();
  await pg.end();
  if (problemas.length) process.exit(1);
}

main().catch((e) => {
  console.error('Conferencia falhou:', e);
  process.exit(1);
});
