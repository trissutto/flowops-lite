const { Client } = require('pg');
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const r = await db.query("SELECT code,tipo,valor,min_subtotal,ativo,fim_em,usos FROM site_cupons WHERE code='VESTIDO139'");
  const c = r.rows[0];
  const vencido = c && c.fim_em && new Date(c.fim_em) < new Date();
  console.log('VESTIDO139:', c ? `ativo=${c.ativo} · R$${c.valor} off · min R$${c.min_subtotal} · usos ${c.usos} · vence ${c.fim_em?.toISOString().slice(0,10)} · vencido? ${vencido}` : 'NÃO EXISTE');
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
