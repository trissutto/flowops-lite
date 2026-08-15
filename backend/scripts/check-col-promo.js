const { Client } = require('pg');
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const r = await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='site_produto' AND column_name IN ('preco_promo','preco_de')");
  console.log('colunas de preco promo:', r.rows.map(x=>x.column_name).join(', ') || 'NENHUMA (deploy do PR ainda nao rodou)');
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
