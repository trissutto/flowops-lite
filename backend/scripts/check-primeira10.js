const { Client } = require('pg');
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const c = await db.query("SELECT code,tipo,valor,min_subtotal,ativo FROM site_cupons WHERE code='PRIMEIRA10'");
  console.log('PRIMEIRA10:', c.rows[0] ? JSON.stringify(c.rows[0]) : 'não está na tabela (usa fallback do front)');
  // quantos leads do popup vieram do vestido / da campanha hoje
  const v = await db.query(`SELECT origem, COUNT(*)::int n FROM site_lead WHERE created_at > NOW() - INTERVAL '2 days' GROUP BY origem ORDER BY n DESC LIMIT 8`);
  console.log('\n══ origem dos leads (48h) ══');
  for (const r of v.rows) console.log(`  ${r.n}  ${r.origem||'-'}`);
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
