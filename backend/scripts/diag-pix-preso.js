/**
 * PIX PRESO — pedido do site novo parado em awaiting_payment.
 *
 * A pergunta que este script responde: "a cliente pagou e a confirmação não
 * chegou, ou ela nunca pagou?" Olha o pedido, o pagamento gravado e o que o
 * gateway devolveu (o que estiver guardado no Flow) — sem chutar.
 *
 *   railway run --service Postgres node backend/scripts/diag-pix-preso.js
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const cols = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public' AND (table_name LIKE '%payment%' OR table_name LIKE '%pagamento%')
      ORDER BY table_name, ordinal_position`,
  );
  const tabelas = {};
  for (const c of cols.rows) (tabelas[c.table_name] ||= []).push(c.column_name);
  console.log('══════ TABELAS DE PAGAMENTO ══════');
  for (const [t, cs] of Object.entries(tabelas)) console.log(`  ${t}: ${cs.join(', ')}`);

  const oc = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='orders' ORDER BY ordinal_position`,
  );
  const nomes = oc.rows.map((r) => r.column_name);
  console.log(`\n══════ COLUNAS DE orders ══════\n  ${nomes.join(', ')}`);
  const pag = nomes.filter((n) => /pay|pag|pix|gateway|charge/i.test(n));
  console.log(`  → de pagamento: ${pag.join(', ') || '(nenhuma)'}`);

  console.log('\n══════ PEDIDOS DO SITE NOVO (30d) ══════');
  const pedidos = await db.query(
    `SELECT id, wc_order_number, customer_name, total_amount, status,
            ${pag.join(', ')}${pag.length ? ',' : ''}
            (created_at AT TIME ZONE 'America/Sao_Paulo') AS criado
       FROM orders
      WHERE source = 'ecommerce' AND created_at > NOW() - INTERVAL '30 days'
      ORDER BY created_at`,
  );
  for (const p of pedidos.rows) {
    const extra = pag.map((c) => `${c}=${p[c] ?? '—'}`).join(' ');
    console.log(
      `  ${p.wc_order_number} | ${String(p.status).padEnd(16)} | R$ ${String(p.total_amount).padStart(8)} | ${p.criado.toISOString().slice(0, 16).replace('T', ' ')} | ${p.customer_name}`,
    );
    console.log(`     ${extra}`);
  }

  console.log('\n══════ COBRANÇAS PIX NOS GATEWAYS (7d) ══════');
  for (const t of ['pagbank_payments', 'pagarme_payments']) {
    const r = await db.query(
      `SELECT id, sale_id, method, valor, status, paid_at, created_at
         FROM ${t} WHERE created_at > NOW() - INTERVAL '7 days' ORDER BY created_at`,
    );
    console.log(`  ${t}: ${r.rows.length} cobranças`);
    for (const c of r.rows) {
      console.log(
        `     ${String(c.method).padEnd(5)} R$ ${String(c.valor).padStart(8)} | ${String(c.status).padEnd(12)} | pago: ${c.paid_at ? c.paid_at.toISOString().slice(0, 16) : 'NÃO'} | sale=${c.sale_id ?? '—'}`,
      );
    }
  }

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
