/** Nota 714 do pedido 960000214: quando autorizou (prazo de cancelamento 24h) + card. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const cols = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='nfe_docs' ORDER BY ordinal_position`,
  );
  console.log('colunas nfe_docs:', cols.rows.map((r) => r.column_name).join(', '));

  const nota = await db.query(
    `SELECT * FROM nfe_docs WHERE numero = 714 ORDER BY created_at DESC LIMIT 3`,
  ).catch(async () => db.query(`SELECT * FROM nfe_docs WHERE numero = '714' LIMIT 3`));
  for (const n of nota.rows) {
    const slim = Object.fromEntries(Object.entries(n).filter(([k]) =>
      !/xml|pdf|danfe|payload|raw/i.test(k)));
    console.log(JSON.stringify(slim, null, 1).slice(0, 1200));
  }

  const cards = await db.query(
    `SELECT po.id, s.code loja, po.status, po.tracking_code, po.correios_generated_at
       FROM pick_orders po JOIN stores s ON s.id = po.store_id
       JOIN orders o ON o.id = po.order_id
      WHERE o.wc_order_id = 960000214`,
  );
  console.table(cards.rows);

  await db.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
