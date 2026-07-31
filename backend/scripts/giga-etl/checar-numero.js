/**
 * Conferência pontual da coluna `caixa.NUMERO`.
 *
 * A conferência geral acusou divergência SÓ na soma dessa coluna, com o
 * destino saindo em notação científica (3.170128e+11). Isso cheira a
 * precisão de FLOAT, não a dado perdido — e é a armadilha já conhecida do
 * projeto: `caixa.NUMERO` é FLOAT de 4 bytes no Giga, que guarda ~7 dígitos
 * significativos enquanto a numeração já passou de 300 bilhões.
 *
 * Este script compara o que realmente importa: quantidade de linhas, de
 * valores distintos, mínimo, máximo — e a soma feita com CAST dos dois lados,
 * pra tirar a precisão do agregado da jogada.
 *
 * Se linhas/distintos/min/max baterem, o dado está íntegro e a divergência
 * era só do jeito de somar.
 *
 * Uso: railway run --service Postgres -- node scripts/giga-etl/checar-numero.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const dotenv = require('dotenv');

const raiz = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(raiz, '.env'), override: false });

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST,
    port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER,
    password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });

  const pgUrl = process.env.DATABASE_PUBLIC_URL || process.env.GIGA_ETL_PG_URL;
  if (!pgUrl) {
    console.log('Sem DATABASE_PUBLIC_URL — rode via "railway run --service Postgres".');
    process.exit(1);
  }
  const pg = new Client({ connectionString: pgUrl });
  await pg.connect();

  const [[m]] = await my.query(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT NUMERO) AS d,
            MIN(NUMERO) AS mn, MAX(NUMERO) AS mx,
            SUM(CAST(NUMERO AS DECIMAL(30,4))) AS s
       FROM caixa`,
  );

  const p = (
    await pg.query(
      `SELECT COUNT(*)::text AS n, COUNT(DISTINCT numero)::text AS d,
              MIN(numero)::text AS mn, MAX(numero)::text AS mx,
              SUM(numero::numeric)::text AS s
         FROM giga_raw.caixa`,
    )
  ).rows[0];

  const linha = (rot, a, b) => {
    const iguais = String(a) === String(b) || Math.abs(Number(a) - Number(b)) < 0.01;
    console.log(
      `${rot.padEnd(12)} ${String(a).padEnd(22)} ${String(b).padEnd(22)} ${iguais ? 'ok' : 'DIVERGENTE'}`,
    );
    return iguais;
  };

  console.log('');
  console.log(`${''.padEnd(12)} ${'MySQL (origem)'.padEnd(22)} ${'Postgres (destino)'.padEnd(22)} status`);
  const ok = [
    linha('linhas', m.n, p.n),
    linha('distintos', m.d, p.d),
    linha('minimo', m.mn, p.mn),
    linha('maximo', m.mx, p.mx),
    linha('soma(cast)', m.s, p.s),
  ];

  console.log('');
  if (ok.every(Boolean)) {
    console.log('VEREDITO: dado integro. A divergencia da conferencia geral era');
    console.log('precisao do SUM sobre float, nao perda de dado.');
  } else {
    console.log('VEREDITO: ha divergencia REAL na coluna. Recopie a tabela.');
  }

  await my.end();
  await pg.end();
  process.exit(ok.every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
