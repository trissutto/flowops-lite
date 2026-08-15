const { Client } = require('pg');
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const r = await db.query("SELECT ref, slug, nome FROM site_produto WHERE slug ILIKE '%vlm-222%' OR ref ILIKE '%vlm%222%' OR slug ILIKE '%vlm222%'");
  for (const x of r.rows) console.log(`ref="${x.ref}" slug="${x.slug}" nome="${x.nome}"`);
  if (!r.rows.length) console.log('nada com vlm-222');
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
