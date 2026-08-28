/** LP-000983 (Karen Carvalho) é o atacante de volta? + atividade da última 1h. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const det = await db.query(
    `SELECT wc_order_number lp, status, customer_name nome, customer_email email,
            customer_cpf cpf, customer_phone fone, cliente_ip ip, total_amount total,
            paid_at, created_at, shipping_cep cep, shipping_address,
            CASE WHEN payment_info ~ '^\\s*\\{' THEN payment_info::jsonb->>'method' END metodo,
            CASE WHEN payment_info ~ '^\\s*\\{' THEN payment_info::jsonb#>>'{transacao,ultimos4}' END last4,
            CASE WHEN payment_info ~ '^\\s*\\{' THEN payment_info::jsonb#>>'{transacao,titular}' END titular,
            CASE WHEN payment_info ~ '^\\s*\\{' THEN payment_info::jsonb#>>'{transacao,antifraudeStatus}' END antifraude,
            CASE WHEN tracking_info ~ '^\\s*\\{' THEN tracking_info::jsonb->>'anonymous_id' END aparelho
       FROM orders WHERE wc_order_number IN ('LP-000983')`,
  );
  console.log(JSON.stringify(det.rows[0] || null, null, 1));

  console.log('── última 1h: pedidos ecommerce por status ──');
  const ult = await db.query(
    `SELECT status, COUNT(*)::int n FROM orders
      WHERE source='ecommerce' AND created_at > NOW() - INTERVAL '1 hour' GROUP BY 1`,
  );
  console.table(ult.rows);

  console.log('── última 1h: bloqueios do escudo ──');
  const blq = await db.query(
    `SELECT motivo, COUNT(*)::int n, MAX(criado_em) ultimo FROM checkout_bloqueios
      WHERE criado_em > NOW() - INTERVAL '1 hour' GROUP BY 1`,
  );
  console.table(blq.rows);

  console.log('── pedidos pagos da última 1h (todos) ──');
  const pagos = await db.query(
    `SELECT wc_order_number lp, customer_name nome, customer_email email, cliente_ip ip,
            total_amount total,
            CASE WHEN payment_info ~ '^\\s*\\{' THEN payment_info::jsonb->>'method' END metodo,
            CASE WHEN payment_info ~ '^\\s*\\{' THEN payment_info::jsonb#>>'{transacao,ultimos4}' END last4
       FROM orders
      WHERE source='ecommerce' AND paid_at > NOW() - INTERVAL '1 hour'
      ORDER BY paid_at DESC`,
  );
  console.table(pagos.rows);

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
