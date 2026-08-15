// Descobre onde estão as vendas com cliente+telefone e conta compradores de julho/2026.
const { Client } = require('pg');
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });
  await db.connect();

  // tabelas candidatas de venda
  const t = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public'
      AND (table_name ILIKE '%sale%' OR table_name ILIKE '%venda%' OR table_name ILIKE '%pdv%' OR table_name='orders')
     ORDER BY table_name`);
  console.log('tabelas de venda:', t.rows.map(r=>r.table_name).join(', '));

  // colunas da customers
  const cc = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='customers'`);
  console.log('\ncustomers cols:', cc.rows.map(r=>r.column_name).join(', '));

  // orders (ecommerce) de julho com telefone
  const oj = await db.query(
    `SELECT COUNT(*)::int n
       FROM orders
      WHERE (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') >= '2026-07-01'
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') < '2026-08-01'
        AND customer_phone IS NOT NULL`).catch(e=>({rows:[{n:'erro:'+e.message}]}));
  console.log('\norders ecommerce julho c/ telefone:', oj.rows[0].n);

  await db.end();
})().catch(e=>{console.error(e.message);process.exit(1)});
