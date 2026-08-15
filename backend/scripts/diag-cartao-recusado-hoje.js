/**
 * MOTIVO das recusas de cartão de hoje — lê o raw_webhook/status gravado.
 *   railway run --service Postgres node backend/scripts/diag-cartao-recusado-hoje.js
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const r = await db.query(
    `SELECT id, sale_id, status, valor::float8 AS v, raw_webhook, created_at
       FROM pagarme_payments
      WHERE created_at > NOW() - INTERVAL '8 hours' AND status IN ('failed','canceled')
      ORDER BY created_at`,
  );
  for (const x of r.rows) {
    console.log('════', x.created_at.toISOString(), 'R$' + x.v, 'sale=' + String(x.sale_id || '').slice(0, 8));
    if (!x.raw_webhook) { console.log('  (sem raw_webhook)'); continue; }
    const raw = typeof x.raw_webhook === 'string' ? JSON.parse(x.raw_webhook) : x.raw_webhook;
    // Mensagem de erro COMPLETA, onde quer que esteja
    const str = JSON.stringify(raw);
    const idx = str.indexOf('validation_error');
    console.log(' ', idx >= 0 ? str.slice(Math.max(0, idx - 80), idx + 500) : str.slice(0, 500));
  }

  // O que o pedido/venda dessas recusas virou
  const ids = r.rows.map((x) => x.sale_id).filter(Boolean);
  if (ids.length) {
    const o = await db.query(
      `SELECT id, wc_order_number, status, customer_name, total_amount FROM orders WHERE id = ANY($1)`,
      [ids],
    );
    console.log('\n══ pedidos dessas tentativas ══');
    for (const p of o.rows) console.log(' ', p.wc_order_number, p.status, 'R$' + p.total_amount, p.customer_name);
    if (!o.rows.length) console.log('  (nenhum Order com esses sale_ids — recusa não persistiu pedido)');
  }

  await db.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
