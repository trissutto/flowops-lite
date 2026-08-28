/**
 * Parte 3: estado detalhado dos pedidos APROVADOS do ataque (pra saber se algo
 * já foi postado) + tamanho da sujeira no CRM (clientes fake criados).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log('── pedidos aprovados suspeitos ──');
  const det = await db.query(
    `SELECT wc_order_number lp, status, tracking_code, carrier, shipped_at, paid_at,
            customer_name nome, customer_email email, customer_phone fone,
            shipping_cep cep, total_amount total, cliente_ip ip,
            CASE WHEN payment_info ~ '^\\s*\\{' THEN payment_info::jsonb#>>'{transacao,ultimos4}' END last4,
            CASE WHEN payment_info ~ '^\\s*\\{' THEN payment_info::jsonb#>>'{transacao,titular}' END titular,
            CASE WHEN payment_info ~ '^\\s*\\{' THEN payment_info::jsonb#>>'{transacao,antifraudeStatus}' END antifraude,
            shipping_address
       FROM orders
      WHERE wc_order_number IN ('LP-000344','LP-000335','LP-000333','LP-000330','LP-000982')
      ORDER BY wc_order_number`,
  );
  for (const r of det.rows) {
    console.log(JSON.stringify(r, null, 1).slice(0, 1400));
    console.log('---');
  }

  console.log('── clientes do CRM criados na janela do ataque (28/08 19:30+) ──');
  const cli = await db.query(
    `SELECT COUNT(*)::int n FROM customers
      WHERE created_at > '2026-08-28 22:30:00Z'`,
  );
  console.table(cli.rows);

  console.log('── colunas da tabela customers (pra achar o filtro certo) ──');
  const cols = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='customers' ORDER BY ordinal_position`,
  );
  console.log(cols.rows.map((r) => r.column_name).join(', '));

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
