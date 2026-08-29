/**
 * FIX — PEÇA É PEÇA (29/08): explode linha de order_items com quantity N em
 * N linhas de quantity 1. Troca, cancelamento, rateio do split e bipe operam
 * POR LINHA — linha de quantidade 2+ quebrava esses fluxos (caso LP-001005).
 *
 * O código novo já cria por peça em todas as entradas (site WC, e-commerce
 * novo, pedido online do PDV); este script conserta os pedidos que nasceram
 * ANTES. Seguro: só toca linha não cancelada com quantity > 1, clona todos
 * os campos e mantém a soma idêntica. Bipes não são realocados (o teto por
 * SKU conta por SKU, não por linha — nada muda pra quem já bipou).
 *
 *   railway run --service Postgres node backend/scripts/fix-linha-multi-qtd.js [ORDENS...]
 *   (sem argumento: LP-001005 e LP-000986, os dois casos de 29/08)
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const ordens = process.argv.slice(2).length ? process.argv.slice(2) : ['LP-001005', 'LP-000986'];
  const alvos = (
    await db.query(
      `SELECT oi.id, o.wc_order_number, oi.sku, oi.quantity
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.wc_order_number = ANY($1)
          AND oi.cancelled_at IS NULL AND oi.quantity > 1`,
      [ordens],
    )
  ).rows;
  if (!alvos.length) {
    console.log('nada a explodir — nenhuma linha com quantity > 1 nesses pedidos');
  }
  for (const t of alvos) {
    await db.query('BEGIN');
    await db.query(`UPDATE order_items SET quantity = 1 WHERE id = $1`, [t.id]);
    for (let i = 1; i < t.quantity; i++) {
      await db.query(
        `INSERT INTO order_items (id, order_id, sku, product_name, ref, cor, tamanho,
                quantity, unit_price, base_unit_price, assigned_store_id)
         SELECT gen_random_uuid()::text, order_id, sku, product_name, ref, cor, tamanho,
                1, unit_price, base_unit_price, assigned_store_id
           FROM order_items WHERE id = $1`,
        [t.id],
      );
    }
    await db.query('COMMIT');
    console.log(`#${t.wc_order_number} sku ${t.sku}: 1 linha x${t.quantity} → ${t.quantity} linhas x1`);
  }

  const chk = (
    await db.query(
      `SELECT o.wc_order_number AS num, oi.sku, COUNT(*)::int AS linhas, SUM(oi.quantity)::int AS qtd
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.wc_order_number = ANY($1) AND oi.cancelled_at IS NULL
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [ordens],
    )
  ).rows;
  console.table(chk);
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
