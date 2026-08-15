/**
 * HORÁRIOS das últimas 14h: begin_checkout, add_payment_info, pedidos criados
 * e cobranças no gateway — pra separar "quebrou" de "ainda não compraram".
 *
 *   railway run --service Postgres node backend/scripts/diag-horas-checkout.js
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const fmt = (d) => d.toISOString().slice(5, 16).replace('T', ' ');

  console.log('── begin_checkout últimas 14h (hora SP) ──');
  const cq = await db.query(
    `SELECT session_id, MIN(criado_em) AT TIME ZONE 'America/Sao_Paulo' AS hora
       FROM site_eventos WHERE evento='begin_checkout' AND criado_em > NOW()-INTERVAL '14 hours'
      GROUP BY session_id ORDER BY hora`,
  );
  for (const r of cq.rows) console.log('  ', r.session_id?.slice(0, 8), fmt(r.hora));

  console.log('── add_payment_info ──');
  const ap = await db.query(
    `SELECT session_id, MAX(criado_em) AT TIME ZONE 'America/Sao_Paulo' AS hora
       FROM site_eventos WHERE evento='add_payment_info' AND criado_em > NOW()-INTERVAL '14 hours'
      GROUP BY session_id ORDER BY hora`,
  );
  for (const r of ap.rows) console.log('  ', r.session_id?.slice(0, 8), fmt(r.hora));

  console.log('── pedidos criados (source=ecommerce) ──');
  const o = await db.query(
    `SELECT wc_order_number, customer_name, status, total_amount,
            created_at AT TIME ZONE 'America/Sao_Paulo' AS h
       FROM orders WHERE source='ecommerce' AND created_at > NOW()-INTERVAL '14 hours'
      ORDER BY created_at`,
  );
  if (!o.rows.length) console.log('   (nenhum)');
  for (const r of o.rows) console.log('  ', r.wc_order_number, r.status, 'R$' + r.total_amount, fmt(r.h), r.customer_name);

  console.log('── cobranças pagarme ──');
  const pg = await db.query(
    `SELECT method, status, valor::float8 AS v, created_at AT TIME ZONE 'America/Sao_Paulo' AS h
       FROM pagarme_payments WHERE created_at > NOW()-INTERVAL '14 hours' ORDER BY created_at`,
  );
  if (!pg.rows.length) console.log('   (nenhuma)');
  for (const r of pg.rows) console.log('  ', r.method, r.status, 'R$' + r.v, fmt(r.h));

  await db.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
