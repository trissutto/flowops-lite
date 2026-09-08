require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  // 1. LIVE: itens com preço suspeito (< R$ 5) por mês, antes/depois de 22/06
  const live = await db.query(`
    SELECT to_char(date_trunc('month', created_at),'YYYY-MM') mes,
           COUNT(*)::int itens,
           SUM(CASE WHEN price_cents > 0 AND price_cents < 500 THEN 1 ELSE 0 END)::int suspeitos_div100,
           MIN(price_cents)::int menor_preco_cents
      FROM live_pdv_items GROUP BY 1 ORDER BY 1`);
  console.log('== LIVE (live_pdv_items.price_cents) ==');
  console.table(live.rows);
  const liveEx = await db.query(`
    SELECT to_char(created_at,'YYYY-MM-DD') dia, ref_code, price_cents, status
      FROM live_pdv_items WHERE price_cents > 0 AND price_cents < 500
      ORDER BY created_at LIMIT 10`);
  console.log('exemplos suspeitos da live:'); console.table(liveEx.rows);
  // 2. TRANSFER_ORDERS: snapshot do bipe suspeito?
  const tr = await db.query(`
    SELECT to_char(date_trunc('month', created_at),'YYYY-MM') mes,
           COUNT(*)::int itens,
           SUM(CASE WHEN preco_unit_cents > 0 AND preco_unit_cents < 500 THEN 1 ELSE 0 END)::int suspeitos
      FROM transfer_orders WHERE preco_unit_cents IS NOT NULL GROUP BY 1 ORDER BY 1`);
  console.log('== TRANSFER_ORDERS (preco_unit_cents, snapshot do bipe) ==');
  console.table(tr.rows);
  // 3. PDV: alguma venda com item < R$ 5 (baseline de comparação)
  const pdv = await db.query(`
    SELECT to_char(date_trunc('month', s.finalized_at),'YYYY-MM') mes,
           SUM(CASE WHEN i.preco_unit > 0 AND i.preco_unit < 5 THEN 1 ELSE 0 END)::int itens_abaixo_5,
           COUNT(*)::int total
      FROM pdv_sale_items i JOIN pdv_sales s ON s.id = i.sale_id
     WHERE s.status='finalized' AND s.is_training=false
     GROUP BY 1 ORDER BY 1`);
  console.log('== PDV baseline (pdv_sale_items.preco_unit < R$5) ==');
  console.table(pdv.rows);
  await db.end();
}
main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
