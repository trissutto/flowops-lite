/**
 * Diagnóstico da coluna `caixa.NUMERO` — por que a contagem de DISTINTOS
 * diverge entre origem e destino.
 *
 * Não supõe nada: lê o tipo real no information_schema e procura exemplos
 * concretos de valores que a origem considera diferentes e o destino juntou.
 *
 * Uso: railway run --service Postgres -- node scripts/giga-etl/diag-numero.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST,
    port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER,
    password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });
  const pg = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await pg.connect();

  // 1. O tipo REAL da coluna, direto do catálogo do MySQL.
  const [tipo] = await my.query(
    `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, NUMERIC_PRECISION, NUMERIC_SCALE
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=? AND TABLE_NAME='caixa' AND COLUMN_NAME='NUMERO'`,
    [process.env.ERP_DATABASE],
  );
  console.log('TIPO NO MYSQL:', JSON.stringify(tipo[0]));

  const tipoPg = await pg.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema='giga_raw' AND table_name='caixa' AND column_name='numero'`,
  );
  console.log('TIPO NO POSTGRES:', tipoPg.rows[0]?.data_type);
  console.log('');

  // 2. Como o driver ENTREGA o valor — é aqui que a precisão se perde ou não.
  const [amostra] = await my.query(
    `SELECT NUMERO FROM caixa WHERE NUMERO > 10000000 ORDER BY NUMERO DESC LIMIT 5`,
  );
  console.log('AMOSTRA (5 maiores NUMERO), como o driver entrega:');
  for (const r of amostra) {
    console.log(`  valor=${r.NUMERO}  typeof=${typeof r.NUMERO}  String()=${String(r.NUMERO)}`);
  }
  console.log('');

  // 3. Onde estão as colisões: agrupa por valor e compara os dois lados.
  //    Se a origem tem N valores distintos numa faixa e o destino tem menos,
  //    a faixa aparece aqui.
  const [faixas] = await my.query(
    `SELECT FLOOR(NUMERO/1000000) AS faixa, COUNT(DISTINCT NUMERO) AS d
       FROM caixa GROUP BY faixa ORDER BY faixa`,
  );
  const fp = await pg.query(
    `SELECT FLOOR(numero/1000000) AS faixa, COUNT(DISTINCT numero)::int AS d
       FROM giga_raw.caixa GROUP BY faixa ORDER BY faixa`,
  );
  const mapaPg = new Map(fp.rows.map((r) => [String(r.faixa), Number(r.d)]));

  console.log('DISTINTOS POR FAIXA DE MILHAO (origem x destino):');
  let totalDif = 0;
  for (const f of faixas) {
    const chave = String(f.faixa);
    const o = Number(f.d);
    const d = mapaPg.get(chave) ?? 0;
    const dif = o - d;
    totalDif += dif;
    const marca = dif === 0 ? 'ok' : `PERDEU ${dif}`;
    console.log(`  faixa ${String(chave).padStart(4)}M: origem=${String(o).padStart(7)} destino=${String(d).padStart(7)}  ${marca}`);
  }
  console.log('');
  console.log(`TOTAL DE VALORES DISTINTOS PERDIDOS: ${totalDif}`);

  await my.end();
  await pg.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
