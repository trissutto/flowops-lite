/** Leads do popup do cupom: quantos são e se alguém já foi tocado. */
const { Client } = require('pg');
(async () => {
  const db = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();
  const cols = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'site_lead' ORDER BY ordinal_position`,
  );
  console.log('colunas de site_lead:', cols.rows.map((r) => r.column_name).join(', '));
  const total = await db.query(`SELECT COUNT(*)::int AS n FROM site_lead`);
  console.log('leads capturados:', total.rows[0].n);
  await db.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
