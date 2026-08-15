const { Client } = require('pg');
(async () => {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const r = await db.query(`SELECT status, COUNT(*) n FROM orders WHERE created_at > NOW() - INTERVAL '3 days' GROUP BY status ORDER BY n DESC`);
  console.log('status dos pedidos (3d):'); r.rows.forEach(x => console.log('  ', String(x.status).padEnd(20), x.n));
  const f = await db.query(`SELECT numero_pedido, status, metodo_pagamento, total, created_at FROM orders WHERE created_at > NOW() - INTERVAL '3 days' AND status <> 'paid' ORDER BY created_at DESC LIMIT 25`).catch(async () => {
    const c = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='orders'`);
    console.log('\n(colunas reais):', c.rows.map(r => r.column_name).join(', '));
    return { rows: [] };
  });
  if (f.rows.length) { console.log('\nnão-pagos (3d):'); f.rows.forEach(x => console.log('  ', JSON.stringify(x))); }
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
