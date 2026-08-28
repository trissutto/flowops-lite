/**
 * TEM × NÃO TEM (LP-000136, BMM-100 MANTEIGA 48, sku 5397594):
 * saldo cru por loja × peça extraviada × peça prometida a card aberto.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

const SKU = '5397594';

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log('── saldo cru (giga_estoque) por loja ──');
  const est = await db.query(
    `SELECT loja, SUM(estoque)::int saldo FROM giga_estoque
      WHERE ltrim(codigo,'0') = $1 GROUP BY loja ORDER BY loja`, [SKU],
  );
  console.table(est.rows);

  console.log('── peça extraviada (achada_em NULL) ──');
  const ext = await db.query(
    `SELECT store_code, sku, qty, motivo, marcada_em, order_id FROM pecas_extraviadas
      WHERE ltrim(sku,'0') = $1 AND achada_em IS NULL`, [SKU],
  );
  console.table(ext.rows);

  console.log('── peça PROMETIDA: itens deste SKU atribuídos a loja em pedido vivo ──');
  const prom = await db.query(
    `SELECT o.wc_order_number lp, o.status, oi.assigned_store_id, s.code loja, s.name,
            oi.quantity, oi.cancelled_at IS NOT NULL cancelada
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN stores s ON s.id = oi.assigned_store_id
      WHERE ltrim(oi.sku,'0') = $1
        AND o.status NOT IN ('delivered','cancelled','payment_failed','expired')
      ORDER BY o.wc_order_number`, [SKU],
  );
  console.table(prom.rows);

  console.log('── cards abertos que contêm o pedido LP-000136 ──');
  const cards = await db.query(
    `SELECT po.id, s.code loja, po.status, po.tracking_code
       FROM pick_orders po JOIN stores s ON s.id = po.store_id
       JOIN orders o ON o.id = po.order_id
      WHERE o.wc_order_number = 'LP-000136'`,
  );
  console.table(cards.rows);

  await db.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
