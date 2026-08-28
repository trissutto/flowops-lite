/** giga_caixa_mov está andando (ponte do Flow) ou congelou? + giga_caixa_diario */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const mov = await db.query(
    `SELECT data::date dia, COUNT(*)::int linhas,
            COUNT(*) FILTER (WHERE registro LIKE 'f%' OR registro LIKE 'r%')::int sinteticas_flow
       FROM giga_caixa_mov
      WHERE data >= '2026-08-24'
      GROUP BY 1 ORDER BY 1`,
  );
  console.log('── giga_caixa_mov por dia (24/08+) ──');
  console.table(mov.rows);

  const diario = await db.query(
    `SELECT dia::date, COUNT(*)::int lojas, SUM(valor)::numeric(12,2) total
       FROM giga_caixa_diario WHERE dia >= '2026-08-26' GROUP BY 1 ORDER BY 1`,
  ).catch((e) => ({ rows: [{ erro: e.message.slice(0, 80) }] }));
  console.log('── giga_caixa_diario (26/08+) ──');
  console.table(diario.rows);

  await db.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
