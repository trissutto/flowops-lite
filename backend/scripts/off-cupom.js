const { Client } = require('pg');
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const r = await db.query("UPDATE site_cupons SET ativo=false WHERE code='VESTIDO139' RETURNING code, ativo");
  console.log(r.rowCount ? `VESTIDO139 -> ativo=${r.rows[0].ativo}` : 'cupom nao encontrado');
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
