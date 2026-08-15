const { Client } = require('pg');
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const col = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='orders' AND column_name IN ('pix_resgate_avisado_em','rastreio_avisado_em')`);
  console.log('colunas novas:', col.rows.map((r) => r.column_name).join(', ') || 'NENHUMA (db push não rodou?)');
  const o = await db.query(`SELECT wc_order_number, status, pix_resgate_avisado_em, created_at FROM orders WHERE source='ecommerce' AND created_at > NOW() - INTERVAL '4 hours' ORDER BY created_at`);
  for (const r of o.rows) console.log(' ', r.wc_order_number, r.status, '| resgate:', r.pix_resgate_avisado_em ? r.pix_resgate_avisado_em.toISOString() : 'ainda não');
  await db.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
